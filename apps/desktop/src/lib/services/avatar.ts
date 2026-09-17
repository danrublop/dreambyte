/**
 * Avatar generation service.
 * Handles config resolution, TTS fallback, record creation, and
 * AvatarService dispatch. Called by the agent tool handlers
 * (avatar-tools.ts) and Electron IPC.
 */

import { db } from '@/lib/db'
import { avatarConfigs, avatarVideos, scenes } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { AvatarService } from '@/lib/avatar'
import { REMOVED_LOCAL_AVATAR_MESSAGE, REMOVED_LOCAL_AVATAR_PROVIDER } from '@/lib/avatar/removed-local-avatar'
import { getBestTTSProvider, getTTSProvider } from '@/lib/audio/router'
import { resolveReferenceToFetchableUrl } from '@/lib/media/reference-upload'
import { resolveCharacter, type CharacterRow } from '@/lib/db/queries/characters'
import { getClonedVoice } from '@/lib/db/queries/cloned-voices'
import { primaryReferenceUrl } from '@/lib/services/characters'
import type { TTSProvider } from '@/lib/types'

export class AvatarValidationError extends Error {
  readonly code = 'VALIDATION' as const
  constructor(message: string) {
    super(message)
    this.name = 'AvatarValidationError'
  }
}

export interface GenerateAvatarInput {
  text: string
  sceneId?: string | null
  avatarConfigId?: string | null
  audioUrl?: string | null
  sourceImageUrl?: string | null
  /** Tier 3 Cast: a `characters` id or name. Its primary reference image becomes the avatar
   *  face (resolved + trust-guarded below), so a saved identity drives the talking head. */
  characterId?: string | null
}

/** Does this provider send a source image to an external engine (so it must be trust-guarded
 *  + uploaded)? heygen doesn't (requiresImage: false). Safe-defaults to false for an
 *  unknown provider id rather than throwing. */
function providerRequiresImage(providerId: string): boolean {
  try {
    return AvatarService.getProvider(providerId).requiresImage
  } catch {
    return false
  }
}

/**
 * Resolve the face image for an avatar generation and run it through the shared trust guard.
 *
 *   input.sourceImageUrl  →  Cast character's primary reference  →  config.config.sourceImageUrl
 *
 * The chosen source is passed through `resolveReferenceToFetchableUrl({ kind: 'image' })`
 * (SSRF blocklist, size cap, mime check; local/data refs uploaded to fal storage) BEFORE it
 * reaches a provider. This is the single guarded chokepoint for EVERY avatar generation — the
 * agent tool, the Electron IPC create path, and the UI all generate through `generateAvatar`,
 * so guarding here (not only in a create tool) closes the gap a per-tool guard would leave.
 *
 * Returns the guarded, fetchable URL or null when there is no source. Throws
 * AvatarValidationError on a rejected image, or on a Cast character whose reference can't be
 * resolved (deleted asset) — never silently drops to an unconditioned face.
 */
export async function resolveGuardedFace(
  projectId: string,
  input: GenerateAvatarInput,
  config: typeof avatarConfigs.$inferSelect,
): Promise<string | null> {
  const requiresImage = providerRequiresImage(config.provider)

  let rawSource: string | null = input.sourceImageUrl ?? null

  if (!rawSource && input.characterId) {
    let character: CharacterRow | null
    try {
      character = await resolveCharacter(projectId, input.characterId)
    } catch (e) {
      throw new AvatarValidationError(`Could not resolve Cast member: ${(e as Error).message}`)
    }
    if (!character) throw new AvatarValidationError(`Cast member not found: ${input.characterId}`)
    const url = await primaryReferenceUrl(character)
    // A character WITH a stored reference that no longer resolves (asset deleted) must fail
    // loudly when the provider needs a face — mirrors reuseCharacter's discipline.
    if (!url && character.referenceAssetIds.length > 0) {
      throw new AvatarValidationError(
        `Cast member "${character.name}" references an image that no longer exists — re-attach a face before using it as an avatar.`,
      )
    }
    rawSource = url
  }

  if (!rawSource) {
    rawSource = (config.config as { sourceImageUrl?: string } | null)?.sourceImageUrl ?? null
  }

  if (!rawSource) return null
  if (!requiresImage) return rawSource

  try {
    return await resolveReferenceToFetchableUrl(rawSource, undefined, { kind: 'image' })
  } catch (e) {
    throw new AvatarValidationError(`Avatar face image rejected: ${(e as Error).message}`)
  }
}

