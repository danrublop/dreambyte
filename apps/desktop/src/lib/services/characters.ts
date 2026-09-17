// Character bundles — create a reusable character identity and re-render it
// consistently across scenes. Consistency comes from three levers applied together:
//   1. a pinned RNG seed (deterministic backbone),
//   2. an i2i reference image (visual conditioning on the established look), and
//   3. a style/appearance descriptor folded into every prompt.
//
// The pure `buildCharacterGenerationParams` seam is what the pipeline test asserts on
// (refs + seed applied) — no network, no perceptual oracle.

import { db } from '@/lib/db'
import { projectAssets } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  createCharacter as insertCharacter,
  resolveCharacter,
  adoptReferenceIfEmpty,
  type CharacterRow,
} from '@/lib/db/queries/characters'
import type { MediaPermissionNeeded } from './media-gate'

export class CharacterError extends Error {}

export interface CharacterGenerationParams {
  prompt: string
  model: string
  referenceImageUrl: string | null
  strength: number | undefined
  seed: number | null
  negativePrompt?: string
}

/**
 * Pure: fold a character's identity (descriptor + seed + model + strength) into a single
 * generateImage call's parameters. The reference URL is resolved by the caller (DB touch)
 * and passed in already-resolved so this stays unit-testable. The descriptor leads the
 * prompt as an identity anchor; the scene prompt follows as the action/pose.
 */
export function buildCharacterGenerationParams(
  character: Pick<CharacterRow, 'description' | 'seed' | 'model' | 'strength'>,
  opts: { prompt: string; referenceImageUrl: string | null; negativePrompt?: string; fallbackModel: string },
): CharacterGenerationParams {
  const scenePrompt = opts.prompt.trim()
  const descriptor = (character.description ?? '').trim()
  const prompt = descriptor ? (scenePrompt ? `${descriptor}. ${scenePrompt}` : descriptor) : scenePrompt
  return {
    prompt,
    model: character.model ?? opts.fallbackModel,
    referenceImageUrl: opts.referenceImageUrl,
    strength: character.strength ?? undefined,
    seed: character.seed,
    negativePrompt: opts.negativePrompt,
  }
}

/** Resolve a character's primary reference asset to a fetchable publicUrl (or null).
 *  Exported so the avatar service can use a Cast character's face as the avatar source image
 *  (Tier 3 Cast — characters are the identity model; see src/lib/services/avatar.ts). */
export async function primaryReferenceUrl(character: CharacterRow): Promise<string | null> {
  const primaryId = character.referenceAssetIds[0]
  if (!primaryId) return null
  const [ref] = await db
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, primaryId), eq(projectAssets.projectId, character.projectId)))
    .limit(1)
  return ref?.publicUrl ?? null
}

export interface CreateCharacterInput {
  projectId: string
  name: string
  description?: string | null
  /** Pin a seed for reproducibility; omitted → a random seed is assigned and stored. */
  seed?: number | null
  /** i2i model to use on reuse; omitted → router picks at reuse time. */
  model?: string | null
  strength?: number | null
  /** Seed the bundle from an existing project asset instead of generating a new portrait. */
  referenceAssetId?: string | null
  /** When no referenceAssetId is given, generate a first portrait from this prompt. */
  prompt?: string | null
  aspectRatio?: string
  /** Provider enabled-map (world.mediaGenEnabled) so the portrait honours Settings toggles. */
  mediaGenEnabled?: Record<string, boolean> | null
}

export interface CreateCharacterResult {
  character: CharacterRow
  cost: number
}

/**
 * Create a character bundle. Either adopt an existing asset as the reference, or generate a
 * first portrait (t2i) with a pinned seed and adopt that. The pinned seed + generated/adopted
 * reference are what later `reuseCharacter` calls condition on.
 */
