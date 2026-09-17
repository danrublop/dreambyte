/**
 * Benchmark scoring contract — the offline instrument.
 *
 * This scores a FINISHED agent run against DEFECT / STRUCTURAL assertions only.
 * It deliberately makes NO taste judgment ("is this good?"): quality is built in
 * upstream by the generation substrate, and the agent's own runtime review catches
 * visual defects; THIS module is the offline instrument that checks whether the
 * generation substrate is holding.
 *
 * The hard gate is REAL RENDER HEALTH — the failures a user actually hits:
 *   1. the scene errors / won't play (a runtime/syntax throw, a hung loop, a
 *      failed load) — surfaced by the app's own verifier as `status: 'errored'`,
 *   2. it renders but the frame is blank / all images broke,
 *   3. structural loss (didn't persist, N-of-N miss, empty shell, wrong intent).
 * Element misplacement (off-frame overflow) and AI-slop tells are reported as
 * ADVISORIES — surfaced, but not pass/fail (overflow has real false positives; an
 * off-screen element is sometimes intentional, and slop is a taste signal we
 * deliberately don't gate on here).
 *
 * The render-health signal is produced by the SAME code the live app runs
 * (src/lib/services/scene-verifier.ts, via the offscreen render step in run.ts) — so
 * "the benchmark says broken" is the same verdict as "the app shows an error",
 * no drift. `evaluateRenderBlock` (the blank/broken policy) is reused directly.
 *
 * Pure and synchronous over a normalized input so it is trivially unit-testable
 * and independent of the DB schema (the runner does row → BenchmarkScene mapping,
 * and the electron render step → SceneRenderHealth mapping).
 */
import { scanForSlop } from '@/lib/generation/slop-scan'
import { hasTimeDrivenMotion } from '@/lib/generation/flow-scan'
import {
  evaluateRenderBlock,
  type SceneFrameTruth,
  type SceneOverflow,
  type SceneVerifyStatus,
} from '@/lib/services/scene-verifier'

/**
 * The subset of the app verifier's `SceneVerifyOutcome` the scorer consumes,
 * mapped out of the electron render step by the runner. Present only when the
 * offscreen render actually ran; absent (undefined) when there was no render
 * pass at all.
 */
export interface SceneRenderHealth {
  /** Verifier status. `errored` = the scene threw / hung / failed to load (the
   *  "app shows an error" case). `unknown` = the render couldn't be measured
   *  (no Electron / capture gap) — the render gate is SKIPPED for this scene,
   *  never a silent pass. */
  status: SceneVerifyStatus
  /** Populated when `status === 'errored'`: the failure class + message. */
  errorKind?: string
  errorMessage?: string
  /** Pixel-truth of the settled frame (blank / broken-image detection). Present
   *  when the scene verified and the capture ran. */
  frame?: SceneFrameTruth
  /** Leaf text/elements spilling past the frame edges (misplacement). Advisory. */
  overflows?: SceneOverflow[]
}

/** One scene, normalized out of the persisted DB row by the runner. */
export interface BenchmarkScene {
  id: string
  /** Primary code-bearing content (reactCode / sceneCode / canvasCode / svgContent). '' if none. */
  code: string
  /** True when the scene carries a narration / audio layer (structural check, not audio decode). */
  hasNarration: boolean
  /** True when the persisted content is still a placeholder / empty agent shell. */
  isPlaceholder: boolean
  /** True when the scene carries placed image/video/avatar imagery (any source:
   *  AI-gen, stock, or upload). Used by the expectImagery assertion. */
  hasImagery: boolean
  /** Real render health from the offscreen verifier pass. Undefined when no
   *  render pass ran for this scene (the gate then reports as skipped). */
  render?: SceneRenderHealth
}

export interface BenchmarkCase {
  id: string
  minScenes: number
  expectNarration: boolean
  expectVideoType?: string
  /** The prompt asks for real imagery — assert the agent could EMIT an AI-gen tool
   *  (generate_image / generate_veo3_video) and that imagery actually landed. This is
   *  the end-to-end proof that the media-gen unblock works, not just that a schema exists. */
  expectImagery?: boolean
}

/** What the runner observed from the live run + the DB read-back. */
export interface RunObservation {
  /** Scenes the agent's plan_scenes committed to (0 when no plan was surfaced). */
  plannedCount: number
  /** persist_done.persistOk — did the scenes actually land in the table. */
  persistOk: boolean
  /** The agent's resolved videoType from the persisted ProjectBrief (undefined
   *  when no brief was persisted — then the alignment check is skipped). */
  resolvedVideoType?: string
  /** Tool names the agent actually emitted this run (from tool_complete events).
   *  Used by expectImagery to confirm an AI-gen tool was reachable + called. */
  emittedTools?: string[]
  /** Scenes read back from the DB after the run. */
  scenes: BenchmarkScene[]
}

