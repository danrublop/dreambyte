/**
 * Cross-scene continuity scan (a CROSS-scene SOFT signal, sibling to the
 * per-scene FLOW scan).
 *
 * The per-scene FLOW scan (`scanForFlow`, src/lib/generation/flow-scan.ts, wired in
 * tool-executor's quickValidateScene) only ever sees ONE scene's code. It cannot
 * tell that the WHOLE video is six motion scenes in a row, or that every cut uses
 * the same transition, or that a run of presenter scenes never moves the camera.
 * Those are sequence-level patterns. This scan runs over the full scene list and
 * emits the same kind of high-precision SOFT warning FLOW does: guidance surfaced
 * to the agent, NEVER a block and NEVER an auto-fix (mirrors RUBRIC/FLOW intent).
 *
 * Like FLOW: high precision over recall — only warn when a monotony pattern is
 * confidently present. Bounded output (at most one warning per rule, capped).
 * Gated to multi-scene videos (>1); a single scene is a no-op.
 *
 * It deliberately does NOT duplicate the per-scene FLOW checks. For the
 * narration-run rule it REUSES the per-scene FLOW `hasCameraMove` signal via the
 * injected `hasMotion` predicate (the orchestrator passes scanForFlow's result)
 * rather than re-deriving camera detection here.
 */

import type { Scene, SceneType } from '../types/scene'
import type { SceneSpec } from './types'

export interface CrossSceneReport {
  /** Length of the longest run of back-to-back identical sceneTypes. */
  maxConsecutiveSameType: number
  /** True when every scene in a multi-scene video is the same sceneType. */
  monotonePlan: boolean
  /** True when every cut between scenes uses the same (non-'none') transition. */
  monotoneTransition: boolean
  /** True when a run of >=3 narration scenes never moves the camera ("talking at slides"). */
  staticNarrationRun: boolean
  /** Soft, non-blocking guidance strings. Empty = nothing flagged. */
  warnings: string[]
}

/** 3+ back-to-back same sceneType is the threshold (2 in a row is fine). */
const MAX_CONSECUTIVE = 2
/** A run of this many narration-but-no-motion scenes reads as "talking at slides". */
const STATIC_NARRATION_RUN = 3

/**
 * Does this scene carry narration? Narration lives on the TTS sub-track of the
 * audio layer (set by add_narration). A bare enabled audioLayer without a tts
 * src is music/sfx, not narration — so key off tts.src specifically.
 */
function hasNarration(scene: Scene): boolean {
  return !!scene.audioLayer?.tts?.src
}

export interface CrossSceneOptions {
  /**
   * Per-scene motion predicate. The orchestrator passes the per-scene FLOW
   * verdict (scanForFlow(code).hasCameraMove) so the narration-run rule reuses
   * the SAME camera-detection the per-scene scan already computed instead of
   * duplicating it. When omitted, every scene is treated as "has motion" (so the
   * narration-run rule never false-fires without real motion data).
   */
  hasMotion?: (scene: Scene) => boolean
}

/**
 * Scan a full scene list for cross-scene monotony. SOFT signal only — returns
 * warnings; never throws, never blocks, never mutates a scene. No-op for <2
 * scenes. Bounded: at most one warning per rule.
 */
