/**
 * Single-scene aesthetic "slop rubric" (Gap D).
 *
 * The deterministic pixel-truth gate (scene-verifier + the tool-executor veto)
 * catches BROKEN renders — blank frames, all-broken images — and blocks them. It
 * cannot judge whether a scene that renders fine is *generic*: centered-everything,
 * the AI cyan/purple palette, fade-everything-from-below, no hierarchy. That
 * subjective judgment needs a vision model.
 *
 * The multi-scene path already gets this via the cut review (one frame per scene,
 * cut-level pacing/redundancy/continuity). Single-scene direct builds got nothing.
 * This module fills that gap: capture ONE representative frame of a scene, run a
 * cheap VLM against the design-principles rubric, and return an ADVISORY verdict
 * (per the chosen veto posture, the rubric never blocks — it informs). Reuses the
 * same vision transport, frame decode/downsample, and cost-ledger gating as the
 * cut review, so there is one place that captures+bills a frame review.
 *
 * Never throws on a normal failure — returns `reviewable:false` with a note so the
 * caller degrades to "no verdict", exactly like the cut review.
 */

import { commitCost, refundCost, isOverCap, type RunCostLedger } from '../run-cost-ledger'
import { estimateAnalysisCost } from './multimodal-intake'
import {
  sendFramesToVision,
  supportsFrameVision,
  type FramesVisionDeps,
} from './intake-engines/frames-vision'
import { parseFencedJson } from './intake-engines/parse-json'
import { dataUriToKeyframe, downsampleFrame } from './cut-review'
import type { ToolCallRecord } from '../types'

export type SceneRubricSeverity = 'high' | 'medium' | 'low'

export interface SceneRubricIssue {
  severity: SceneRubricSeverity
  /** One concrete, fixable observation (e.g. "everything is centered — try a HERO-SPLIT"). */
  detail: string
}

export interface SceneRubricResult {
  /** False when no engine/transport, capture failed, budget, or empty/garbage output. */
  reviewable: boolean
  /** 0-10 slop-resistance score (10 = distinctive, 0 = textbook AI slop). Omitted when not reviewable. */
  score?: number
  issues: SceneRubricIssue[]
  /** One-line gist when reviewable; the skip reason when not. */
  note?: string
}

const SEVERITIES: readonly SceneRubricSeverity[] = ['high', 'medium', 'low']

/**
 * The rubric prompt. Mirrors the design-principles "Slop Test" + anti-patterns so
 * the verdict is grounded in the same bar the generator is told to hit. Asks for a
 * compact JSON object the parser can read. Folded into one user turn (the frame
 * transport has no separate system role for every provider).
 */
export function sceneRubricPrompt(sceneName: string, sceneType: string): string {
  return `You are a senior motion designer doing a fast quality pass on ONE frame of an animated video scene ("${sceneName}", renderer: ${sceneType}). The frame is a representative mid-scene moment.

Judge it against this bar — the "Slop Test": would someone glancing at it immediately think "an AI made this"? Distinctive work makes people ask "how was this made?".

Score 0-10 for slop-resistance (10 = distinctive and intentional, 0 = textbook AI slop). Penalize the instant AI tells:
- Everything centered / no visual hierarchy (squint test: is there one dominant element?)
- The AI palette: neon cyan (#00e5ff), purple→blue gradients, neon purple on dark, gradient text
- Fade-everything-in-from-below; bounce/elastic easing; uniform spacing everywhere
- Card-grid sameness; tiny text (video text must be large); >1 accent color
- Overused fonts (Inter, Montserrat, Roboto, Poppins)

Reward: asymmetric/choreographed layouts, real size+weight hierarchy, restrained palette with one rare accent, generous whitespace, large legible type.

Respond with ONLY a JSON object, no prose:
{"score": <0-10 integer>, "issues": [{"severity": "high|medium|low", "detail": "<one concrete fixable observation>"}], "summary": "<one short sentence>"}
List at most 4 issues, highest-impact first. If the frame is genuinely distinctive, return a high score and an empty issues array.`
}

/** Tolerant parse of the rubric JSON. Returns `reviewable:false` on empty/garbage.
 *  Uses the shared `parseFencedJson` (code-fence + first-`{`/last-`}` extraction)
 *  that every other vision/intake parser uses, then validates the rubric fields. */
export function parseSceneRubric(raw: string): SceneRubricResult {
  const obj = parseFencedJson<{ score?: unknown; issues?: unknown; summary?: unknown }>(raw)
  if (!obj) return { reviewable: false, issues: [], note: 'The vision model did not return parseable JSON.' }
  const scoreNum = typeof obj.score === 'number' ? obj.score : Number(obj.score)
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(10, Math.round(scoreNum))) : undefined
  const issues: SceneRubricIssue[] = Array.isArray(obj.issues)
    ? obj.issues
        .filter((i): i is { severity?: unknown; detail?: unknown } => !!i && typeof i === 'object')
        .map((i) => {
          const sev = SEVERITIES.includes(i.severity as SceneRubricSeverity)
            ? (i.severity as SceneRubricSeverity)
            : 'medium'
          return { severity: sev, detail: String(i.detail ?? '').trim() }
        })
        .filter((i) => i.detail.length > 0)
        .slice(0, 4)
    : []
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() || undefined : undefined
  return { reviewable: true, score, issues, note: summary }
}

