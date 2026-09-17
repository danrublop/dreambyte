/**
 * Cut review (Gap 2). The agent's "watch your own finished cut" pass.
 *
 * Given one representative frame per scene plus the LIVE timing/narration of the
 * current cut, run ONE VLM pass and return a structured cut-review brief
 * (pacing / redundancy / continuity / narration-sync findings). Reuses the
 * prompt-generic transport `sendFramesToVision` (frames-vision.ts) with its OWN
 * prompt + schema, and SURFACES failure (`reviewable:false`) rather than
 * swallowing it — an empty/failed vision call must never read as "clean cut".
 *
 * This module is pure + injectable: `buildCutReviewBrief` takes already-prepared
 * `KeyframeImage[]` and an injectable `send`. PRODUCTION-WIRED: the whole-cut pass
 * runs from the director loop's composite verify (runner.ts's makeDirectorReviewCut)
 * and the `review_video` tool; the per-scene motion pass via services/motion-review.ts.
 *
 * NOTE: review covers a representative-frame contact sheet + timing metadata, not
 * motion/transitions/audio-sync (no rendered MP4 exists mid-run).
 */

import type { KeyframeImage } from '../../services/video-understander'
import { parseFencedJson } from './intake-engines/parse-json'
import { sendFramesToVision, type FramesVisionDeps } from './intake-engines/frames-vision'
import { commitCost, refundCost, isOverCap, type RunCostLedger } from '../run-cost-ledger'
import { estimateAnalysisCost } from './multimodal-intake'

/** Live timing of one scene in the current cut (NOT the original scene plan). */
export interface CutSceneTiming {
  index: number
  name: string
  durationSec: number
  narration?: string
}

// Shared finding-kind union. The frame-based cut review (this file)
// emits pacing/redundancy/continuity/narration/other; the native-video motion
// review (motion-review.ts) emits motion/transition/sync. One type, two producers
// — so a consumer (coordinator, UI) handles every finding uniformly.
export type CutFindingKind =
  | 'pacing'
  | 'redundancy'
  | 'continuity'
  | 'narration'
  | 'motion'
  | 'transition'
  | 'sync'
  | 'other'
export type CutFindingSeverity = 'high' | 'medium' | 'low'

export interface CutReviewFinding {
  kind: CutFindingKind
  severity: CutFindingSeverity
  /** Scene index the finding refers to, when scene-specific. 0-based into the
   *  reviewed (captured) subset, NOT the original timeline. */
  scene?: number
  /** Real scene id the finding maps to, resolved from the reviewed subset by
   *  `reviewVideoFromCaptures`. Lets the cut-review coordinator fix the right
   *  scene directly, with no index math. Absent for cut-wide findings. */
  sceneId?: string
  /** Human-readable scene name, for surfacing the finding to the user. */
  sceneName?: string
  detail: string
}

export interface CutReviewBrief {
  /** False when the cut could not be reviewed (no/too-few frames, transport
   *  failure, empty/garbage model output). NEVER a silent pass. */
  reviewable: boolean
  summary?: string
  findings: CutReviewFinding[]
  /** Why it wasn't reviewable, or any caveat. */
  note?: string
  /** The scene ids actually reviewed, in frame order. A finding's `scene` is a
   *  0-based index into this array, so a consumer can map it to a real scene
   *  (the model only ever saw the sampled subset, not original timeline indices). */
  reviewedSceneIds?: string[]
}

const VALID_KINDS: CutFindingKind[] = ['pacing', 'redundancy', 'continuity', 'narration', 'other']
const VALID_SEVERITIES: CutFindingSeverity[] = ['high', 'medium', 'low']

/** Neutralize agent/user-authored text before interpolating it into the prompt:
 *  collapse whitespace, strip quotes/backticks/braces AND angle brackets, and bound
 *  length. Defense-in-depth — the output is already enum-validated + non-executable,
 *  but narration/name are model-authored. Angle brackets are stripped so embedded
 *  markup like `</scene_metadata>` can't close a fenced data block early and smuggle
 *  the rest of the text in as trusted prompt instructions (motion-review fence). */