export function scanCrossSceneContinuity(scenes: Scene[], opts: CrossSceneOptions = {}): CrossSceneReport {
  const empty: CrossSceneReport = {
    maxConsecutiveSameType: scenes.length > 0 ? 1 : 0,
    monotonePlan: false,
    monotoneTransition: false,
    staticNarrationRun: false,
    warnings: [],
  }
  // Gate to multi-scene videos. A single scene (or none) has no cross-scene
  // pattern to read — no-op, exactly like FLOW returns empty for blank input.
  if (!Array.isArray(scenes) || scenes.length < 2) return empty

  const warnings: string[] = []
  const types = scenes.map((s) => s.sceneType)

  // ── Rule 1: no >2 consecutive same renderer/sceneType ────────────────────
  // Walk the run lengths; warn once on the FIRST run that exceeds the threshold.
  let maxConsecutiveSameType = 1
  let runLen = 1
  let runType: SceneType = types[0]
  let firstLongRunType: SceneType | null = null
  let firstLongRunLen = 0
  for (let i = 1; i < types.length; i++) {
    if (types[i] === types[i - 1]) {
      runLen++
    } else {
      runLen = 1
      runType = types[i]
    }
    if (runLen > maxConsecutiveSameType) maxConsecutiveSameType = runLen
    if (runLen > MAX_CONSECUTIVE && firstLongRunType === null) {
      firstLongRunType = runType
      firstLongRunLen = runLen
    }
  }
  if (firstLongRunType !== null) {
    warnings.push(
      `CONTINUITY: ${firstLongRunLen} consecutive ${firstLongRunType} scenes — vary the renderer so the sequence doesn't read monotonous (break it up with a data beat, a hand-drawn moment, or a different bridge).`,
    )
  }

  // ── Rule 2: monotone plan (every scene the same sceneType) ────────────────
  const monotonePlan = types.every((t) => t === types[0])
  // Don't double-warn: if rule 1 already covered the whole video as one long run,
  // the monotone-plan note is redundant. Only add it when rule 1 stayed quiet
  // (e.g. an A/B/A/B alternation isn't a long run but is also not monotone — in
  // that case monotonePlan is false anyway, so this only fires for the genuine
  // all-same case that rule 1 might NOT flag if a single short run... it always
  // flags all-same of length>=3, so this is the all-same-of-length-2 case).
  if (monotonePlan && firstLongRunType === null) {
    warnings.push(
      `CONTINUITY: every scene is the same type (${types[0]}) across ${scenes.length} scenes — introduce variety (a data beat, a hand-drawn moment, a 3D or chart change of pace) so the whole video doesn't feel like one note.`,
    )
  }

  // ── Rule 3: transition monotony (same transition between every cut) ───────
  // The transition on scene[i] is the transition INTO that scene (the cut from
  // i-1 → i), so the meaningful cuts are scenes[1..n-1]. 'none' (a hard cut) is
  // the neutral default — a run of plain cuts is not "monotony" worth flagging.
  const cutTransitions = scenes.slice(1).map((s) => s.transition)
  const monotoneTransition =
    cutTransitions.length >= 2 && cutTransitions.every((t) => t === cutTransitions[0]) && cutTransitions[0] !== 'none'
  if (monotoneTransition) {
    warnings.push(
      `CONTINUITY: every cut uses the same '${cutTransitions[0]}' transition — vary transitions (or use a hard cut) so the pacing doesn't feel mechanical.`,
    )
  }

  // ── Rule 4: narration-run continuity ("talking at slides") ───────────────
  // A run of >=3 scenes that all have narration but none have a camera/motion
  // beat reads as a voiceover over static slides. Reuse the per-scene FLOW
  // hasCameraMove signal (opts.hasMotion) — don't re-derive camera detection.
  const hasMotion = opts.hasMotion ?? (() => true)
  let narrationRun = 0
  let staticNarrationRun = false
  for (const scene of scenes) {
    if (hasNarration(scene) && !hasMotion(scene)) {
      narrationRun++
      if (narrationRun >= STATIC_NARRATION_RUN) {
        staticNarrationRun = true
        break
      }
    } else {
      narrationRun = 0
    }
  }
  if (staticNarrationRun) {
    warnings.push(
      `CONTINUITY: a run of ${STATIC_NARRATION_RUN}+ narration scenes with no camera move or motion — the video reads as a voiceover over static slides. Give at least some of these scenes a camera travel or kinetic beat so the visuals track the narration.`,
    )
  }

  return {
    maxConsecutiveSameType,
    monotonePlan,
    monotoneTransition,
    staticNarrationRun,
    warnings,
  }
}

/**
 * PLANNING-TIME continuity (the promotion of this scan's intent from a
 * post-hoc warning to an input each builder gets BEFORE it builds).
 *
 * `scanCrossSceneContinuity` above runs AFTER the cut is built and can only warn.
 * The disconnected-slideshow root cause is upstream: each scene's sub-agent
 * builds in isolation, blind to its neighbors (orchestrator buildSceneWithSubAgent
 * — context-isolated builders). This turns the neighboring SceneSpecs into a
 * directive block injected into the scene's builder prompt, so the opening
 * continues from the previous beat and the ending sets up the next — the
 * difference between a film and a slideshow.
 *
 * Uses the planner's EXPLICIT hand-off (`handoffToNext` type + `carriedElements`)
 * when present, and falls back to positional inference (name/purpose/camera)
 * when absent — so richer plans get sharper continuity while older/thin plans
 * still work. Pure string assembly, unit-testable for $0. Empty for a lone scene.
 */