export type DefectKind =
  | 'not-persisted' // persist_done reported persistOk:false — durable-state loss
  | 'missing-scenes' // fewer renderable scenes than the plan committed to (N-of-N miss)
  | 'below-min-scenes' // fewer renderable scenes than the case requires
  | 'empty-shell' // a scene persisted as a placeholder / never got code
  | 'missing-narration' // case expects narration but no scene carries it
  | 'wrong-video-type' // the agent read the prompt as a different video type than the case expects (intent misalignment)
  | 'render-error' // the scene errored / won't play (runtime/syntax throw, hung loop, failed load)
  | 'blank-render' // the scene ran but rendered an essentially blank frame
  | 'broken-images' // every image in the scene failed to load
  | 'no-flow' // no time-driven motion — the scene renders as a static slide (matches the shipped FLOW gate)
  | 'missing-imagery' // case expects real imagery but no AI-gen tool was emitted / no imagery landed (the media-gen unblock regressed)

export interface Defect {
  sceneId: string | null
  kind: DefectKind
  detail: string
}

/** Non-gating signals: surfaced in the report so we can SEE them, but they never
 *  fail a case. `overflow` = misplaced/off-frame elements; `slop` = AI-slop code
 *  tells (a taste signal, deliberately not a hard gate here). */
export type AdvisoryKind = 'overflow' | 'slop'

export interface Advisory {
  sceneId: string | null
  kind: AdvisoryKind
  detail: string
}

export interface BenchmarkScore {
  caseId: string
  planned: number
  persisted: number
  renderable: number
  landedAllPlanned: boolean
  meetsMinScenes: boolean
  narrationOk: boolean
  /** No blank/broken/errored scenes, no empty shells, and every renderable scene
   *  clears the static motion floor. */
  structuralFloorClear: boolean
  /** True when the offscreen render actually measured at least one renderable
   *  scene (status !== 'unknown'). False = no render pass ran or every scene was
   *  unmeasurable — the render defects (error/blank/broken) were NOT checked, so
   *  a pass here is weaker. Surfaced honestly, never a silent pass. */
  renderGateApplied: boolean
  defects: Defect[]
  advisories: Advisory[]
  /** Hard pass: all defect classes clear. This is the CI-gating boolean. */
  passed: boolean
}

/**
 * Score one finished case. `scanForSlop` / `hasTimeDrivenMotion` are the same
 * static scanners the runtime uses (src/lib/generation); `evaluateRenderBlock` is the
 * exact blank/broken policy the live render veto uses (src/lib/services/scene-verifier)
 * — reusing them keeps the offline floor identical to the shipped floor, just
 * enforced here as a hard gate on the finished artifact.
 */