export function sanitizeForPrompt(s: string, max = 240): string {
  return s
    .replace(/[`"{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Build the cut-review prompt. The model sees one frame per scene, in order. */
export function cutReviewPrompt(timing: CutSceneTiming[]): string {
  const sceneLines = timing
    .map((s) => {
      const narr = s.narration ? ` — narration: "${sanitizeForPrompt(s.narration)}"` : ''
      return `  frame ${s.index + 1}: "${sanitizeForPrompt(s.name, 80)}" (${s.durationSec.toFixed(1)}s)${narr}`
    })
    .join('\n')
  const total = timing.reduce((sum, s) => sum + s.durationSec, 0)

  return `You are reviewing a finished explainer-video cut. You are shown ONE representative still frame per scene, in playback order. You cannot see motion or transitions — judge composition, sequencing, and how the frames read as a whole.

The cut has ${timing.length} scene(s), ${total.toFixed(1)}s total:
${sceneLines}

Review for:
- pacing: scenes that read as too long/short for their content, or uneven rhythm across the cut
- redundancy: scenes that repeat the same visual or message without adding information
- continuity: jarring jumps in style, color, layout, or typography between adjacent scenes
- narration: on-screen content that contradicts or fails to support the scene's narration

Return ONLY a JSON object, no prose or markdown:
{
  "summary": "<one or two sentences on how the cut reads overall>",
  "findings": [
    { "kind": "pacing|redundancy|continuity|narration|other", "severity": "high|medium|low", "scene": <1-based frame number or omit if cut-wide>, "detail": "<specific, actionable observation>" }
  ]
}
If the cut reads well, return an empty findings array. Keep findings specific and actionable.`
}

/**
 * Parse the model's cut-review JSON into a brief. Unparseable/empty → not reviewable.
 * A response missing the `findings` array is treated as the WRONG SHAPE (e.g. `{}`,
 * `{error}`, or the intake `{scene,events}` shape from a mis-routed engine) → NOT
 * reviewable, so a failed/garbage call can never read as a clean cut. A genuinely
 * clean cut returns `findings: []` (the array is present).
 * `sceneCount` (when given) upper-bounds the scene index so the model can't
 * mis-attribute a finding to a nonexistent scene.
 */
export function parseCutReview(raw: string, sceneCount?: number): CutReviewBrief {
  const parsed = parseFencedJson<{
    summary?: unknown
    findings?: { kind?: unknown; severity?: unknown; scene?: unknown; detail?: unknown }[]
  }>(raw)
  if (!parsed) {
    return { reviewable: false, findings: [], note: 'Could not parse the cut-review model output.' }
  }
  if (!Array.isArray(parsed.findings)) {
    // Not the cut-review schema — refuse rather than report a false clean pass.
    return { reviewable: false, findings: [], note: 'Unexpected cut-review response shape (no findings array).' }
  }
  const findings: CutReviewFinding[] = parsed.findings
    .filter((f) => typeof f?.detail === 'string' && f.detail.trim().length > 0)
    .map((f) => {
      const kind = VALID_KINDS.includes(f.kind as CutFindingKind) ? (f.kind as CutFindingKind) : 'other'
      const severity = VALID_SEVERITIES.includes(f.severity as CutFindingSeverity)
        ? (f.severity as CutFindingSeverity)
        : 'medium'
      const sceneNum = Number(f.scene)
      // Prompt asks for 1-based frame numbers; store 0-based index. Drop out-of-range
      // numbers (→ cut-wide) so a bogus "scene 99" never mis-attributes a finding.
      const inRange = Number.isFinite(sceneNum) && sceneNum >= 1 && (sceneCount === undefined || sceneNum <= sceneCount)
      const scene = inRange ? sceneNum - 1 : undefined
      return { kind, severity, ...(scene !== undefined ? { scene } : {}), detail: String(f.detail).trim() }
    })
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() || undefined : undefined
  return { reviewable: true, summary, findings }
}

export interface CutReviewDeps extends FramesVisionDeps {
  /** Injectable transport (defaults to the real sendFramesToVision) for tests. */
  send?: typeof sendFramesToVision
  /** Minimum frames required to produce a review. Below this → not reviewable. */
  minFrames?: number
  /**
   * Override the review prompt. Defaults to `cutReviewPrompt` (one still per scene).
   * The director's composite verify passes MULTIPLE frames per scene (motion +
   * transition-boundary samples), so it supplies a boundary-aware prompt here while
   * reusing this function's transport, frame/timing guard, and honest-skip parsing.
   */
  promptOverride?: (timing: CutSceneTiming[]) => string
}

/**
 * Run the cut-review pass. Returns a structured brief; `reviewable:false` (with a
 * `note`) on too-few frames, transport failure, or empty/garbage output — never a
 * silent pass. Cost gating + frame capture/downsample live in the caller (runner).
 */
export async function buildCutReviewBrief(
  frames: KeyframeImage[],
  timing: CutSceneTiming[],
  engineId: string,
  deps: CutReviewDeps = {},
): Promise<CutReviewBrief> {
  const minFrames = deps.minFrames ?? 1
  if (frames.length < minFrames) {
    return {
      reviewable: false,
      findings: [],
      note: `Too few frames to review the cut (${frames.length}/${minFrames}).`,
    }
  }
  // Frame i must correspond to timing[i] — the prompt labels "frame N: scene X".
  // A mismatch (e.g. a partial capture left frames/timing out of sync) would
  // mis-map the model's findings, so refuse rather than review a skewed cut.
  if (frames.length !== timing.length) {
    return {
      reviewable: false,
      findings: [],
      note: `Frame/scene count mismatch (${frames.length} frames vs ${timing.length} scenes) — cannot map findings reliably.`,
    }
  }
  const send = deps.send ?? sendFramesToVision
  const prompt = deps.promptOverride ? deps.promptOverride(timing) : cutReviewPrompt(timing)
  let raw: string
  try {
    raw = await send(frames, prompt, engineId, deps)
  } catch (err) {
    return { reviewable: false, findings: [], note: `Cut-review vision call failed: ${(err as Error).message}` }
  }
  if (!raw.trim()) {
    return { reviewable: false, findings: [], note: 'The vision model returned an empty response.' }
  }
  return parseCutReview(raw, timing.length)
}

export interface ReviewVideoDeps extends CutReviewDeps {
  /** Capture one rendered frame for a scene at `timeSec`. The runner wraps
   *  captureOneFrame+emit; null = capture failed/timed out (that scene is dropped). */
  capture: (sceneId: string, timeSec: number) => Promise<{ dataUri: string; mimeType: string } | null>
  /** Shared run cost ledger — projected-gated before the VLM call, committed after. */
  costLedger?: RunCostLedger
  /** Max image dimension for downsampling captured frames (default in downsampleFrame). */
  downsampleMaxDim?: number
  abortSignal?: { aborted: boolean }
}

/**
 * Orchestrate a full cut review from the live (already-capped) scene set: capture
 * one representative mid-scene frame per scene, decode + downsample, then run
 * `buildCutReviewBrief`. Projected-cost gated (won't start a VLM call that would
 * cross the run cap) and cost-committed after. Failed captures are dropped and
 * timing realigned so frames↔scenes stay 1:1. Returns `reviewable:false` (never a
 * silent clean pass) when budget/frames don't allow an honest review.
 *
 * `sceneIds[i]` must correspond to `timing[i]`. The caller (review_video handler)
 * caps the count to MAX_REVIEW_FRAMES before calling.
 */
export async function reviewVideoFromCaptures(
  sceneIds: string[],
  timing: CutSceneTiming[],
  engineId: string,
  deps: ReviewVideoDeps,
): Promise<CutReviewBrief> {
  const backend = `frame-vision:${engineId}`
  const ledger = deps.costLedger
  const minFrames = deps.minFrames ?? 2
  // Nothing to compare → don't waste a capture round-trip on a doomed review.
  if (sceneIds.length < minFrames) {
    return {
      reviewable: false,
      findings: [],
      note: `The cut has too few scenes to review (${sceneIds.length}/${minFrames}).`,
    }
  }
  // Projected-spend gate: don't even capture if the VLM call would cross the
  // cap. Early skip only — the binding recheck+RESERVE happens right before
  // the VLM call (the capture loop awaits, so a reservation here would not
  // be race-free anyway).
  const est = estimateAnalysisCost(backend)
  if (ledger && (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd)) {
    return { reviewable: false, findings: [], note: 'Skipped cut review — would exceed the run cost cap.' }
  }

  const frames: KeyframeImage[] = []
  const kept: CutSceneTiming[] = []
  const keptSceneIds: string[] = []
  for (let i = 0; i < sceneIds.length; i++) {
    if (deps.abortSignal?.aborted) break
    const timeSec = Math.max(0, (timing[i]?.durationSec ?? 2) / 2) // representative mid-scene frame
    const cap = await deps.capture(sceneIds[i], timeSec)
    if (!cap) continue
    const kf = dataUriToKeyframe(cap.dataUri, timeSec)
    if (!kf) continue
    frames.push(await downsampleFrame(kf, deps.downsampleMaxDim))
    kept.push({ ...timing[i], index: kept.length }) // realign index to capture order
    keptSceneIds.push(sceneIds[i])
  }

  if (frames.length < minFrames) {
    return {
      reviewable: false,
      findings: [],
      note: `Captured too few frames to review the cut (${frames.length}/${minFrames}).`,
    }
  }
  // Aborted during capture — don't spend on a VLM call the user cancelled.
  if (deps.abortSignal?.aborted) {
    return { reviewable: false, findings: [], note: 'Cut review aborted before the vision pass.' }
  }
  // Atomic recheck+RESERVE before the await (R4 follow-up): no await between
  // the check and the commit, so a concurrent burst of reviews can't all pass
  // the gate before any reserves. The charge-only-on-success policy survives
  // as the NET outcome: buildCutReviewBrief returns reviewable:false for
  // thrown transport errors (never billed by the provider), and that path
  // refunds the reservation.
  if (ledger) {
    if (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd) {
      return { reviewable: false, findings: [], note: 'Skipped cut review — would exceed the run cost cap.' }
    }
    commitCost(ledger, est)
  }
  const brief = await buildCutReviewBrief(frames, kept, engineId, deps)
  if (ledger && !brief.reviewable) refundCost(ledger, est)
  // Resolve each scene-specific finding to a real scene id/name from the reviewed
  // subset. `finding.scene` is a 0-based index into `kept`/`keptSceneIds` (frame
  // order), so the coordinator can fix by sceneId with no index math. Defensive:
  // an index with no corresponding id stays cut-wide rather than mis-attributing.
  const findings = brief.findings.map((f) => {
    if (f.scene === undefined) return f
    const sceneId = keptSceneIds[f.scene]
    if (sceneId === undefined) return f
    const sceneName = kept[f.scene]?.name
    return { ...f, sceneId, ...(sceneName ? { sceneName } : {}) }
  })
  return { ...brief, findings, reviewedSceneIds: keptSceneIds }
}

/** Decode an agent capture_frame data URI into a KeyframeImage. Null on malformed
 *  input OR a payload that base64-decodes to nothing — `Buffer.from(_, 'base64')`
 *  silently truncates invalid input instead of throwing, so a zero-length decode is
 *  the real signal that the data URI was corrupt (otherwise a broken frame reaches the VLM). */
export function dataUriToKeyframe(dataUri: string, timeSec: number): KeyframeImage | null {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUri ?? '')
  if (!m) return null
  try {
    const bytes = new Uint8Array(Buffer.from(m[2], 'base64'))
    if (bytes.length === 0) return null
    return { timeSec, mimeType: m[1], bytes }
  } catch {
    return null
  }
}

/**
 * Downsample/compress a captured frame before the VLM (full-stage Pixi PNGs can
 * hit provider image-size/cost limits). Degrades to the original frame on any
 * failure so a missing/broken sharp never blocks the review.
 */
export async function downsampleFrame(frame: KeyframeImage, maxDim = 768): Promise<KeyframeImage> {
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(Buffer.from(frame.bytes))
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      // Capture frames are stage PNGs that may carry alpha; JPEG has no alpha and
      // sharp would composite onto black, showing the VLM a frame the user never
      // sees. Flatten onto white first so transparency reads as a neutral background.
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer()
    return { ...frame, bytes: new Uint8Array(out), mimeType: 'image/jpeg' }
  } catch {
    return frame
  }
}