export async function createCharacter(input: CreateCharacterInput): Promise<CreateCharacterResult> {
  const name = String(input.name ?? '').trim()
  if (!input.projectId) throw new CharacterError('projectId is required')
  if (!name) throw new CharacterError('Character name is required')

  // Reject a duplicate name BEFORE generating the (paid) portrait — otherwise we'd bill the
  // user, then the unique index would reject the insert, wasting the spend. Names are the
  // handle the agent reuses by, so collisions would also make reuse_character ambiguous.
  const existing = await resolveCharacter(input.projectId, name)
  if (existing) throw new CharacterError(`A character named "${name}" already exists in this project`)

  // A stable seed is the backbone of consistency — always pin one. 31-bit keeps it inside
  // the safe positive-int range every backend accepts. (App runtime: Math.random is fine.)
  const seed = input.seed ?? Math.floor(Math.random() * 0x7fffffff)

  let referenceAssetIds: string[] = []
  let cost = 0

  if (input.referenceAssetId) {
    const [ref] = await db
      .select()
      .from(projectAssets)
      .where(and(eq(projectAssets.id, input.referenceAssetId), eq(projectAssets.projectId, input.projectId)))
      .limit(1)
    if (!ref) throw new CharacterError('Reference asset not found')
    referenceAssetIds = [ref.id]
  } else if (input.prompt && input.prompt.trim()) {
    // Generate the first portrait. Descriptor + prompt both inform the look; the seed pins it.
    const descriptor = (input.description ?? '').trim()
    const portraitPrompt = descriptor ? `${descriptor}. ${input.prompt.trim()}` : input.prompt.trim()
    const { generateImage } = await import('@/lib/apis/image-gen')
    const { persistGeneratedAsset } = await import('@/lib/media/provenance')
    const { logSpend } = await import('@/lib/db')
    const { routeMediaIntent } = await import('@/lib/media/router')
    // The portrait is text-to-image. Route it (honouring provider toggles) rather than firing
    // input.model raw — input.model is documented as the i2i model for REUSE and may not be a
    // valid t2i target, and a disabled provider must not be selected. preferModel keeps the
    // user's pick when it's t2i-eligible, else the router upgrades to a runnable one.
    const route = routeMediaIntent({
      enabledMap: input.mediaGenEnabled ?? null,
      intent: 't2i',
      preferModel: input.model ?? undefined,
    })
    if (route.providerId == null) throw new CharacterError(`Image generation unavailable: ${route.reason}`)
    const model = route.modelId
    const aspectRatio = input.aspectRatio ?? '1:1'
    const result = await generateImage({ prompt: portraitPrompt, model, aspectRatio, style: null, seed })
    cost = result.cost
    if (cost > 0) {
      await logSpend(input.projectId, 'imageGen', cost, `character "${name}": ${input.prompt.trim().slice(0, 80)}`)
    }
    const persisted = await persistGeneratedAsset({
      projectId: input.projectId,
      sourceUrl: result.imageUrl,
      type: 'image',
      name: `${name} (reference)`,
      width: result.width,
      height: result.height,
      metadata: {
        prompt: portraitPrompt,
        provider: 'imageGen',
        model,
        costCents: Math.round((cost ?? 0) * 100),
        parentAssetId: null,
        referenceAssetIds: null,
        enhanceTags: null,
      },
    })
    referenceAssetIds = [persisted.id]
  }

  const character = await insertCharacter({
    projectId: input.projectId,
    name,
    description: input.description ?? null,
    referenceAssetIds,
    seed,
    model: input.model ?? null,
    strength: input.strength ?? null,
  })
  return { character, cost }
}

export interface ReuseCharacterInput {
  projectId: string
  /** Character id or (case-insensitive) name. */
  character: string
  /** The new scene/pose/action prompt. */
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  /**
   * Provider enabled-map (world.mediaGenEnabled). Threaded into routing so the service honours
   * the user's Settings toggles instead of treating every provider as enabled — must match the
   * route the caller gated/quoted. null = trust key presence only (server-side default).
   */
  mediaGenEnabled?: Record<string, boolean> | null
  /**
   * Skip reuseCharacter's OWN project-row spend gate. The agent tool handler already runs the
   * world-based checkApiPermission + enrichPermission UX before calling, so it sets this true to
   * avoid double-gating. The renderer IPC NEVER sets it, so in-app character reuse is gated by
   * project policy + spend caps. Mirrors StartVideoInput / GenerateImageInput. Default false.
   */
  skipPermissionGate?: boolean
  /** Re-dispatch flag set after the user approves the always-ask modal — proceed past the prompt
   *  (never past a 'deny'). Mirrors StartVideoInput / GenerateImageInput. */
  approvedAsk?: boolean
}

export interface ReuseCharacterResult {
  asset: typeof projectAssets.$inferSelect
  cost: number
  finalPrompt: string
  characterId: string
}

/**
 * Re-render an established character in a new prompt, conditioning on its reference (i2i) and
 * pinned seed so the same subject re-appears. Routes to an i2i-capable model (keeps the
 * character's model if it supports i2i, else upgrades) — never silently degrades to t2i when
 * a reference exists.
 */