const HANDOFF_TYPES = ['match-cut', 'zoom-into', 'hard-cut', 'motif-return'] as const
type HandoffType = (typeof HANDOFF_TYPES)[number]
function validHandoffType(t: unknown): t is HandoffType {
  return typeof t === 'string' && (HANDOFF_TYPES as readonly string[]).includes(t)
}
// How THIS scene OPENS, given how the PREVIOUS scene hands off to it.
const OPEN_FROM: Record<HandoffType, string> = {
  'match-cut': 'OPEN on the same shape/position the previous scene ended on (match cut)',
  'zoom-into': 'OPEN already pushed into the detail the previous scene zoomed toward',
  'motif-return': 'OPEN by bringing back the motif the previous scene set up',
  'hard-cut': 'a clean hard cut in — but still carry the previous palette and energy',
}
// How THIS scene ENDS, given how IT hands off to the next.
const END_INTO: Record<HandoffType, string> = {
  'match-cut': 'END framed so the next scene can match-cut from your final shape/position',
  'zoom-into': 'END pushed into the detail the next scene will open inside',
  'motif-return': 'END leaving the motif the next scene will bring back',
  'hard-cut': 'END cleanly; the next scene hard-cuts in',
}
const cleanList = (xs: string[] | undefined): string[] => (xs ?? []).map((e) => e.trim()).filter(Boolean)

// Bound the injected predecessor code so a heavy renderer scene (p90 ~49K chars)
// can't dominate the builder prompt. A truncated tail still carries the palette,
// type scale, and motion idioms the next scene must match; the note flags it.
const MAX_PREV_CODE_CHARS = 24_000

export function buildContinuityContext(
  prev: SceneSpec | null,
  next: SceneSpec | null,
  self?: SceneSpec | null,
  // The previous scene's ACTUAL built code (not its plan
  // spec). When present, the builder can SEE the real motifs/palette/motion of the
  // scene it continues from, instead of imagining them from the prose hand-off
  // above. Null when the predecessor isn't built yet (falls back to prose).
  prevBuiltCode?: string | null,
): string {
  if (!prev && !next && !prevBuiltCode) return '' // single-scene build — no neighbors to bridge
  const lines: string[] = ['## Continuity — this scene is ONE beat in a sequence, not a standalone slide']

  // FROM the previous beat (how to OPEN). Explicit hand-off on prev wins; else positional.
  if (prev) {
    const ho = prev.handoffToNext
    if (ho && validHandoffType(ho.type)) {
      const note = ho.note?.trim() ? ` — ${ho.note.trim()}` : ''
      lines.push(`- FROM "${prev.name}" (${prev.purpose}): ${OPEN_FROM[ho.type]}${note}.`)
    } else {
      const cam = prev.cameraMovement ? ` Its camera move was "${prev.cameraMovement}".` : ''
      lines.push(
        `- FROM the previous scene "${prev.name}" (${prev.purpose}).${cam} OPEN by continuing from where it left ` +
          `off — carry its visual motif, palette, and motion. Do NOT reset to a blank slate.`,
      )
    }
    const carried = cleanList(prev.carriedElements)
    if (carried.length) lines.push(`- CARRY IN these elements from it: ${carried.join(', ')}.`)
  } else {
    lines.push(
      '- This is the OPENING scene — establish the visual language (palette, motif, motion) the rest of the video will carry.',
    )
  }

  // INTO the next beat (how to END). Explicit hand-off on THIS scene wins; else positional.
  if (next) {
    const ho = self?.handoffToNext
    if (ho && validHandoffType(ho.type)) {
      const note = ho.note?.trim() ? ` — ${ho.note.trim()}` : ''
      lines.push(`- INTO "${next.name}" (${next.purpose}): ${END_INTO[ho.type]}${note}.`)
    } else {
      lines.push(
        `- INTO the next scene "${next.name}" (${next.purpose}). END on a beat that hands off to it — leave a ` +
          `motion, framing, or element the next scene can pick up, rather than fully resolving and going dark.`,
      )
    }
    const passOn = cleanList(self?.carriedElements)
    if (passOn.length) lines.push(`- PASS FORWARD to it: ${passOn.join(', ')}.`)
  } else {
    lines.push('- This is the FINAL scene — resolve the thread; no hand-off needed.')
  }

  // Feed the predecessor's REAL built code so the
  // builder matches observed motifs/palette/motion instead of re-deriving them
  // from the prose above (the "film vs slideshow" gap). Truncated head-first so
  // the imports + top-level component structure (where palette/type/motion live)
  // always survive the cap.
  const code = prevBuiltCode?.trim()
  if (code) {
    const clipped =
      code.length > MAX_PREV_CODE_CHARS
        ? `${code.slice(0, MAX_PREV_CODE_CHARS)}\n/* …truncated — match the palette, type scale, and motion idioms above */`
        : code
    lines.push(
      `\n## Previous scene's ACTUAL built code — you can SEE it; MATCH its real palette, ` +
        `type scale, motion, and recurring motifs so this scene reads as the same film. ` +
        `Do NOT reset to a blank slate:\n\`\`\`tsx\n${clipped}\n\`\`\``,
    )
  }

  return '\n\n' + lines.join('\n')
}