export interface SceneRubricDeps extends FramesVisionDeps {
  /** Capture one rendered frame for a scene at `timeSec` (runner wraps captureOneFrame+emit). */
  capture: (sceneId: string, timeSec: number) => Promise<{ dataUri: string; mimeType: string } | null>
  /** Shared run cost ledger — projected-gated before the VLM call, committed after. */
  costLedger?: RunCostLedger
  abortSignal?: { aborted: boolean }
  downsampleMaxDim?: number
  /** Injectable transport (defaults to the real sendFramesToVision) for tests. */
  send?: typeof sendFramesToVision
}

/**
 * Run the single-scene rubric: capture one mid-scene frame, downsample, and run the
 * VLM against the slop rubric. Cost-gated (won't start a call that would cross the
 * run cap) and committed after; refunds on an unreviewable outcome. Never throws.
 */
export async function runSceneRubric(
  sceneId: string,
  sceneName: string,
  sceneType: string,
  durationSec: number,
  engineId: string,
  deps: SceneRubricDeps,
): Promise<SceneRubricResult> {
  if (!supportsFrameVision(engineId)) {
    return { reviewable: false, issues: [], note: `The vision engine "${engineId}" can't review a single frame.` }
  }
  const ledger = deps.costLedger
  // Single-frame estimate: cost the inner engine directly. The `frame-vision:` prefix
  // scales ×4 for the cut review's multi-frame payload; the rubric sends ONE frame, so
  // reserving ×4 would over-count and could prematurely trip the projected-spend gate.
  const est = estimateAnalysisCost(engineId)
  if (ledger && (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd)) {
    return { reviewable: false, issues: [], note: 'Skipped quality review — would exceed the run cost cap.' }
  }
  if (deps.abortSignal?.aborted) return { reviewable: false, issues: [], note: 'Quality review aborted.' }

  const timeSec = Math.max(0, (durationSec || 4) / 2) // representative mid-scene frame
  const cap = await deps.capture(sceneId, timeSec)
  if (!cap) return { reviewable: false, issues: [], note: 'Could not capture a frame to review.' }
  const kf = dataUriToKeyframe(cap.dataUri, timeSec)
  if (!kf) return { reviewable: false, issues: [], note: 'Captured frame was unreadable.' }
  const frame = await downsampleFrame(kf, deps.downsampleMaxDim)

  if (deps.abortSignal?.aborted) return { reviewable: false, issues: [], note: 'Quality review aborted.' }
  // Atomic recheck + reserve before the await (mirrors reviewVideoFromCaptures).
  if (ledger) {
    if (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd) {
      return { reviewable: false, issues: [], note: 'Skipped quality review — would exceed the run cost cap.' }
    }
    commitCost(ledger, est)
  }
  const send = deps.send ?? sendFramesToVision
  let raw: string
  try {
    raw = await send([frame], sceneRubricPrompt(sceneName, sceneType), engineId, deps)
  } catch (err) {
    if (ledger) refundCost(ledger, est)
    return { reviewable: false, issues: [], note: `Quality-review vision call failed: ${(err as Error).message}` }
  }
  const result = parseSceneRubric(raw)
  if (ledger && !result.reviewable) refundCost(ledger, est)
  return result
}

/** Build tools whose successful call means a scene was created or substantially
 *  (re)written this run — what the direct-build rubric reviews. Excludes surgical
 *  `patch_layer_code` edits (the decision: review create + full rewrite, skip
 *  trivial patches). */
const RUBRIC_BUILD_TOOLS = new Set(['create_scene', 'write_scene_code', 'regenerate_layer', 'add_layer'])

/**
 * Scene ids the direct-build rubric should review: those touched by a SUCCESSFUL
 * build tool this run (create / full rewrite / layer gen), order-preserving and
 * deduped. A build that was vetoed (success:false — e.g. a blank render the
 * pixel-truth gate already caught) is excluded, so the VLM isn't spent on a scene
 * already known broken. Exported for unit tests.
 */
export function collectRubricSceneIds(toolCalls: ToolCallRecord[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const tc of toolCalls) {
    if (!RUBRIC_BUILD_TOOLS.has(tc.toolName)) continue
    if (tc.output?.success !== true) continue
    const id = (tc.output as { affectedSceneId?: string } | undefined)?.affectedSceneId
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Gate for the direct-build aesthetic rubric. Off for sub-agents (covered by the
 * orchestrated cut review), when the user turned the setting off, on the
 * orchestrated (scenePlan) path, or when nothing was built. Exported for unit tests.
 */
export function shouldRunDirectRubric(args: {
  isSubAgent?: boolean
  aiQualityReview?: boolean
  hasScenePlan: boolean
  builtSceneCount: number
}): boolean {
  if (args.isSubAgent) return false
  if (args.aiQualityReview === false) return false
  if (args.hasScenePlan) return false
  return args.builtSceneCount > 0
}
