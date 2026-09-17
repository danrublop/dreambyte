/**
 * v5 A1 (P0): standalone timeline audio must reach the MP4 on ALL THREE export
 * paths — all-tier3, mixed-engine, and all-legacy — not just all-tier3.
 *
 * These are source-parity tests (same style as cap-checkpoint.test.ts): they
 * read the actual source files and assert the structural invariants the fix
 * depends on, so a refactor that silently drops one of them fails CI:
 *
 *   1. The concatMp4 handler orders stitch → overlayProgramAudio → loudnorm
 *      (tier3's proven ordering — overlay AFTER normalize would let program
 *      audio escape loudness normalization).
 *   2. Both renderer concat call sites (mixed + legacy) pass timelineAudio.
 *   3. Double-overlay is structurally impossible on the mixed path:
 *      Tier3SingleSceneArgs must NOT grow a timelineAudio field — per-scene
 *      sub-exports never overlay; only the final concat does.
 *   4. Overlay failure is never silent: every overlay site reports a
 *      programAudio status, and the renderer maps 'failed' to a visible
 *      export warning on all three paths.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8')

const mainSrc = read('src/electron/main.ts')
const tier3Src = read('src/electron/ipc/export-tier3.ts')
const actionsSrc = read('src/lib/store/export-actions.ts')

/** The concatMp4 handler body: from its ipcMain.handle to the next handler registration. */
function concatHandlerBody(): string {
  const start = mainSrc.indexOf("'dreambyte:concatMp4'")
  expect(start).toBeGreaterThan(-1)
  const rest = mainSrc.slice(start)
  const end = rest.indexOf('ipcMain.handle', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('v5 A1: concatMp4 overlays program audio between stitch and loudnorm', () => {
  it('multi-input path: stitchScenes → overlayTimelineAudio → normalizeFinalAudio, in order', () => {
    const body = concatHandlerBody()
    const stitchAt = body.indexOf('await stitchScenes(')
    const overlayAt = body.indexOf('await overlayTimelineAudio()', stitchAt)
    const normalizeAt = body.indexOf('await normalizeFinalAudio(', overlayAt)
    expect(stitchAt).toBeGreaterThan(-1)
    expect(overlayAt).toBeGreaterThan(stitchAt)
    expect(normalizeAt).toBeGreaterThan(overlayAt)
  })

  it('single-input shortcut: copyFile → overlayTimelineAudio → normalizeFinalAudio, in order', () => {
    const body = concatHandlerBody()
    const copyAt = body.indexOf('await fs.copyFile(inputs[0], args.output)')
    const overlayAt = body.indexOf('await overlayTimelineAudio()', copyAt)
    const normalizeAt = body.indexOf('await normalizeFinalAudio(', overlayAt)
    expect(copyAt).toBeGreaterThan(-1)
    expect(overlayAt).toBeGreaterThan(copyAt)
    expect(normalizeAt).toBeGreaterThan(overlayAt)
  })

  it('the overlay delegates to the shared tier3 overlayProgramAudio (no second ffmpeg implementation)', () => {
    const body = concatHandlerBody()
    expect(body).toContain('overlayProgramAudio(ffmpegBin, args.output, clips, master, audioTmpDir)')
    // …and the shared implementation stays exported + utility-process-safe.
    expect(tier3Src).toContain('export async function overlayProgramAudio(')
    expect(tier3Src).toContain('await runFfmpegInUtility(ffmpegBin, args)')
  })

  it('handler returns the programAudio status on both paths (never a bare ok)', () => {
    const body = concatHandlerBody()
    const returns = body.match(/return \{ ok: true, programAudio \}/g) ?? []
    expect(returns.length).toBe(2) // single-input shortcut + stitch path
    expect(body).not.toMatch(/return \{ ok: true \}/)
  })
})

describe('v5 A1: both renderer concat call sites pass timelineAudio', () => {
  it('mixed-engine and all-legacy concatMp4 calls both carry timelineAudio + masterVolume', () => {
    const calls = actionsSrc.split('concatMp4({').slice(1)
    expect(calls.length).toBe(2) // mixed + legacy
    for (const call of calls) {
      const args = call.slice(0, call.indexOf('})'))
      expect(args).toContain('timelineAudio: exportTimelineAudio')
      expect(args).toContain('masterVolume: exportMasterVolume')
    }
  })

  it('mixed/legacy/legacy-tier3 reuse the hoisted clips; the composite adds ONE includeSceneMirror computation (T7)', () => {
    expect(actionsSrc).toContain('const exportTimelineAudio = buildProgramAudioClips(')
    // Two call sites now: the hoisted one (shared by mixed + legacy + the legacy
    // per-scene tier3 path) and the single-stream COMPOSITE one — which MUST carry
    // includeSceneMirror because scene audio rides the program bus (no per-scene
    // bake), a different computation than the standalone-only hoisted clips.
    const buildCalls = actionsSrc.match(/buildProgramAudioClips\(/g) ?? []
    expect(buildCalls.length).toBe(2)
    expect(actionsSrc).toContain('includeSceneMirror: true')
  })
})

describe('v5 A1: double-overlay is structurally impossible on the mixed path', () => {
  it('Tier3SingleSceneArgs has NO timelineAudio field (per-scene sub-exports never overlay)', () => {
    const ifaceStart = tier3Src.indexOf('export interface Tier3SingleSceneArgs')
    expect(ifaceStart).toBeGreaterThan(-1)
    const ifaceEnd = tier3Src.indexOf('\n}', ifaceStart)
    const iface = tier3Src.slice(ifaceStart, ifaceEnd)
    expect(iface).not.toContain('timelineAudio')
  })
})

describe('v5 D3: overlay failure is a visible warning on all three paths, never silent', () => {
  it('runTier3Export reports programAudio applied/failed/null and returns it', () => {
    expect(tier3Src).toContain("let programAudio: 'applied' | 'failed' | null = null")
    expect(tier3Src).toContain('return { outputPath, captionsBurned, programAudio, clientOnlyNarration }')
  })

  it('overlayProgramAudio reports overlaid/skipped counts (all-clips-unresolved cannot read as success)', () => {
    expect(tier3Src).toContain('return { overlaid: 0, skipped: clips.length }')
    expect(tier3Src).toContain('return { overlaid: resolved.length, skipped: clips.length - resolved.length }')
  })

  it("the renderer maps 'failed' to the visible export warning, wired into every engine branch", () => {
    expect(actionsSrc).toContain('const PROGRAM_AUDIO_FAILED_WARNING =')
    // One mapper…
    expect(actionsSrc).toContain('const noteProgramAudio = (status')
    // …consumed by all three branches: tier3 result + the two concat results.
    expect(actionsSrc).toContain('noteProgramAudio(tier3Result.programAudio)')
    expect(actionsSrc).toContain('noteProgramAudio(mixConcat.programAudio)')
    expect(actionsSrc).toContain('noteProgramAudio(legacyConcat.programAudio)')
    // The combined warning reaches the progress slot in all three completion sets.
    const warningSites = actionsSrc.match(/warning: exportWarning\(\)/g) ?? []
    expect(warningSites.length).toBe(3)
    // REGRESSION (v5 review): no branch may still write the caption-only warning.
    expect(actionsSrc).not.toMatch(/warning: captionWarning/)
  })
})