/**
 * Plan-time gate — REDUNDANCY scan over a freshly-produced ScenePlan.
 *
 * "Duplicate scenes" is one of the original top failure modes: the agent plans
 * the same beat twice, then builds two near-identical scenes (often one ends up
 * empty / erroring). scanCrossSceneContinuity can't catch this — every scene is
 * `react`, so its sceneType-monotony rule is moot, and it runs post-build anyway.
 * This runs at plan_scenes time, BEFORE any building, and surfaces redundant
 * beats as SOFT guidance so the agent merges/differentiates them up front.
 *
 * High precision (like FLOW): only flags an EXACT normalized name match or a very
 * high (>=80%) purpose token overlap. Bounded output. Pure. No-op for <2 scenes.
 */
function normalizeText(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function contentTokens(s: string | undefined): Set<string> {
  // Drop very short tokens (a/the/of/to…) so overlap reflects real content words.
  return new Set(
    normalizeText(s)
      .split(' ')
      .filter((w) => w.length > 2),
  )
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

const PURPOSE_DUP_THRESHOLD = 0.8
const MAX_REDUNDANCY_WARNINGS = 3

export function scanScenePlanForRedundancy(scenes: Array<{ name?: string; purpose?: string }>): {
  warnings: string[]
  duplicatePairs: Array<[number, number]>
} {
  const warnings: string[] = []
  const duplicatePairs: Array<[number, number]> = []
  if (!Array.isArray(scenes) || scenes.length < 2) return { warnings, duplicatePairs }

  const norm = scenes.map((s) => ({ name: normalizeText(s.name), purposeTokens: contentTokens(s.purpose) }))
  for (let i = 0; i < scenes.length; i++) {
    for (let j = i + 1; j < scenes.length; j++) {
      const sameName = norm[i].name.length > 0 && norm[i].name === norm[j].name
      const purposeSim = jaccard(norm[i].purposeTokens, norm[j].purposeTokens)
      if (!sameName && purposeSim < PURPOSE_DUP_THRESHOLD) continue
      duplicatePairs.push([i, j])
      const why = sameName
        ? `identical name "${scenes[i].name}"`
        : `near-identical purpose (${Math.round(purposeSim * 100)}% overlap)`
      warnings.push(
        `REDUNDANCY: scene ${i + 1} ("${scenes[i].name ?? '?'}") and scene ${j + 1} ("${scenes[j].name ?? '?'}") read as the ` +
          `same beat — ${why}. Merge them or give each a distinct purpose BEFORE building (duplicate scenes are a top failure mode).`,
      )
    }
  }
  return { warnings: warnings.slice(0, MAX_REDUNDANCY_WARNINGS), duplicatePairs }
}