/**
 * Resolve the cloned voice a Cast member should speak in: characterId → characters.voiceId →
 * cloned_voices row → { provider, providerVoiceId }. Returns null when no character/voice is bound,
 * or — gracefully — when the bound voice row no longer exists (dangling voiceId): the avatar still
 * generates with the default TTS voice rather than failing. The face guard is the hard requirement;
 * a missing voice is a soft degrade.
 */
export async function resolveAvatarVoice(
  projectId: string,
  input: GenerateAvatarInput,
): Promise<{ provider: TTSProvider; voiceId: string } | null> {
  if (!input.characterId) return null
  const character = await resolveCharacter(projectId, input.characterId)
  if (!character?.voiceId) return null
  const voice = await getClonedVoice(projectId, character.voiceId)
  if (!voice) return null // dangling binding — degrade to default voice, don't throw
  const provider = voice.provider as TTSProvider
  // If the bound voice's provider is no longer configured (its required API key is absent) or
  // unknown, degrade to the default voice instead of forcing an unconfigured provider that throws
  // an opaque auth error mid-generation. The voiceId only makes sense to its own provider anyway.
  try {
    const impl = await getTTSProvider(provider)
    if (impl.requiresKey && !process.env[impl.requiresKey]) return null
  } catch {
    return null
  }
  return { provider, voiceId: voice.providerVoiceId }
}

export type GenerateAvatarResult = typeof avatarVideos.$inferSelect

/**
 * Resolve the avatar config that `generateAvatar` would use, by the same
 * precedence: explicit ID → scene's config → project default (isDefault).
 * Returns null if none is configured.
 *
 * Exported so the agent tool handlers can gate on the EFFECTIVE provider before
 * spending. Previously the handlers gated on `world.generationOverrides` (a
 * per-run UI override that is usually empty), while generateAvatar generated
 * with this resolved config's provider — so a paid project-default avatar
 * (heygen/musetalk/fabric/aurora) could spend with no permission prompt. One
 * resolver = gate and generation can't drift.
 */
export async function resolveAvatarConfig(
  projectId: string,
  input: { avatarConfigId?: string | null; sceneId?: string | null },
): Promise<typeof avatarConfigs.$inferSelect | null> {
  let config: typeof avatarConfigs.$inferSelect | null = null

  if (input.avatarConfigId) {
    const [found] = await db
      .select()
      .from(avatarConfigs)
      .where(and(eq(avatarConfigs.id, input.avatarConfigId), eq(avatarConfigs.projectId, projectId)))
    config = found ?? null
  }

  if (!config && input.sceneId) {
    const [scene] = await db.select().from(scenes).where(eq(scenes.id, input.sceneId))
    if (scene?.avatarConfigId) {
      const [found] = await db.select().from(avatarConfigs).where(eq(avatarConfigs.id, scene.avatarConfigId))
      config = found ?? null
    }
  }

  if (!config) {
    const [found] = await db
      .select()
      .from(avatarConfigs)
      .where(and(eq(avatarConfigs.projectId, projectId), eq(avatarConfigs.isDefault, true)))
    config = found ?? null
  }

  return config
}

/**
 * Resolved inputs every avatar generation shares: the effective config, the
 * trust-guarded face source, the (optional) bound Cast voice, the TTS audio
 * (already produced for non-heygen providers; heygen does its own TTS so this
 * stays undefined for it), and the word-count duration estimate.
 *
 * Extracted from `generateAvatar` so the blocking path AND the async heygen path
 * (`startAvatarGeneration`) run the SAME resolution + the single `resolveGuardedFace`
 * trust chokepoint, with no duplication and no way for one path to skip the guard.
 */
interface ResolvedAvatarGeneration {
  config: typeof avatarConfigs.$inferSelect
  guardedFace: string | null
  boundVoice: { provider: TTSProvider; voiceId: string } | null
  resolvedAudioUrl: string | null | undefined
  estimatedDuration: number
}