export async function reuseCharacter(
  input: ReuseCharacterInput,
): Promise<ReuseCharacterResult | { permissionNeeded: MediaPermissionNeeded }> {
  if (!input.projectId) throw new CharacterError('projectId is required')
  const rawPrompt = String(input.prompt ?? '').trim()
  if (!rawPrompt) throw new CharacterError('Prompt is required')

  const character = await resolveCharacter(input.projectId, input.character)
  if (!character) throw new CharacterError(`Character not found: ${input.character}`)

  const referenceImageUrl = await primaryReferenceUrl(character)

  // A character that HAS a stored reference but can't resolve it (asset deleted) must NOT
  // silently render an unconditioned t2i face at full cost — that defeats the consistency
  // promise. Fail loudly so the caller can re-establish a reference. A name-only character
  // (no refs yet) legitimately renders t2i below and adopts the result.
  if (character.referenceAssetIds.length > 0 && !referenceImageUrl) {
    throw new CharacterError(
      `Character "${character.name}" references an asset that no longer exists — re-create the reference before reusing.`,
    )
  }

  // Pick the i2i model. When the character has a reference we MUST land on an i2i-capable
  // model; the router keeps the character's preferred model if eligible, else upgrades, and
  // throws if i2i is unavailable (no silent t2i). Honour the caller's
  // provider toggles (enabledMap) so the service can't route to a provider the user disabled.
  const { routeMediaIntent } = await import('@/lib/media/router')
  // Route both paths through the same enabled-map so a disabled provider is never selected and
  // the model matches what the caller gated. i2i when we have a reference, t2i for a name-only
  // first render (which then adopts its result as the reference below).
  const route = routeMediaIntent({
    enabledMap: input.mediaGenEnabled ?? null,
    intent: referenceImageUrl ? 'i2i' : 't2i',
    preferModel: character.model ?? undefined,
    referenceImageUrl: referenceImageUrl ?? undefined,
  })
  if (route.providerId == null) {
    throw new CharacterError(
      `${referenceImageUrl ? 'Image-to-image' : 'Image generation'} unavailable: ${route.reason}`,
    )
  }
  const model = route.modelId

  const params = buildCharacterGenerationParams(character, {
    prompt: rawPrompt,
    referenceImageUrl,
    negativePrompt: input.negativePrompt,
    fallbackModel: model,
  })
  // The route above is authoritative for the model when a reference is present.
  params.model = model

  // Spend gate (shared gateMediaSpend) — runs BEFORE the paid generateImage call. The renderer
  // IPC never sets skipPermissionGate, so in-app character reuse is gated by project policy +
  // caps. The agent tool handler pre-gates (checkApiPermission + enrichPermission) and sets
  // skipPermissionGate:true to avoid double-gating. A 'deny' (cap/disabled) throws — no spend.
  // An 'ask' returns permissionNeeded so the renderer pops the always-ask modal, then re-dispatches
  // with approvedAsk:true (which satisfies the prompt but can never bypass a 'deny').
  if (!input.skipPermissionGate) {
    const { gateMediaSpend } = await import('./media-gate')
    const g = await gateMediaSpend(
      input.projectId,
      'imageGen',
      { model: params.model, prompt: params.prompt },
      { surfaceAsk: true, approvedAsk: input.approvedAsk },
    )
    if (g && 'denied' in g) throw new CharacterError(g.reason)
    if (g && 'ask' in g) return { permissionNeeded: g.permissionNeeded }
  }

  const { generateImage } = await import('@/lib/apis/image-gen')
  const { persistGeneratedAsset } = await import('@/lib/media/provenance')
  const { logSpend } = await import('@/lib/db')

  const result = await generateImage({
    prompt: params.prompt,
    model: params.model,
    aspectRatio: input.aspectRatio ?? '1:1',
    style: null,
    referenceImageUrl: params.referenceImageUrl,
    strength: params.strength,
    seed: params.seed,
    negativePrompt: params.negativePrompt,
  })
  if (result.cost > 0) {
    await logSpend(input.projectId, 'imageGen', result.cost, `character "${character.name}": ${rawPrompt.slice(0, 80)}`)
  }

  const persisted = await persistGeneratedAsset({
    projectId: input.projectId,
    sourceUrl: result.imageUrl,
    type: 'image',
    name: `${character.name}: ${rawPrompt.slice(0, 40)}`,
    width: result.width,
    height: result.height,
    metadata: {
      prompt: params.prompt,
      provider: 'imageGen',
      model: params.model,
      costCents: Math.round((result.cost ?? 0) * 100),
      // Trace the new render back to the character's reference set for provenance/regen.
      parentAssetId: character.referenceAssetIds[0] ?? null,
      referenceAssetIds: character.referenceAssetIds.length ? character.referenceAssetIds : null,
      enhanceTags: null,
    },
  })

  // Name-only character: adopt this first render as the reference so subsequent reuses
  // condition on a consistent image. Conditional (only-if-still-empty) so two concurrent
  // first-renders don't clobber each other's adoption — last-writer-wins would leave the
  // bundle pointing at whichever render finished last. (Dangling refs already threw above.)
  if (!character.referenceAssetIds.length) {
    await adoptReferenceIfEmpty(input.projectId, character.id, persisted.id)
  }

  const [row] = await db.select().from(projectAssets).where(eq(projectAssets.id, persisted.id)).limit(1)
  return { asset: row, cost: result.cost, finalPrompt: params.prompt, characterId: character.id }
}
