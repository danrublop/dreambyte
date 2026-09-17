import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scoreBenchmark, type BenchmarkCase, type BenchmarkScene, type RunObservation, type SceneRenderHealth } from './score'

// camera-travel.good is real motion code (clears the floor). STATIC is a genuinely
// motionless slide — the exact case the shipped FLOW gate blocks, which the scorer
// mirrors via hasTimeDrivenMotion. (vitest runs from the repo root.)
const goldenDir = join(process.cwd(), 'evals/motion-design/golden')
const GOOD = readFileSync(join(goldenDir, 'camera-travel.good.txt'), 'utf8')
const STATIC = 'export default () => <div style={{ fontSize: 120 }}>Hello world</div>'

function scene(id: string, over: Partial<BenchmarkScene> = {}): BenchmarkScene {
  return { id, code: GOOD, hasNarration: false, isPlaceholder: false, hasImagery: false, ...over }
}
function obs(over: Partial<RunObservation> = {}): RunObservation {
  return { plannedCount: 3, persistOk: true, scenes: [scene('a'), scene('b'), scene('c')], ...over }
}
const CASE: BenchmarkCase = { id: 'c', minScenes: 3, expectNarration: false }

describe('scoreBenchmark — defect/structural only, no taste', () => {
  it('passes a clean 3-of-3 run that clears the structural floor', () => {
    const s = scoreBenchmark(CASE, obs())
    expect(s.passed).toBe(true)
    expect(s.defects).toHaveLength(0)
    expect(s.landedAllPlanned).toBe(true)
    expect(s.structuralFloorClear).toBe(true)
  })

  it('flags N-of-N miss + empty shells when scenes persist without code', () => {
    const s = scoreBenchmark(
      CASE,
      obs({ scenes: [scene('a'), scene('b', { isPlaceholder: true }), scene('c', { code: '' })] }),
    )
    expect(s.passed).toBe(false)
    expect(s.renderable).toBe(1)
    expect(s.landedAllPlanned).toBe(false)
    expect(s.defects.filter((d) => d.kind === 'empty-shell')).toHaveLength(2)
    expect(s.defects.some((d) => d.kind === 'missing-scenes')).toBe(true)
    expect(s.defects.some((d) => d.kind === 'below-min-scenes')).toBe(true)
  })

  it('flags durable-state loss when persistOk is false', () => {
    const s = scoreBenchmark(CASE, obs({ persistOk: false }))
    expect(s.passed).toBe(false)
    expect(s.defects.some((d) => d.kind === 'not-persisted')).toBe(true)
  })

  it('expectImagery: PASSES when the agent emitted an AI-gen tool (the unblock works)', () => {
    const wantsImagery: BenchmarkCase = { ...CASE, expectImagery: true }
    const s = scoreBenchmark(wantsImagery, obs({ emittedTools: ['plan_scenes', 'generate_image', 'place_image'] }))
    expect(s.defects.some((d) => d.kind === 'missing-imagery')).toBe(false)
  })

  it('expectImagery: PASSES when imagery landed on a scene even without a generate_* call (stock path)', () => {
    const wantsImagery: BenchmarkCase = { ...CASE, expectImagery: true }
    const s = scoreBenchmark(
      wantsImagery,
      obs({ emittedTools: ['find_stock_images', 'set_video_layer'], scenes: [scene('a', { hasImagery: true }), scene('b'), scene('c')] }),
    )
    expect(s.defects.some((d) => d.kind === 'missing-imagery')).toBe(false)
  })

  it('expectImagery: FAILS when no AI-gen tool was emitted AND no imagery landed (the phantom-tool regression)', () => {
    const wantsImagery: BenchmarkCase = { ...CASE, expectImagery: true }
    const s = scoreBenchmark(wantsImagery, obs({ emittedTools: ['plan_scenes', 'write_scene_code'] }))
    expect(s.passed).toBe(false)
    expect(s.defects.some((d) => d.kind === 'missing-imagery')).toBe(true)
  })

  it('expectImagery unset: never flags missing-imagery (default cases untouched)', () => {
    const s = scoreBenchmark(CASE, obs({ emittedTools: ['plan_scenes'] }))
    expect(s.defects.some((d) => d.kind === 'missing-imagery')).toBe(false)
  })

  it('flags missing narration only when the case expects it', () => {
    const wantsNarration: BenchmarkCase = { ...CASE, expectNarration: true }
    const without = scoreBenchmark(wantsNarration, obs())
    expect(without.narrationOk).toBe(false)
    expect(without.defects.some((d) => d.kind === 'missing-narration')).toBe(true)

    const withNarration = scoreBenchmark(
      wantsNarration,
      obs({ scenes: [scene('a', { hasNarration: true }), scene('b'), scene('c')] }),
    )
    expect(withNarration.narrationOk).toBe(true)
  })

  it('trips the structural floor on a motionless static slide (matches the shipped gate)', () => {
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a'), scene('b'), scene('c', { code: STATIC })] }))
    expect(s.structuralFloorClear).toBe(false)
    expect(s.defects.some((d) => d.kind === 'no-flow')).toBe(true)
    expect(s.passed).toBe(false)
  })

  it('flags a video-type mismatch only when both expected and resolved are present', () => {
    const wantsType: BenchmarkCase = { ...CASE, expectVideoType: 'explainer' }
    const mismatch = scoreBenchmark(wantsType, obs({ resolvedVideoType: 'marketing' }))
    expect(mismatch.defects.some((d) => d.kind === 'wrong-video-type')).toBe(true)
    const match = scoreBenchmark(wantsType, obs({ resolvedVideoType: 'explainer' }))
    expect(match.defects.some((d) => d.kind === 'wrong-video-type')).toBe(false)
    // No resolved brief → alignment check skipped, not failed.
    const noBrief = scoreBenchmark(wantsType, obs())
    expect(noBrief.defects.some((d) => d.kind === 'wrong-video-type')).toBe(false)
  })

  it('does not require a plan (plannedCount 0 → landedAllPlanned true)', () => {
    const single: BenchmarkCase = { id: 'one', minScenes: 1, expectNarration: false }
    const s = scoreBenchmark(single, { plannedCount: 0, persistOk: true, scenes: [scene('a')] })
    expect(s.landedAllPlanned).toBe(true)
    expect(s.passed).toBe(true)
  })
})