async function resolveAvatarGeneration(
  projectId: string,
  input: GenerateAvatarInput,
): Promise<ResolvedAvatarGeneration> {
  if (!input.text) throw new AvatarValidationError('text is required')

  // 1. Resolve avatar config: explicit ID → scene's config → project default
  const config = await resolveAvatarConfig(projectId, input)

  if (!config) {
    throw new AvatarValidationError('No avatar config found. Configure one in project settings.')
  }
  if (config.provider === REMOVED_LOCAL_AVATAR_PROVIDER) {
    throw new AvatarValidationError(`${REMOVED_LOCAL_AVATAR_MESSAGE}. Choose a different avatar provider in settings.`)
  }

  // 1b. Resolve the face source (explicit → Cast character → config) and run it through the
  // shared trust guard before any provider sees it. One guarded value flows into the DB record
  // and both AvatarService.generate calls, so the provider never receives an unguarded source.
  const guardedFace = await resolveGuardedFace(projectId, input, config)

  // 1c. Resolve the Cast member's bound cloned voice (characterId → characters.voiceId →
  // cloned_voices). When present, TTS speaks in that voice via its own provider; otherwise we fall
  // back to the best available provider + default voice. Fixes the prior bug where generateAvatar
  // always called TTS with voiceId:undefined, so a Cast member's voice was never used.
  const boundVoice = await resolveAvatarVoice(projectId, input)

  // 2. Generate TTS audio if not provided. HeyGen handles its own TTS; skip.
  // Client-only TTS providers (web-speech/puter) can't produce a file, so
  // refuse them here — the agent or UI must pick a server provider.
  let resolvedAudioUrl = input.audioUrl
  if (!resolvedAudioUrl && config.provider !== 'heygen') {
    const ttsProvider = boundVoice?.provider ?? getBestTTSProvider()
    if (ttsProvider === 'web-speech' || ttsProvider === 'puter') {
      throw new AvatarValidationError(
        'Avatar generation requires a server-side TTS provider (ElevenLabs, OpenAI, Gemini, or Google). Configure one in audio settings.',
      )
    }
    // Gate paid TTS spend (cap/disabled). The agent gates the AVATAR provider, but an avatar
    // bound to a paid cloned voice (e.g. ElevenLabs) would otherwise run TTS uncapped.
    // ttsApiNameFor returns null for free/local providers (web-speech/puter/voxcpm), so only paid
    // providers are gated. surfaceAsk:false → deny (cap/disabled) throws; an 'ask' policy passes
    // through (the avatar call itself was already gated upstream), keeping generateAvatar's return type.
    const { ttsApiNameFor } = await import('@/lib/audio/audio-models')
    const ttsApi = ttsApiNameFor(ttsProvider)
    if (ttsApi) {
      const { gateMediaSpend } = await import('./media-gate')
      const gate = await gateMediaSpend(
        projectId,
        ttsApi,
        { model: ttsProvider, prompt: input.text },
        { surfaceAsk: false },
      )
      if (gate && 'denied' in gate) {
        throw new AvatarValidationError(`Avatar narration blocked: ${gate.reason}`)
      }
    }
    try {
      const impl = await getTTSProvider(ttsProvider)
      const ttsResult = await impl.generate({
        text: input.text,
        sceneId: input.sceneId ?? 'avatar-gen',
        voiceId: boundVoice?.voiceId,
      })
      resolvedAudioUrl = ttsResult.audioUrl
    } catch (e) {
      throw new Error(`TTS generation failed: ${(e as Error).message}`, { cause: e })
    }
  }

  const wordCount = input.text.split(/\s+/).length
  const estimatedDuration = Math.ceil((wordCount / 150) * 60)

  return { config, guardedFace, boundVoice, resolvedAudioUrl, estimatedDuration }
}

/**
 * Async, non-blocking avatar generation for the agent path.
 *
 * Reuses the SAME resolution + trust guard as `generateAvatar` (via
 * `resolveAvatarGeneration` → `resolveGuardedFace`, the single guarded chokepoint).
 * For HeyGen it SUBMITS the job and returns immediately with a `heygenVideoId` the
 * caller polls via `get_avatar_status` / `pollHeygenStatus` — so a 1-3 minute HeyGen
 * render never blocks the chat. The `avatarVideos` row is left `status:'generating'`.
 *
 * Every other provider (musetalk/fabric/aurora) has no submit/poll split,
 * so this delegates to the blocking `generateAvatar` and returns the ready row. Their
 * behavior is unchanged.
 */
