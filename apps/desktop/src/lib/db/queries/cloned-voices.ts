import { db } from '../index'
import { clonedVoices, voiceCloneConsents } from '../schema'
import { and, desc, eq } from 'drizzle-orm'

// Tier 3 Cast (Slice 2) — cloned voices + project-level voice-clone consent.
// The raw biometric audio is never stored; these rows hold the provider voice id, sample
// metadata, and a consent audit. The consent gate lives in src/lib/services/voice-clone.ts.

export interface ClonedVoiceRow {
  id: string
  projectId: string
  name: string
  provider: string
  providerVoiceId: string
  sampleMime: string | null
  sampleBytes: number | null
  consentAt: Date
  consentVersion: string
  consentDestination: string
  createdAt: Date
}

export async function createClonedVoice(input: {
  projectId: string
  name: string
  provider: string
  providerVoiceId: string
  sampleMime?: string | null
  sampleBytes?: number | null
  consentAt: Date
  consentVersion: string
  consentDestination: string
}): Promise<ClonedVoiceRow> {
  const [row] = await db
    .insert(clonedVoices)
    .values({
      projectId: input.projectId,
      name: input.name,
      provider: input.provider,
      providerVoiceId: input.providerVoiceId,
      sampleMime: input.sampleMime ?? null,
      sampleBytes: input.sampleBytes ?? null,
      consentAt: input.consentAt,
      consentVersion: input.consentVersion,
      consentDestination: input.consentDestination,
    })
    .returning()
  return toRow(row)
}

export async function getClonedVoice(projectId: string, id: string): Promise<ClonedVoiceRow | null> {
  const [row] = await db
    .select()
    .from(clonedVoices)
    .where(and(eq(clonedVoices.id, id), eq(clonedVoices.projectId, projectId)))
    .limit(1)
  return row ? toRow(row) : null
}

/** Resolve a cloned voice by id OR (case-insensitive) name — the agent/picker selects by name. */
export async function resolveClonedVoice(projectId: string, idOrName: string): Promise<ClonedVoiceRow | null> {
  const byId = await getClonedVoice(projectId, idOrName)
  if (byId) return byId
  const rows = await db
    .select()
    .from(clonedVoices)
    .where(eq(clonedVoices.projectId, projectId))
    .orderBy(clonedVoices.createdAt)
  const wanted = idOrName.trim().toLowerCase()
  const match = rows.find((r) => r.name.trim().toLowerCase() === wanted)
  return match ? toRow(match) : null
}

export async function listClonedVoices(projectId: string): Promise<ClonedVoiceRow[]> {
  const rows = await db
    .select()
    .from(clonedVoices)
    .where(eq(clonedVoices.projectId, projectId))
    .orderBy(desc(clonedVoices.createdAt))
  return rows.map(toRow)
}

/** Remove the local row. Returns the deleted row so the caller can delete the remote voiceprint
 *  (hard delete — see src/lib/services/voice-clone.ts). Returns null if nothing matched. */
export async function deleteClonedVoiceRow(projectId: string, id: string): Promise<ClonedVoiceRow | null> {
  const [row] = await db
    .delete(clonedVoices)
    .where(and(eq(clonedVoices.id, id), eq(clonedVoices.projectId, projectId)))
    .returning()
  return row ? toRow(row) : null
}

export interface VoiceCloneConsentRow {
  projectId: string
  destination: string
  version: string
  consentAt: Date
}

/** The stored consent for a (project, destination), or null if none yet (first clone to that
 *  destination must supply a fresh acknowledgement). */
export async function getProjectVoiceConsent(
  projectId: string,
  destination: string,
): Promise<VoiceCloneConsentRow | null> {
  const [row] = await db
    .select()
    .from(voiceCloneConsents)
    .where(and(eq(voiceCloneConsents.projectId, projectId), eq(voiceCloneConsents.destination, destination)))
    .limit(1)
  if (!row) return null
  return {
    projectId: row.projectId,
    destination: row.destination,
    version: row.version,
    consentAt: row.consentAt,
  }
}

/**
 * Record (or update) consent for a (project, destination). Idempotent upsert keyed on the composite
 * PK so each destination keeps its own contemporaneous consentAt + version — re-consenting to one
 * destination never mutates another's audit record.
 */
export async function recordProjectVoiceConsent(input: {
  projectId: string
  destination: string
  version: string
  consentAt: Date
}): Promise<VoiceCloneConsentRow> {
  await db
    .insert(voiceCloneConsents)
    .values({
      projectId: input.projectId,
      destination: input.destination,
      version: input.version,
      consentAt: input.consentAt,
    })
    .onConflictDoUpdate({
      target: [voiceCloneConsents.projectId, voiceCloneConsents.destination],
      set: { version: input.version, consentAt: input.consentAt },
    })
  return {
    projectId: input.projectId,
    destination: input.destination,
    version: input.version,
    consentAt: input.consentAt,
  }
}

function toRow(r: typeof clonedVoices.$inferSelect): ClonedVoiceRow {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    provider: r.provider,
    providerVoiceId: r.providerVoiceId,
    sampleMime: r.sampleMime,
    sampleBytes: r.sampleBytes,
    consentAt: r.consentAt,
    consentVersion: r.consentVersion,
    consentDestination: r.consentDestination,
    createdAt: r.createdAt,
  }
}
