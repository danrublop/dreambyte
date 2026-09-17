import { db } from '../index'
import { characters } from '../schema'
import { and, desc, eq, sql } from 'drizzle-orm'

// Character bundles — a reusable character identity (reference set + seed + i2i model
// + style descriptor). Reusing a character conditions generation on its primary reference
// AND its seed so the same subject re-appears across scenes. See src/lib/services/characters.ts.

export interface CharacterRow {
  id: string
  projectId: string
  name: string
  description: string | null
  referenceAssetIds: string[]
  seed: number | null
  model: string | null
  strength: number | null
  /** Tier 3 Cast: bound cloned voice (cloned_voices.id), or null for a face-only character. */
  voiceId: string | null
  createdAt: Date
}

export async function createCharacter(input: {
  projectId: string
  name: string
  description?: string | null
  referenceAssetIds?: string[]
  seed?: number | null
  model?: string | null
  strength?: number | null
  voiceId?: string | null
}): Promise<CharacterRow> {
  const [row] = await db
    .insert(characters)
    .values({
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      referenceAssetIds: input.referenceAssetIds ?? [],
      seed: input.seed ?? null,
      model: input.model ?? null,
      strength: input.strength ?? null,
      voiceId: input.voiceId ?? null,
    })
    .returning()
  return toRow(row)
}

/** Bind (or clear) a character's cloned voice — the Cast "face + voice" link (Tier 3 Slice 3). */
export async function setCharacterVoice(projectId: string, id: string, voiceId: string | null): Promise<void> {
  await db
    .update(characters)
    .set({ voiceId })
    .where(and(eq(characters.id, id), eq(characters.projectId, projectId)))
}

export async function getCharacter(projectId: string, id: string): Promise<CharacterRow | null> {
  const [row] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.projectId, projectId)))
    .limit(1)
  return row ? toRow(row) : null
}

/** Resolve a character by id OR (case-insensitive) name — the agent refers to them by name. */
export async function resolveCharacter(projectId: string, idOrName: string): Promise<CharacterRow | null> {
  const byId = await getCharacter(projectId, idOrName)
  if (byId) return byId
  // Deterministic order (oldest first) so that even if a duplicate name slipped in before the
  // unique index existed, name resolution is stable rather than dependent on scan order.
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId))
    .orderBy(characters.createdAt)
  const wanted = idOrName.trim().toLowerCase()
  const match = rows.find((r) => r.name.trim().toLowerCase() === wanted)
  return match ? toRow(match) : null
}

export async function listCharacters(projectId: string): Promise<CharacterRow[]> {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId))
    .orderBy(desc(characters.createdAt))
  return rows.map(toRow)
}

/** Attach freshly-generated reference assets to a character (e.g. after the first render). */
export async function setCharacterReferences(
  projectId: string,
  id: string,
  referenceAssetIds: string[],
): Promise<void> {
  await db
    .update(characters)
    .set({ referenceAssetIds })
    .where(and(eq(characters.id, id), eq(characters.projectId, projectId)))
}

/**
 * Adopt a single reference asset ONLY if the character still has none — a conditional
 * (compare-and-set) update so two concurrent first-renders can't clobber each other's
 * adoption (last-writer-wins would leave the bundle pointing at whichever finished last).
 * The `reference_asset_ids = '[]'` guard is the empty-JSON default written by the migration.
 */
export async function adoptReferenceIfEmpty(projectId: string, id: string, assetId: string): Promise<void> {
  await db
    .update(characters)
    .set({ referenceAssetIds: [assetId] })
    .where(and(eq(characters.id, id), eq(characters.projectId, projectId), sql`${characters.referenceAssetIds} = '[]'`))
}

function toRow(r: typeof characters.$inferSelect): CharacterRow {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    referenceAssetIds: r.referenceAssetIds ?? [],
    seed: r.seed,
    model: r.model,
    strength: r.strength,
    voiceId: r.voiceId,
    createdAt: r.createdAt,
  }
}