// Render-health = the failures a user actually hits (the scene errors / won't
// play, or renders blank). Driven by the app's own verifier outcome, graded here.
const VERIFIED: SceneRenderHealth = { status: 'verified', frame: { nonblankRatio: 0.5, distinctColors: 6, brokenImages: 0, totalImages: 0 } }

describe('scoreBenchmark — render health (the app-shows-an-error class)', () => {
  it('HARD FAILS a scene that errors / will not play', () => {
    const errored: SceneRenderHealth = { status: 'errored', errorKind: 'runtime', errorMessage: "Cannot read 'x' of undefined" }
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a', { render: VERIFIED }), scene('b', { render: errored }), scene('c', { render: VERIFIED })] }))
    expect(s.passed).toBe(false)
    const d = s.defects.find((x) => x.kind === 'render-error')
    expect(d?.sceneId).toBe('b')
    expect(d?.detail).toContain('runtime')
    expect(s.renderGateApplied).toBe(true)
    expect(s.structuralFloorClear).toBe(false)
  })

  it('HARD FAILS a scene that renders an essentially blank frame', () => {
    const blank: SceneRenderHealth = { status: 'verified', frame: { nonblankRatio: 0, distinctColors: 1, brokenImages: 0, totalImages: 0 } }
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a', { render: VERIFIED }), scene('b', { render: VERIFIED }), scene('c', { render: blank })] }))
    expect(s.passed).toBe(false)
    expect(s.defects.some((d) => d.kind === 'blank-render' && d.sceneId === 'c')).toBe(true)
  })

  it('HARD FAILS a scene whose images all failed to load', () => {
    const broken: SceneRenderHealth = { status: 'verified', frame: { nonblankRatio: 0.4, distinctColors: 5, brokenImages: 3, totalImages: 3 } }
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a', { render: VERIFIED }), scene('b', { render: VERIFIED }), scene('c', { render: broken })] }))
    expect(s.passed).toBe(false)
    expect(s.defects.some((d) => d.kind === 'broken-images' && d.sceneId === 'c')).toBe(true)
  })

  it('passes a clean verified run and reports overflow only as an ADVISORY', () => {
    const withOverflow: SceneRenderHealth = { ...VERIFIED, overflows: [{ id: 'h1:Hello', edges: ['right'], overflowPx: 40 }] }
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a', { render: VERIFIED }), scene('b', { render: withOverflow }), scene('c', { render: VERIFIED })] }))
    expect(s.passed).toBe(true)
    expect(s.defects).toHaveLength(0)
    expect(s.advisories.some((a) => a.kind === 'overflow' && a.sceneId === 'b')).toBe(true)
    expect(s.renderGateApplied).toBe(true)
  })

  it('SKIPS the render gate honestly when the frame is unmeasurable (unknown), never a silent pass', () => {
    const unknown: SceneRenderHealth = { status: 'unknown' }
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a', { render: unknown }), scene('b', { render: unknown }), scene('c', { render: unknown })] }))
    // Structural checks still pass; no render defect is invented from an unknown.
    expect(s.defects.some((d) => d.kind === 'render-error' || d.kind === 'blank-render')).toBe(false)
    expect(s.renderGateApplied).toBe(false)
  })

  it('renderGateApplied is false when no render pass ran at all', () => {
    const s = scoreBenchmark(CASE, obs())
    expect(s.renderGateApplied).toBe(false)
    expect(s.passed).toBe(true)
  })

  it('treats AI-slop code tells as an advisory, not a hard failure', () => {
    // A scene whose code trips slop-scan (emoji as on-screen content) but is
    // otherwise real motion — must not fail the case; only advise.
    const SLOP = GOOD + "\n// on screen: <div>{'🚀'}</div> emoji content"
    const s = scoreBenchmark(CASE, obs({ scenes: [scene('a'), scene('b'), scene('c', { code: SLOP })] }))
    expect(s.defects.some((d) => (d.kind as string) === 'slop')).toBe(false)
    // slop-scan may or may not trip on this exact string; the invariant is only
    // that IF it trips, it lands in advisories and never fails the run.
    expect(s.passed).toBe(true)
  })
})
