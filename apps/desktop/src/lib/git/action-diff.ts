/**
 * Action-log diff.
 *
 * Two action logs become a human-readable list of "what changed". Since
 * the action log is the deepest truth, a diff
 * between two branches is more meaningful as an action diff than as a
 * `git diff` of derived files.
 *
 * Rules:
 *   - Identity is `id`. Two actions with the same id are the same
 *     action; we compare timestamps + source + params for drift but
 *     normal flows shouldn't ever rewrite an action id.
 *   - `added` = present in `curr`, not in `prev`. Order preserved.
 *   - `removed` = the inverse — present in `prev`, not in `curr`.
 *   - `changed` = same id, different params/source/timestamp.
 *   - `summary` collapses adds/removes by `runId` so a 50-action agent
 *     run shows up as one "agent run X (+50)" entry in the UI.
 *
 * Pure — no I/O. The caller loads each log (from disk or from the DB)
 * and hands the in-memory arrays in.
 */

import type { Action } from '@/lib/actions'

export interface ActionDiffEntry {
  kind: 'added' | 'removed' | 'changed'
  action: Action
  /** Only set when `kind === 'changed'` — the previous version. */
  prior?: Action
  /** Human-readable description, e.g. `"+ clip/add (clip-12)"`. */
  label: string
}

export interface RunSummary {
  /** `runId` if grouped, otherwise null (loose single-action additions). */
  runId: string | null
  source: Action['source']
  /** Count of added actions in this group. */
  added: number
  /** Count of removed actions in this group. */
  removed: number
  /** First action's timestamp for ordering. */
  firstTimestamp: number
  /** Concise label like `"agent: clip/add, clip/move (+12)"`. */
  label: string
}

export interface ActionLogDiff {
  entries: ActionDiffEntry[]
  /** Summary grouped by `runId` for the UI. */
  summary: RunSummary[]
}

export interface DiffOptions {
  /**
   * When true, only flag `changed` entries if params differ. Timestamp
   * / source drift is ignored. Default true — replay log shuffles
   * shouldn't show up as noisy "changed" entries in the UI.
   */
  ignoreNonParamChanges?: boolean
}

const MAX_LABELED_TYPES = 4

/** Label a single action for the per-entry list. */
function labelFor(action: Action, kind: ActionDiffEntry['kind']): string {
  const sign = kind === 'added' ? '+' : kind === 'removed' ? '-' : '~'
  // Try to pull the obvious id out of params for at-a-glance reading.
  const p = action.params as unknown as Record<string, unknown> | undefined
  const id =
    (p && typeof p === 'object' && ('clipId' in p || 'trackId' in p || 'sceneId' in p || 'layerId' in p)
      ? (p['clipId'] ?? p['trackId'] ?? p['sceneId'] ?? p['layerId'])
      : undefined) ?? action.id
  return `${sign} ${action.type} (${String(id)})`
}

function paramsEqual(a: unknown, b: unknown): boolean {
  // Cheap deep-eq via JSON.stringify is fine because action params are
  // plain JSON values (no Date, no Map, no functions).
  return JSON.stringify(a) === JSON.stringify(b)
}

function isDifferent(a: Action, b: Action, opts: DiffOptions): boolean {
  if (!paramsEqual(a.params, b.params)) return true
  if (opts.ignoreNonParamChanges !== false) return false
  return a.source !== b.source || a.timestamp !== b.timestamp || a.runId !== b.runId
}

/** Compute the diff. Pure. */
export function diffActionLogs(
  prev: readonly Action[],
  curr: readonly Action[],
  options: DiffOptions = {},
): ActionLogDiff {
  const prevById = new Map(prev.map((a) => [a.id, a]))
  const currById = new Map(curr.map((a) => [a.id, a]))

  const entries: ActionDiffEntry[] = []

  // Adds + changes — iterate `curr` so ordering matches the timeline.
  for (const action of curr) {
    const prior = prevById.get(action.id)
    if (!prior) {
      entries.push({ kind: 'added', action, label: labelFor(action, 'added') })
    } else if (isDifferent(action, prior, options)) {
      entries.push({ kind: 'changed', action, prior, label: labelFor(action, 'changed') })
    }
  }

  // Removes — iterate `prev` so users see them where they used to live.
  for (const action of prev) {
    if (!currById.has(action.id)) {
      entries.push({ kind: 'removed', action, label: labelFor(action, 'removed') })
    }
  }

  return { entries, summary: summariseByRun(entries) }
}

function summariseByRun(entries: readonly ActionDiffEntry[]): RunSummary[] {
  // Key: `${source}:${runId|''}` so loose user actions get their own
  // ungrouped bucket. We don't group "changed" entries since the UI
  // will surface those as per-action conflict markers anyway.
  type Bucket = {
    runId: string | null
    source: Action['source']
    addedTypes: string[]
    removedTypes: string[]
    addedCount: number
    removedCount: number
    firstTimestamp: number
  }
  const buckets = new Map<string, Bucket>()
  for (const e of entries) {
    if (e.kind === 'changed') continue
    const key = `${e.action.source}:${e.action.runId ?? ''}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        runId: e.action.runId,
        source: e.action.source,
        addedTypes: [],
        removedTypes: [],
        addedCount: 0,
        removedCount: 0,
        firstTimestamp: e.action.timestamp,
      }
      buckets.set(key, b)
    }
    if (e.action.timestamp < b.firstTimestamp) b.firstTimestamp = e.action.timestamp
    if (e.kind === 'added') {
      b.addedCount++
      if (!b.addedTypes.includes(e.action.type)) b.addedTypes.push(e.action.type)
    } else {
      b.removedCount++
      if (!b.removedTypes.includes(e.action.type)) b.removedTypes.push(e.action.type)
    }
  }
  const out: RunSummary[] = []
  for (const b of buckets.values()) {
    const types = b.addedTypes.length ? b.addedTypes : b.removedTypes
    const trimmed = types.slice(0, MAX_LABELED_TYPES).join(', ')
    const ellipsis = types.length > MAX_LABELED_TYPES ? ', …' : ''
    const delta =
      (b.addedCount ? `+${b.addedCount}` : '') + (b.removedCount ? `${b.addedCount ? ' ' : ''}-${b.removedCount}` : '')
    const runFragment = b.runId ? ` ${b.runId.slice(0, 8)}` : ''
    out.push({
      runId: b.runId,
      source: b.source,
      added: b.addedCount,
      removed: b.removedCount,
      firstTimestamp: b.firstTimestamp,
      label: `${b.source}${runFragment}: ${trimmed}${ellipsis} (${delta})`,
    })
  }
  out.sort((a, b) => a.firstTimestamp - b.firstTimestamp)
  return out
}