export async function startAvatarGeneration(
  projectId: string,
  input: GenerateAvatarInput,
): Promise<
  | { async: true; provider: 'heygen'; heygenVideoId: string; avatarVideoId: string; estimatedSeconds: number }
  | { async: false; video: GenerateAvatarResult }
> {
  const resolved = await resolveAvatarGeneration(projectId, input)
  const { config, guardedFace } = resolved

  // Only HeyGen has a submit-then-poll path. Everything else stays blocking
  // (no estimable async API), so delegate to generateAvatar unchanged.
  if (config.provider !== 'heygen') {
    const video = await generateAvatar(projectId, input)
    return { async: false, video }
  }

  // HeyGen: avatarId + voiceId live on the config; it does its own TTS (no separate
  // audio step). Submit via startHeygenAvatar, which logs the estimated spend, then
  // record a `generating` row carrying the heygen videoId for later polling.
  const cfg = (config.config as { avatarId?: string; voiceId?: string; bgColor?: string } | null) ?? {}
  if (!cfg.avatarId || !cfg.voiceId) {
    throw new AvatarValidationError('HeyGen avatar config requires avatarId and voiceId.')
  }

  const { startHeygenAvatar } = await import('./generation')
  const { videoId, estimatedSeconds } = await startHeygenAvatar({
    projectId,
    sceneId: input.sceneId ?? undefined,
    avatarId: cfg.avatarId,
    voiceId: cfg.voiceId,
    script: input.text,
    bgColor: cfg.bgColor ?? '#00FF00',
  })

  // The heygen videoId is the poll handle; it lives on the placed avatar LAYER
  // (aiLayers[].heygenVideoId), where get_avatar_status reads it. The avatarVideos
  // row ALSO carries it now (heygenVideoId) so the server poll can correlate a poll
  // back to this row to enforce the deadline and mark completion (v4 #8). deadlineAt
  // bounds a wedged render: pollHeygenStatus times it out on the next poll, by any
  // caller, even with no editor window open.
  const { avatarDeadlineFor } = await import('./avatar-job-deadline')
  const [videoRecord] = await db
    .insert(avatarVideos)
    .values({
      projectId,
      sceneId: input.sceneId ?? null,
      avatarConfigId: config.id,
      provider: 'heygen',
      status: 'generating',
      text: input.text,
      audioUrl: null,
      sourceImageUrl: guardedFace,
      durationSeconds: estimatedSeconds,
      heygenVideoId: videoId,
      deadlineAt: new Date(avatarDeadlineFor(Date.now())),
    })
    .returning()

  return {
    async: true,
    provider: 'heygen',
    heygenVideoId: videoId,
    avatarVideoId: videoRecord.id,
    estimatedSeconds,
  }
}

