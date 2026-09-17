// ── Multi-dimension provider selector ────────────────────────────────────────
//
// Generic scoring engine shared by TTS, image, video, and avatar selection.
// Each provider declares a `ProviderProfile` with static scores across the
// 6 dimensions we care about (quality, reliability, latency, control,
// continuity, task fit) plus a cost function and an availability predicate.
//
// `selectBestProvider` evaluates every candidate against a `SelectionContext`
// (user's request + environment) using `SelectionWeights` (how much each
// dimension matters for this task) and returns the highest-scoring provider
// plus a short human-readable reason — so the agent can tell the user WHY it
// picked a provider instead of relying on a hardcoded cascade.
//
// The scorer is intentionally small and pure: no I/O, no side effects, safe
// for client and server bundles. Real-world provider pricing and availability
// live in category-specific profile files (tts-profiles.ts, etc.).

export type ProviderCategory = 'tts' | 'sfx' | 'music' | 'image' | 'video' | 'avatar'

/** Environment + request context that the scorer passes to each profile. */
export interface SelectionContext {
  /** Whether the user is in free/local mode (prefer zero-cost providers). */
  localMode?: boolean
  /** Task hint — providers may use this to return a taskFit score. */
  task?: string
  /** Text length for TTS-style tasks (characters). */
  textLength?: number
  /** Duration in seconds for video/audio generation. */
  durationSeconds?: number
  /** Resolution hint ("720p", "1080p", "4k") for image/video tasks. */
  resolution?: string
  /** Per-provider enabled map from the project (disabled providers filtered out). */
  enabled?: Record<string, boolean>
  /** Configured env vars (for env-key availability checks). */
  env?: Record<string, string | undefined>
  /** Platform — 'darwin' | 'win32' | 'linux' — for native-only providers. */
  platform?: string
  /** Prior provider used in the project, for continuity scoring. */
  lastProviderId?: string
  /** When true, only consider providers that produce server-side artifacts
   *  the MP4 export can ingest. Client-only providers (web-speech, puter)
   *  are filtered out. Set for MP4 renders; leave unset for browser preview. */
  requiresServerOutput?: boolean
  /** Provider IDs to exclude from ranking (e.g. explicitly denied by project
   *  permissions). Useful when the policy layer has already ruled them out. */
  excludeIds?: string[]
}

export interface ProviderProfile<Id extends string = string> {
  id: Id
  category: ProviderCategory
  name: string

  // Static score axes (0–100 where higher is better). Calibrated relative to
  // the other providers in the same category — a "50" ElevenLabs and a "50"
  // OpenAI TTS mean the same thing within the TTS category.
  quality: number
  reliability: number
  latency: number
  control: number

  /** Whether this provider can be used given the current context. If it
   *  returns false the provider is dropped from the ranking entirely. */
  available: (ctx: SelectionContext) => boolean

  /** Expected per-call cost in USD given the context. Used for cost scoring
   *  (lower is better) and to help the UI surface cost in the disclosure. */
  costUsd: (ctx: SelectionContext) => number

  /** 0–100 task-fit override. Default 50 (neutral). Providers can return a
   *  higher score when they are particularly well-suited to the task. */
  taskFit?: (ctx: SelectionContext) => number

  /** Optional short reason string surfaced when this provider wins. */
  reasonHint?: string

  /** Providers that only produce output in the browser (web-speech, puter).
   *  These are filtered out when `ctx.requiresServerOutput` is true — e.g.
   *  for MP4 export where the renderer needs a real audio file. */
  clientOnly?: boolean
}

export interface SelectionWeights {
  quality: number
  reliability: number
  latency: number
  control: number
  continuity: number
  /** Applied as a negative weight on normalized cost (cheaper = higher score). */
  cost: number
  taskFit: number
}

/** Default weights — task fit dominates so specialised providers win on
 *  specialised tasks; cost is a secondary pressure; continuity is a gentle
 *  tiebreak between similarly-ranked providers. */
