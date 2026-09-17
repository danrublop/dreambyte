/**
 * Composite verify.
 *
 * The existing cut review (reviewVideoFromCaptures) samples ONE representative
 * mid-scene still per scene, and its prompt tells the VLM outright: "You cannot see
 * motion or transitions." But the flagged Phase-2 requirement (outside-voice #5) is
 * that cross-scene incoherence is TEMPORAL — a jarring cut, a motif that fails to carry,
 * a hand-off that resolves to black — and a mid-scene still can't see any of it.
 *
 * Composite verify samples the cut where the seams actually are: a motion frame at each
 * scene's middle PLUS a pair straddling every transition boundary (the outgoing scene's
 * tail and the incoming scene's head), ordered so the filmstrip reads in cut order —
 * …A.tail, B.head… — i.e. the VLM literally sees each cut. It reuses the shipped capture
 * transport, cost gating, downsample, and honest-skip of buildCutReviewBrief; only the
 * sample plan and the prompt are new.
 *
 * The true composited BLEND frame (one host page stacking both scenes mid-crossfade)
 * needs the Electron composite host and is a follow-up refinement — the tail/head PAIR
 * already lets the model judge whether the cut carries motif, palette, and motion.
 */

import type { KeyframeImage } from '../../services/video-understander'
import { isOverCap, commitCost, refundCost } from '../run-cost-ledger'
import { estimateAnalysisCost } from './multimodal-intake'
import {
  type CutSceneTiming,
  type CutReviewBrief,
  type ReviewVideoDeps,
  buildCutReviewBrief,
  dataUriToKeyframe,
  downsampleFrame,
  sanitizeForPrompt,
} from './cut-review'

/** One frame the composite verify will capture: a scene id + the LOCAL time within that
 *  scene to render, and why (a mid-scene motion frame, or a transition-boundary frame). */
export interface CompositeVerifySample {
  sceneId: string
  /** 0-based index into the ORIGINAL ordered scene list (for labelling / mapping back). */
  sceneIndex: number
  /** Local time within the scene to capture, seconds. */
  timeSec: number
  kind: 'motion' | 'transition-out' | 'transition-in'
  /** Human label for the prompt ("Scene 2 → entering", etc.). */
  label: string
}

export interface CompositeVerifyScene {
  sceneId: string
  name: string
  durationSec: number
  narration?: string
}

/**
 * Plan the temporal sample set for a cut. PURE — no capture, no VLM. For each scene:
 * a `motion` frame at its midpoint. For each cut between adjacent scenes: a
 * `transition-out` on the outgoing scene's tail and a `transition-in` on the incoming
 * scene's head, emitted adjacently so the filmstrip shows the cut. A single scene yields
 * just its motion frame (nothing to transition between).
 */
export function planCompositeVerifySamples(
  scenes: CompositeVerifyScene[],
  opts: { tailFrac?: number; headFrac?: number } = {},
): CompositeVerifySample[] {
  // Fraction of a scene's duration from its END (tail) / START (head) to sample the
  // boundary. Defaults land close to the cut without risking a not-yet-mounted first
  // frame or an already-ended last frame.
  const tailFrac = Math.min(0.49, Math.max(0, opts.tailFrac ?? 0.12))
  const headFrac = Math.min(0.49, Math.max(0, opts.headFrac ?? 0.1))

  const at = (durationSec: number, frac: number) => {
    const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 2
    // Clamp inside [0, d) so a capture never lands exactly on the scene boundary.
    return Math.min(Math.max(0, frac) * d, Math.max(0, d - 0.001))
  }

  const samples: CompositeVerifySample[] = []
  scenes.forEach((scene, i) => {
    // Entering this scene (head) — the incoming half of the cut from the previous scene.
    if (i > 0) {
      samples.push({
        sceneId: scene.sceneId,
        sceneIndex: i,
        timeSec: at(scene.durationSec, headFrac),
        kind: 'transition-in',
        label: `Scene ${i + 1} "${scene.name}" — entering (cut from Scene ${i})`,
      })
    }
    // Mid-scene motion frame.
    samples.push({
      sceneId: scene.sceneId,
      sceneIndex: i,
      timeSec: at(scene.durationSec, 0.5),
      kind: 'motion',
      label: `Scene ${i + 1} "${scene.name}" — mid`,
    })
    // Leaving this scene (tail) — the outgoing half of the cut into the next scene.
    if (i < scenes.length - 1) {
      samples.push({
        sceneId: scene.sceneId,
        sceneIndex: i,
        timeSec: at(scene.durationSec, 1 - tailFrac),
        kind: 'transition-out',
        label: `Scene ${i + 1} "${scene.name}" — leaving (cut to Scene ${i + 2})`,
      })
    }
  })
  return samples
}