export function scoreBenchmark(caseDef: BenchmarkCase, obs: RunObservation): BenchmarkScore {
  const defects: Defect[] = []
  const advisories: Advisory[] = []

  const renderableScenes = obs.scenes.filter((s) => s.code.trim().length > 0 && !s.isPlaceholder)
  const emptyShells = obs.scenes.filter((s) => s.isPlaceholder || s.code.trim().length === 0)

  // 1) Durable-state landing (runtime defect class, verified from the outside).
  if (!obs.persistOk) {
    defects.push({ sceneId: null, kind: 'not-persisted', detail: 'persist_done reported persistOk:false' })
  }

  // 2) N-of-N: every scene the plan committed to must have landed with content.
  const landedAllPlanned = obs.plannedCount === 0 || renderableScenes.length >= obs.plannedCount
  if (!landedAllPlanned) {
    defects.push({
      sceneId: null,
      kind: 'missing-scenes',
      detail: `planned ${obs.plannedCount}, only ${renderableScenes.length} renderable landed`,
    })
  }

  // 3) The case's own floor on scene count.
  const meetsMinScenes = renderableScenes.length >= caseDef.minScenes
  if (!meetsMinScenes) {
    defects.push({
      sceneId: null,
      kind: 'below-min-scenes',
      detail: `expected >= ${caseDef.minScenes} renderable scenes, got ${renderableScenes.length}`,
    })
  }

  // 4) No blank / placeholder scenes persisted.
  for (const shell of emptyShells) {
    defects.push({ sceneId: shell.id, kind: 'empty-shell', detail: 'persisted with no renderable code' })
  }

  // 5) Narration present when the case expects it (structural, not an audio decode).
  const narrationOk = !caseDef.expectNarration || obs.scenes.some((s) => s.hasNarration)
  if (!narrationOk) {
    defects.push({ sceneId: null, kind: 'missing-narration', detail: 'case expects narration; no scene carries it' })
  }

  // 5c) Imagery unblock (end-to-end) — when the prompt asks for real imagery, prove
  // the agent could EMIT an AI-gen tool AND that imagery actually landed on a scene.
  // This is the assertion the old "phantom tools" bug would fail: the schema existed
  // in no list, so the model could never emit generate_image and every imagery brief
  // silently fell back to CSS. Emitted-tool OR placed-imagery both count (in sandbox the
  // gen tool places a placeholder asset; a stock/library path places without generate_*).
  if (caseDef.expectImagery) {
    const GEN_TOOLS = new Set(['generate_image', 'generate_sticker', 'generate_veo3_video'])
    const emittedGen = (obs.emittedTools ?? []).some((t) => GEN_TOOLS.has(t))
    const imageryLanded = obs.scenes.some((s) => s.hasImagery)
    if (!emittedGen && !imageryLanded) {
      defects.push({
        sceneId: null,
        kind: 'missing-imagery',
        detail: 'case expects imagery; agent emitted no AI-gen tool and no scene carries placed imagery',
      })
    }
  }

  // 5b) Intent alignment — did the agent read the prompt as the expected video
  // type. Skipped when the case declares no expectation or no brief was persisted.
  if (caseDef.expectVideoType && obs.resolvedVideoType && obs.resolvedVideoType !== caseDef.expectVideoType) {
    defects.push({
      sceneId: null,
      kind: 'wrong-video-type',
      detail: `expected videoType "${caseDef.expectVideoType}", agent read it as "${obs.resolvedVideoType}"`,
    })
  }

  // 6) REAL RENDER HEALTH — the failures a user actually hits. Each renderable
  // scene is run through the app's own verifier (offscreen, in run.ts) and the
  // outcome graded here:
  //   - errored  → the scene won't play (throw / hang / failed load) — HARD FAIL
  //   - blank / all-broken-images (evaluateRenderBlock) — HARD FAIL
  //   - overflow (misplaced/off-frame) — ADVISORY
  // `unknown` (couldn't measure) is a SKIP, never a pass. A scene with no
  // `render` at all was not part of any render pass — also skipped here.
  let renderMeasured = 0
  for (const scene of renderableScenes) {
    const r = scene.render
    if (!r || r.status === 'unknown') continue // unmeasured — skip, do not pass
    renderMeasured++

    if (r.status === 'errored') {
      const kind = r.errorKind ? `${r.errorKind}: ` : ''
      defects.push({
        sceneId: scene.id,
        kind: 'render-error',
        detail: `${kind}${r.errorMessage ?? 'scene errored — will not play'}`.slice(0, 300),
      })
      continue // an errored scene has no meaningful frame to grade
    }

    if (r.frame) {
      const block = evaluateRenderBlock(r.frame)
      if (block) {
        defects.push({
          sceneId: scene.id,
          kind: block.kind === 'broken-images' ? 'broken-images' : 'blank-render',
          detail: block.reason,
        })
      }
    }

    if (r.overflows && r.overflows.length > 0) {
      const ids = r.overflows
        .slice(0, 3)
        .map((o) => o.id)
        .join(', ')
      advisories.push({
        sceneId: scene.id,
        kind: 'overflow',
        detail: `${r.overflows.length} element(s) spill past the frame (${ids})`,
      })
    }
  }
  const renderGateApplied = renderMeasured > 0

  // 7) Static motion floor — mirror the SHIPPED FLOW gate so the benchmark fails
  // what the product would fail, no stricter. hasTimeDrivenMotion is the exact
  // static-slide check the runtime FLOW gate uses. slop-scan is reported as an
  // ADVISORY only (not a hard gate — it is a taste signal, deliberately not
  // pass/fail here per the render-health-first posture).
  for (const scene of renderableScenes) {
    if (!hasTimeDrivenMotion(scene.code)) {
      defects.push({ sceneId: scene.id, kind: 'no-flow', detail: 'no time-driven motion — static slide' })
    }
    const slop = scanForSlop(scene.code)
    if (slop.length > 0) {
      advisories.push({ sceneId: scene.id, kind: 'slop', detail: slop.slice(0, 3).join('; ') })
    }
  }

  const structuralFloorClear =
    emptyShells.length === 0 &&
    !defects.some(
      (d) =>
        d.kind === 'no-flow' || d.kind === 'blank-render' || d.kind === 'broken-images' || d.kind === 'render-error',
    )

  return {
    caseId: caseDef.id,
    planned: obs.plannedCount,
    persisted: obs.scenes.length,
    renderable: renderableScenes.length,
    landedAllPlanned,
    meetsMinScenes,
    narrationOk,
    structuralFloorClear,
    renderGateApplied,
    defects,
    advisories,
    passed: defects.length === 0,
  }
}
