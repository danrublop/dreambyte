import { db } from '../index'
import { userMemory, workspaces, projects } from '../schema'
import { eq, and, desc, gte, sql, or, isNull } from 'drizzle-orm'
import type { BrandKit, GlobalStyle } from '../../types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface UserMemoryRow {
  id: string
  userId: string
  projectId: string | null
  category: string
  key: string
  value: string
  confidence: number
  sourceRunId: string | null
  createdAt: Date
  updatedAt: Date
}

/** The merged shape consumed by the prompt-injection path (context-builder). */
export interface ScopedMemory {
  category: string
  key: string
  value: string
  confidence: number
  /** Which precedence layer this entry won from (debug/eval/observability). */
  layer: 'project' | 'workspace' | 'user'
}

// Confidence assigned to the synthetic workspace.brandKit/globalStyle layer.
// It sits BELOW a fresh project memory (default 0.5) so an explicitly-learned
// project preference outranks a workspace default, but ABOVE the prompt's 0.3
// inject floor so brand identity always reaches the model. Decision 2:
// workspace taste is NOT stored in user_memory — it is derived here at read
// time from the authoritative workspaces row.
const WORKSPACE_LAYER_CONFIDENCE = 0.7

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Fetch user memories sorted by confidence, filtering out low-confidence entries.
 * Returns at most `maxItems` memories (default 20).
 *
 * Legacy/user-global path: matches only rows with NO project scope. Kept for
 * callers that have no project context (and as the user layer inside
 * getMemoriesScoped). Project-scoped retrieval goes through getMemoriesScoped.
 */
export async function getMemoriesForUser(userId: string, maxItems = 20): Promise<UserMemoryRow[]> {
  return db
    .select()
    .from(userMemory)
    .where(and(eq(userMemory.userId, userId), isNull(userMemory.projectId), gte(userMemory.confidence, 0.1)))
    .orderBy(desc(userMemory.confidence))
    .limit(maxItems) as Promise<UserMemoryRow[]>
}

/**
 * Scoped retrieval with narrowest-wins precedence:
 *   project-memory > workspace.brandKit/globalStyle > user-global memory.
 *
 * One DB pass fetches both this project's rows and the user-global rows
 * (project_id IS NULL); the workspace layer is derived from the authoritative
 * `workspaces` row (resolved via the project's workspaceId, or passed directly
 * when the caller already has it). Within the same (category, key), the
 * narrowest layer present wins — its value AND its confidence are returned, so
 * a low-confidence project override still beats a higher-confidence user-global
 * entry on the same key (precedence is by layer, not by raw confidence).
 *
 * `projectId` null → behaves like getMemoriesForUser (user layer only), plus
 * any workspace layer the caller passes in via `workspaceId`.
 */
export async function getMemoriesScoped(
  userId: string,
  projectId: string | null,
  opts: { maxItems?: number; workspaceId?: string | null } = {},
): Promise<ScopedMemory[]> {
  const maxItems = opts.maxItems ?? 20

  // Both project-scoped and user-global rows in one query.
  const scopeFilter = projectId
    ? or(isNull(userMemory.projectId), eq(userMemory.projectId, projectId))
    : isNull(userMemory.projectId)
  const rows = (await db
    .select()
    .from(userMemory)
    .where(and(eq(userMemory.userId, userId), scopeFilter, gte(userMemory.confidence, 0.1)))
    .orderBy(desc(userMemory.confidence))) as UserMemoryRow[]

  // Resolve the workspace layer. Prefer an explicit workspaceId (the caller
  // already fetched the project row); otherwise derive it from the project.
  let workspaceId = opts.workspaceId ?? null
  if (!workspaceId && projectId) {
    const projRow = await db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
    workspaceId = projRow[0]?.workspaceId ?? null
  }
  const workspaceLayer = workspaceId ? await deriveWorkspaceMemories(workspaceId) : []

  // Layer precedence: project (1) > workspace (2) > user (3). Lower rank wins.
  const RANK: Record<ScopedMemory['layer'], number> = { project: 1, workspace: 2, user: 3 }
  const byKey = new Map<string, ScopedMemory>()
  const consider = (m: ScopedMemory) => {
    const k = `${m.category}:${m.key}`
    const existing = byKey.get(k)
    if (!existing || RANK[m.layer] < RANK[existing.layer]) byKey.set(k, m)
  }

  for (const r of rows) {
    consider({
      category: r.category,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      layer: r.projectId ? 'project' : 'user',
    })
  }
  for (const w of workspaceLayer) consider(w)

  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, maxItems)
}