/** Boundary-aware review prompt. Unlike cutReviewPrompt ("one still per scene, you
 *  cannot see transitions"), this tells the VLM the frames straddle the cuts and asks
 *  it to judge the seams temporally. `timing[i]` corresponds to `frames[i]`. */
export function compositeVerifyPrompt(timing: CutSceneTiming[]): string {
  const lines = timing
    .map((s) => `  frame ${s.index + 1}: ${sanitizeForPrompt(s.name, 90)} (${s.durationSec.toFixed(1)}s scene)`)
    .join('\n')
  return `You are reviewing a finished multi-scene video as ONE continuous film. You are shown frames sampled ALONG the cut, in playback order: a mid-scene frame for each scene, PLUS frames straddling every transition (the outgoing scene's tail immediately followed by the incoming scene's head). Adjacent "leaving"/"entering" frames are the SAME cut — judge whether it reads as one film or a jarring reset.

Frames, in order:
${lines}

Review for:
- continuity: a motif, subject, palette, or type scale that fails to carry across a cut; a scene that resets to a blank slate the previous one didn't lead into
- transition: a hand-off that resolves to black / dead-stops instead of leading into the next scene; two adjacent scenes that clash in style, color, or layout
- pacing: a scene that reads as too long/short for its content, or uneven rhythm across the cut
- redundancy: adjacent scenes repeating the same visual or message without adding information

Return ONLY a JSON object, no prose or markdown:
{"summary":"one sentence on how the cut reads as a whole","findings":[{"kind":"continuity|transition|pacing|redundancy|other","severity":"high|medium|low","scene":<1-based frame number or omit for cut-wide>,"detail":"what and where"}]}`
}

/**
 * Run the composite (temporal) cut review. Mirrors reviewVideoFromCaptures — same cost
 * gate, capture-and-drop, honest-skip — but captures the boundary+motion sample set and
 * uses the boundary-aware prompt. Findings' `scene` (a 0-based index into the captured
 * frame order) is resolved back to a real sceneId so the director can fix the right scene.
 */
export async function reviewCutTemporally(
  scenes: CompositeVerifyScene[],
  engineId: string,
  deps: ReviewVideoDeps,
): Promise<CutReviewBrief> {
  const backend = `frame-vision:${engineId}`
  const ledger = deps.costLedger
  const minFrames = deps.minFrames ?? 2

  if (scenes.length < 2) {
    return {
      reviewable: false,
      findings: [],
      note: `The cut has too few scenes for a temporal review (${scenes.length}/2).`,
    }
  }

  const samples = planCompositeVerifySamples(scenes)

  // Projected-spend gate (early skip; the binding recheck+reserve is right before the VLM call).
  const est = estimateAnalysisCost(backend)
  if (ledger && (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd)) {
    return { reviewable: false, findings: [], note: 'Skipped composite verify — would exceed the run cost cap.' }
  }

  const frames: KeyframeImage[] = []
  const kept: CutSceneTiming[] = []
  const keptSceneIds: string[] = []
  for (const sample of samples) {
    if (deps.abortSignal?.aborted) break
    const cap = await deps.capture(sample.sceneId, sample.timeSec)
    if (!cap) continue
    const kf = dataUriToKeyframe(cap.dataUri, sample.timeSec)
    if (!kf) continue
    frames.push(await downsampleFrame(kf, deps.downsampleMaxDim))
    const scene = scenes[sample.sceneIndex]
    kept.push({
      index: kept.length,
      name: sample.label,
      durationSec: scene?.durationSec ?? 2,
      narration: scene?.narration,
    })
    keptSceneIds.push(sample.sceneId)
  }

  if (frames.length < minFrames) {
    return {
      reviewable: false,
      findings: [],
      note: `Captured too few frames for a temporal review (${frames.length}/${minFrames}).`,
    }
  }
  if (deps.abortSignal?.aborted) {
    return { reviewable: false, findings: [], note: 'Composite verify aborted before the vision pass.' }
  }

  // Atomic recheck+reserve before the await (matches reviewVideoFromCaptures).
  if (ledger) {
    if (isOverCap(ledger) || ledger.spentUsd + est > ledger.capUsd) {
      return { reviewable: false, findings: [], note: 'Skipped composite verify — would exceed the run cost cap.' }
    }
    commitCost(ledger, est)
  }
  const brief = await buildCutReviewBrief(frames, kept, engineId, { ...deps, promptOverride: compositeVerifyPrompt })
  if (ledger && !brief.reviewable) refundCost(ledger, est)

  // Map a finding's frame index → the real sceneId that frame was sampled from.
  const findings = brief.findings.map((f) => {
    if (f.scene === undefined) return f
    const sceneId = keptSceneIds[f.scene]
    if (sceneId === undefined) return f
    const sceneName = scenes.find((s) => s.sceneId === sceneId)?.name
    return { ...f, sceneId, ...(sceneName ? { sceneName } : {}) }
  })
  return { ...brief, findings, reviewedSceneIds: keptSceneIds }
}