export const DEFAULT_WEIGHTS: SelectionWeights = {
  quality: 1.0,
  reliability: 0.9,
  latency: 0.3,
  control: 0.4,
  continuity: 0.2,
  cost: 0.4,
  taskFit: 1.5,
}

/** Preset: prioritize cheap/free providers (local mode). */
export const LOCAL_MODE_WEIGHTS: SelectionWeights = {
  quality: 0.3,
  reliability: 0.5,
  latency: 0.3,
  control: 0.2,
  continuity: 0.1,
  cost: 2.5,
  taskFit: 0.8,
}

export interface ProviderScore<Id extends string = string> {
  id: Id
  score: number
  components: {
    quality: number
    reliability: number
    latency: number
    control: number
    continuity: number
    cost: number
    taskFit: number
  }
  costUsd: number
  reason: string
}

export interface SelectionResult<Id extends string = string> {
  /** Winning provider, or null when no candidate is available. */
  chosen: ProviderScore<Id> | null
  /** Full ranking in descending score order — useful for disclosure UI. */
  ranking: ProviderScore<Id>[]
}

/** Score and rank a set of provider profiles against the given context. */
export function selectBestProvider<Id extends string>(
  profiles: ProviderProfile<Id>[],
  ctx: SelectionContext,
  weights: SelectionWeights = DEFAULT_WEIGHTS,
): SelectionResult<Id> {
  const excluded = new Set(ctx.excludeIds ?? [])
  const available = profiles.filter((p) => {
    if (excluded.has(p.id)) return false
    if (ctx.enabled && ctx.enabled[p.id] === false) return false
    if (ctx.requiresServerOutput && p.clientOnly) return false
    try {
      return p.available(ctx)
    } catch {
      return false
    }
  })

  if (available.length === 0) return { chosen: null, ranking: [] }

  // Normalize cost against the max so the cost component is always in [0, 1].
  // Free providers get a perfect cost score. Absent cost data treated as 0.
  const costs = available.map((p) => {
    try {
      return p.costUsd(ctx)
    } catch {
      return 0
    }
  })
  const maxCost = Math.max(...costs, 0.0001)

  const ranking: ProviderScore<Id>[] = available.map((p, i) => {
    const cost = costs[i]
    const normalisedCost = 1 - cost / maxCost // 1 = free, 0 = most expensive
    const taskFit = p.taskFit ? Math.max(0, Math.min(100, p.taskFit(ctx))) : 50
    const continuity = ctx.lastProviderId === p.id ? 100 : 0

    const components = {
      quality: p.quality,
      reliability: p.reliability,
      latency: p.latency,
      control: p.control,
      continuity,
      cost: normalisedCost * 100,
      taskFit,
    }

    const score =
      components.quality * weights.quality +
      components.reliability * weights.reliability +
      components.latency * weights.latency +
      components.control * weights.control +
      components.continuity * weights.continuity +
      components.cost * weights.cost +
      components.taskFit * weights.taskFit

    return {
      id: p.id,
      score,
      components,
      costUsd: cost,
      reason: p.reasonHint ?? `${p.name}`,
    }
  })

  ranking.sort((a, b) => b.score - a.score)

  const top = ranking[0]
  const runnerUp = ranking[1]
  let reason = `${available.find((p) => p.id === top.id)?.name ?? top.id}`
  if (runnerUp) {
    // Surface the axis where the winner most decisively beat the runner-up.
    const diffs: Array<[keyof typeof top.components, number]> = (
      Object.keys(top.components) as Array<keyof typeof top.components>
    ).map((k) => [k, top.components[k] - runnerUp.components[k]])
    diffs.sort((a, b) => b[1] - a[1])
    const [winningAxis, gap] = diffs[0]
    if (gap > 5) reason = `${reason}: better ${winningAxis}`
  }
  ranking[0].reason = reason

  return { chosen: ranking[0], ranking }
}