/**
 * Derive the workspace taste layer from the authoritative workspaces row.
 * brandKit/globalStyle are NOT memory rows — they live on the
 * workspace and are projected into the merged memory shape here so the
 * precedence merge is uniform.
 */
async function deriveWorkspaceMemories(workspaceId: string): Promise<ScopedMemory[]> {
  const wsRows = await db
    .select({ brandKit: workspaces.brandKit, globalStyle: workspaces.globalStyle })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  const ws = wsRows[0]
  if (!ws) return []
  const out: ScopedMemory[] = []
  const push = (category: string, key: string, value: string | null | undefined) => {
    if (value && value.trim()) {
      out.push({ category, key, value: value.trim(), confidence: WORKSPACE_LAYER_CONFIDENCE, layer: 'workspace' })
    }
  }

  const brandKit = ws.brandKit as BrandKit | null
  if (brandKit) {
    push('style', 'brand_name', brandKit.brandName)
    if (brandKit.palette?.length) push('style', 'brand_palette', brandKit.palette.join(', '))
    push('style', 'brand_font_primary', brandKit.fontPrimary)
    push('style', 'brand_font_secondary', brandKit.fontSecondary)
    push('style', 'brand_guidelines', brandKit.guidelines)
  }
  const globalStyle = ws.globalStyle as GlobalStyle | null
  if (globalStyle) {
    if (globalStyle.paletteOverride?.length) push('style', 'palette', globalStyle.paletteOverride.join(', '))
    push('style', 'font', globalStyle.fontOverride)
    if (globalStyle.motionPersonality) push('style', 'motion_personality', globalStyle.motionPersonality)
  }
  return out
}

/**
 * Insert or update a memory. Conflict target is the SCOPED uniqueness
 * (userId, coalesce(projectId,''), category, key) so a project-scoped row and
 * a user-global row with the same (category, key) coexist and update
 * independently. `projectId` null = a user-global memory.
 */
export async function upsertMemory(
  userId: string,
  category: string,
  key: string,
  value: string,
  confidence: number,
  sourceRunId?: string,
  projectId?: string | null,
): Promise<void> {
  await db
    .insert(userMemory)
    .values({
      userId,
      projectId: projectId ?? null,
      category,
      key,
      value,
      confidence,
      sourceRunId: sourceRunId ?? null,
    })
    .onConflictDoUpdate({
      // The conflict target MUST match the scoped unique index expression
      // exactly — `(user_id, coalesce(project_id,''), category, key)`. SQLite
      // resolves an upsert's ON CONFLICT clause to an index by structural
      // match, so passing the raw `project_id` column would NOT bind to the
      // coalesce-expression index and the upsert would insert a duplicate
      // instead of updating. We spell out the same coalesce here.
      target: [userMemory.userId, sql`coalesce(${userMemory.projectId}, '')`, userMemory.category, userMemory.key],
      set: {
        value,
        confidence,
        sourceRunId: sourceRunId ?? null,
        updatedAt: new Date(),
      },
    })
}

/**
 * Decay all memories for a user by multiplying confidence by a factor.
 * Memories below 0.05 are deleted entirely.
 * Triggered on app launch (Electron main) — see decayMemoriesOnLaunch.
 *
 * Scope-agnostic: decays BOTH project-scoped and user-global rows. Decay is a
 * time-based background floor; it should not care which project a memory
 * belongs to.
 */
export async function decayMemories(userId: string, decayFactor = 0.95): Promise<void> {
  // Multiply confidence by decay factor
  await db
    .update(userMemory)
    .set({ confidence: sql`${userMemory.confidence} * ${decayFactor}` })
    .where(eq(userMemory.userId, userId))

  // Clean up memories that have decayed below threshold
  await db.delete(userMemory).where(and(eq(userMemory.userId, userId), sql`${userMemory.confidence} < 0.05`))
}