export async function generateAvatar(projectId: string, input: GenerateAvatarInput): Promise<GenerateAvatarResult> {
  if (!input.text) throw new AvatarValidationError('text is required')

  // 1. Resolve avatar config: explicit ID → scene's config → project default
  const config = await resolveAvatarConfig(projectId, input)

  if (!config) {
    throw new AvatarValidationError('No avatar config found. Configure one in project settings.')
  }
  if (config.provider === REMOVED_LOCAL_AVATAR_PROVIDER) {
    throw new AvatarValidationError(`${REMOVED_LOCAL_AVATAR_MESSAGE}. Choose a different avatar provider in settings.`)
  }

  // 1b. Resolve the face source (explicit → Cast character → config) and run it through the
  // shared trust guard before any provider sees it. One guarded value flows into the DB record
  // and both AvatarService.generate calls, so the provider never receives an unguarded source.
  const guardedFace = await resolveGuardedFace(projectId, input, config)

  // 1c. Resolve the Cast member's bound cloned voice (characterId → characters.voiceId →
  // cloned_voices). When present, TTS speaks in that voice via its own provider; otherwise we fall
  // back to the best available provider + default voice. Fixes the prior bug where generateAvatar
  // always called TTS with voiceId:undefined, so a Cast member's voice was never used.
  const boundVoice = await resolveAvatarVoice(projectId, input)

  // 2. Generate TTS audio if not provided. HeyGen handles its own TTS; skip.
  // Client-only TTS providers (web-speech/puter) can't produce a file, so
  // refuse them here — the agent or UI must pick a server provider.
  let resolvedAudioUrl = input.audioUrl
  if (!resolvedAudioUrl && config.provider !== 'heygen') {
    const ttsProvider = boundVoice?.provider ?? getBestTTSProvider()
    if (ttsProvider === 'web-speech' || ttsProvider === 'puter') {
      throw new AvatarValidationError(
        'Avatar generation requires a server-side TTS provider (ElevenLabs, OpenAI, Gemini, or Google). Configure one in audio settings.',
      )
    }
    // Gate paid TTS spend (cap/disabled). The agent gates the AVATAR provider, but an avatar
    // bound to a paid cloned voice (e.g. ElevenLabs) would otherwise run TTS uncapped.
    // ttsApiNameFor returns null for free/local providers (web-speech/puter/voxcpm), so only paid
    // providers are gated. surfaceAsk:false → deny (cap/disabled) throws; an 'ask' policy passes
    // through (the avatar call itself was already gated upstream), keeping generateAvatar's return type.
    const { ttsApiNameFor } = await import('@/lib/audio/audio-models')
    const ttsApi = ttsApiNameFor(ttsProvider)
    if (ttsApi) {
      const { gateMediaSpend } = await import('./media-gate')
      const gate = await gateMediaSpend(
        projectId,
        ttsApi,
        { model: ttsProvider, prompt: input.text },
        { surfaceAsk: false },
      )
      if (gate && 'denied' in gate) {
        throw new AvatarValidationError(`Avatar narration blocked: ${gate.reason}`)
      }
    }
    try {
      const impl = await getTTSProvider(ttsProvider)
      const ttsResult = await impl.generate({
        text: input.text,
        sceneId: input.sceneId ?? 'avatar-gen',
        voiceId: boundVoice?.voiceId,
      })
      resolvedAudioUrl = ttsResult.audioUrl
    } catch (e) {
      throw new Error(`TTS generation failed: ${(e as Error).message}`, { cause: e })
    }
  }

  const wordCount = input.text.split(/\s+/).length
  const estimatedDuration = Math.ceil((wordCount / 150) * 60)

  const [videoRecord] = await db
    .insert(avatarVideos)
    .values({
      projectId,
      sceneId: input.sceneId ?? null,
      avatarConfigId: config.id,
      provider: config.provider,
      status: 'generating',
      text: input.text,
      audioUrl: resolvedAudioUrl ?? null,
      sourceImageUrl: guardedFace,
    })
    .returning()

  try {
    const result = await AvatarService.generate(
      {
        text: input.text,
        audioUrl: resolvedAudioUrl ?? '',
        durationSeconds: estimatedDuration,
        projectId,
        sourceImageUrl: guardedFace ?? undefined,
      },
      config,
    )

    const [updated] = await db
      .update(avatarVideos)
      .set({
        status: 'ready',
        videoUrl: result.videoUrl,
        durationSeconds: result.durationSeconds,
        costUsd: result.costUsd,
      })
      .where(eq(avatarVideos.id, videoRecord.id))
      .returning()

    // Commit the FAL-avatar spend (musetalk/fabric/aurora) to the per-project apiSpend ledger.
    // The provider returns costUsd but only writes it to the avatarVideos row — the session/monthly
    // caps read ONLY the apiSpend ledger, so without this the FAL-avatar paths never advanced the cap
    // (a cap evasion). These providers gate under 'falAvatar' (avatar-tools.ts), so bill the SAME
    // apiName. HeyGen is excluded — it bills in startHeygenAvatar. Best-effort:
    // a ledger-write failure must not lose the already-generated (already-paid) clip.
    if (config.provider !== 'heygen' && result.costUsd > 0 && Number.isFinite(result.costUsd)) {
      try {
        const { logSpend } = await import('@/lib/db')
        await logSpend(projectId, 'falAvatar', result.costUsd, `${config.provider}: ${input.text.slice(0, 80)}`)
      } catch {
        /* spend logging is best-effort; the avatar clip is already generated */
      }
    }

    return updated
  } catch (e) {
    const message = (e as Error).message
    await db
      .update(avatarVideos)
      .set({
        status: 'error',
        errorMessage: message,
      })
      .where(eq(avatarVideos.id, videoRecord.id))

    throw new Error(`Avatar generation failed: ${message}`, { cause: e })
  }
}