/** Today's date as a UTC YYYY-MM-DD stamp (the decay granularity). */
function utcDayStamp(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Pure decision: should launch-decay run, given the last-run day stamp on disk
 * and today's stamp? Decay is a once-PER-DAY floor, not once-per-launch — the
 * maintainer opens several app windows against one shared studio.db, so an
 * unguarded per-launch decay multiplies (0.95^N) and forgets taste N× too fast
 * (review INFO-8). Exported for unit tests.
 */
export function shouldRunDailyDecay(lastDayStamp: string | null, todayStamp: string): boolean {
  return lastDayStamp !== todayStamp
}

/** Path of the once-per-day decay marker, next to the file: DB. null if not a local file DB. */
function decayMarkerPath(): string | null {
  const url = process.env.DATABASE_URL
  if (!url) return null
  // Mirror src/lib/db/index.ts normalization: file:<path>, or a bare path with no scheme.
  let dbPath: string | null = null
  const fileMatch = /^file:(.*)$/i.exec(url)
  if (fileMatch) dbPath = fileMatch[1]
  else if (!/^[a-z]+:/i.test(url)) dbPath = url
  if (!dbPath) return null // remote/libsql URL — no local marker, just decay
  const path = require('node:path') as typeof import('node:path')
  return path.join(path.dirname(dbPath), '.dreambyte-last-decay')
}

/**
 * App-launch decay trigger. Decays the desktop user's
 * memories at most ONCE PER UTC DAY (×0.95, prune <0.05), so a stale preference
 * fades unless a fresh signal keeps reinforcing it. The per-day marker file
 * (next to studio.db) makes this safe across the multiple concurrent app
 * instances the maintainer runs — without it, N windows decay N× (INFO-8).
 * Best-effort: any failure here must never block app startup, so it swallows.
 *
 * Lives here (not in src/electron/main) so it stays unit-testable and so the
 * desktop-user seed and the decay run share one DB module.
 */
export async function decayMemoriesOnLaunch(decayFactor = 0.95): Promise<void> {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const today = utcDayStamp(new Date())
    const marker = decayMarkerPath()
    if (marker) {
      let last: string | null = null
      try {
        last = fs.readFileSync(marker, 'utf-8').trim() || null
      } catch {
        last = null // first run / unreadable → treat as "never decayed"
      }
      if (!shouldRunDailyDecay(last, today)) return // already decayed today (another window did it)
    }
    const { getDesktopUserId } = await import('./desktop-user')
    const userId = await getDesktopUserId()
    await decayMemories(userId, decayFactor)
    // Stamp AFTER a successful decay so a failed decay retries next launch.
    if (marker) {
      try {
        fs.writeFileSync(marker, today)
      } catch {
        // marker write failed — worst case is another decay later today; not fatal
      }
    }
  } catch {
    // swallow — decay is a background floor, never a startup blocker
  }
}

/**
 * Adjust confidence for ONE specific memory key (the attribution-correct
 * taste signal). A regenerate/keep+export/inferred signal
 * about a single preference moves ONLY that (category, key) at the given
 * scope, never unrelated memories. Confidence is clamped to [0, 1].
 *
 * Scope matching mirrors retrieval: when `projectId` is provided, the
 * project-scoped row is adjusted; otherwise the user-global row. No row at
 * that scope/key → no-op (the signal references a memory we never stored).
 *
 * Returns the number of rows moved (0 or 1) so a caller can log honestly.
 */
export async function adjustMemoryKeyConfidence(
  userId: string,
  category: string,
  key: string,
  delta: number,
  projectId?: string | null,
): Promise<number> {
  const res = await db
    .update(userMemory)
    .set({
      confidence: sql`min(1.0, max(0.0, ${userMemory.confidence} + ${delta}))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMemory.userId, userId),
        eq(userMemory.category, category),
        eq(userMemory.key, key),
        projectId ? eq(userMemory.projectId, projectId) : isNull(userMemory.projectId),
      ),
    )
  // libsql returns rowsAffected on the result.
  return (res as { rowsAffected?: number }).rowsAffected ?? 0
}
