#!/usr/bin/env tsx
/**
 * Offline end-to-end benchmark runner.
 *
 * Drives the REAL agent (runAgentRequest, no mocks) through each suite prompt,
 * reads the persisted scenes back from the DB, and scores the finished run with
 * scoreBenchmark (defect/structural assertions only — no taste). This is the
 * instrument that checks whether the generation substrate is holding.
 *
 * Real, paid, slow LLM calls — NOT part of `vitest run`. Run explicitly:
 *   npm run eval:benchmark
 *   npm run eval:benchmark -- --max-cases 1 --model-tier budget
 * Guarded on a configured provider key: with none it prints a skip and exits 0.
 *
 * DB isolation: this creates throwaway `bench-*` projects, so point DATABASE_URL
 * at a scratch file first (`DATABASE_URL=file:./bench.db npm run db:migrate` then
 * the same env for the run). main() refuses to run against any DB that isn't
 * explicitly named as scratch — see isScratchDbUrl.
 *
 * The visual blank/broken-frame assertion needs an offscreen render (the headless
 * path can't render-gate); that runs in the Electron child render-verify.mjs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { config } from 'dotenv'
import {
  scoreBenchmark,
  type BenchmarkCase,
  type BenchmarkScene,
  type RunObservation,
  type SceneRenderHealth,
} from './score'

config({ path: '.env' })
config({ path: '.env.local' })

interface SuiteRow extends BenchmarkCase {
  prompt: string
  aspectRatio: string
}

/**
 * Is this DATABASE_URL a DB the benchmark is allowed to write bench-* projects to?
 * ALLOWLIST on purpose — a blocklist can't anticipate every real DB (e.g. `dev.db`,
 * which `.env` sets and which every dev actually uses).
 */
export function isScratchDbUrl(dbUrl: string): boolean {
  return /bench|scratch|:memory:/i.test(dbUrl)
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = 'true'
  }
  return out
}

function loadSuite(here: string): SuiteRow[] {
  const raw = readFileSync(join(here, 'suite.jsonl'), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as SuiteRow)
}

/**
 * Normalize a persisted scene into the scorer's BenchmarkScene shape.
 *
 * Rows come from getProjectScenesLight, which returns the scene's JSON blob
 * (scenes.scene_blob) already flattened to the top level (+ id) — so code and
 * narration fields are read directly off the row. Kept in the runner (not
 * score.ts) so the scorer stays schema-independent.
 */
function normalizeScene(row: Record<string, unknown>): BenchmarkScene {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const code =
    str(row.reactCode) || str(row.sceneCode) || str(row.canvasCode) || str(row.svgContent) || str(row.lottieSource)

  // Narration is structural: an enabled audio layer, an aiLayers audio entry, or a narration url.
  const audio = (row.audioLayer && typeof row.audioLayer === 'object' ? row.audioLayer : {}) as Record<string, unknown>
  const aiLayers = Array.isArray(row.aiLayers) ? (row.aiLayers as Array<Record<string, unknown>>) : []
  const hasNarration =
    Boolean(audio.enabled && audio.src) ||
    Boolean(row.narrationUrl) ||
    aiLayers.some((l) => l.type === 'audio' || l.type === 'narration' || Boolean(l.narrationUrl))

  // Imagery is structural: any placed image/sticker/veo3/avatar aiLayer, or an
  // enabled video layer with a src. Mirrors sceneHasImagery (src/lib/agents/imagery-floor).
  const IMAGERY_AI = new Set(['image', 'sticker', 'veo3', 'avatar'])
  const video = (row.videoLayer && typeof row.videoLayer === 'object' ? row.videoLayer : {}) as Record<string, unknown>
  const hasImagery = Boolean(video.enabled && video.src) || aiLayers.some((l) => IMAGERY_AI.has(str(l.type)))

  const isPlaceholder = code.trim().length === 0 || /PLACEHOLDER|__shell__|BUILDING/i.test(code)
  return { id: str(row.id) || 'unknown', code, hasNarration, isPlaceholder, hasImagery }
}

/** Minimal shape of the app verifier's SceneVerifyOutcome the render step emits. */
interface RawVerifyOutcome {
  status: SceneRenderHealth['status']
  error?: { kind?: string; message?: string } | null
  frame?: SceneRenderHealth['frame']
  overflows?: SceneRenderHealth['overflows']
}

/**
 * Render each persisted scene HTML through the app's OWN verifier (offscreen,
 * in a throwaway Electron child) and map the outcome into SceneRenderHealth.
 *
 * This is the offscreen-render half of the benchmark: plain `tsx` has no
 * browser, so we shell out to `electron render-verify.mjs`. Best-effort by
 * contract — if Electron can't boot / render, every scene comes back `unknown`
 * and the scorer reports renderGateApplied=false (an honest skip, never a
 * fabricated pass). Set `--render off` to skip this step entirely.
 */
function renderHealthForScenes(here: string, scenesDir: string, sceneIds: string[]): Record<string, SceneRenderHealth> {
  const out: Record<string, SceneRenderHealth> = {}
  if (sceneIds.length === 0) return out

  const work = mkdtempSync(join(tmpdir(), 'bench-render-'))
  const manifestPath = join(work, 'manifest.json')
  const outPath = join(work, 'out.json')
  const scenes = sceneIds.map((id) => ({ sceneId: id, file: `${id}.html` }))
  writeFileSync(manifestPath, JSON.stringify({ scenesDir, scenes }), 'utf8')

  try {
    // `electron <script>` runs the Electron runtime (needed for BrowserWindow) —
    // do NOT set ELECTRON_RUN_AS_NODE. This is a bare script, not the app main,
    // so it registers no dreambyte:// protocol and no MCP socket (won't hijack a
    // running app instance).
    execFileSync('npx', ['electron', join(here, 'render-verify.mjs'), manifestPath, outPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 5 * 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    })
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, RawVerifyOutcome>
    for (const id of sceneIds) {
      const o = raw[id]
      if (!o) {
        out[id] = { status: 'unknown' }
        continue
      }
      out[id] = {
        status: o.status,
        ...(o.error?.kind ? { errorKind: o.error.kind } : {}),
        ...(o.error?.message ? { errorMessage: o.error.message } : {}),
        ...(o.frame ? { frame: o.frame } : {}),
        ...(o.overflows ? { overflows: o.overflows } : {}),
      }
    }
  } catch (e) {
    process.stderr.write(`[benchmark] render step skipped (honest): ${(e as Error).message}\n`)
    for (const id of sceneIds) out[id] = { status: 'unknown' }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return out
}

async function runCase(
  row: SuiteRow,
  tier: string,
  model: string,
  opts: { subAgents?: boolean; render: boolean; here: string; sandbox?: boolean },
): Promise<{ score: ReturnType<typeof scoreBenchmark>; err?: string }> {
  const { runAgentRequest } = await import('@/lib/services/agent-runner')
  const { createProject, getProjectScenesLight, getProjectBrief } = await import('@/lib/db/queries/projects')
  type Req = import('@/lib/services/agent-runner').AgentAPIRequest

  const projectId = `bench-${row.id}-${process.pid}`
  await createProject({
    id: projectId,
    name: `benchmark:${row.id}`,
    outputMode: 'mp4',
    // aspectRatio lives in mp4Settings — there is no top-level column, so a bare
    // `aspectRatio` key is silently dropped and every case would render 16:9.
    mp4Settings: { aspectRatio: row.aspectRatio },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  const events: Array<Record<string, unknown>> = []
  const body: Req = {
    message: row.prompt,
    scenes: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalStyle: { presetId: null } as any,
    projectName: `benchmark:${row.id}`,
    outputMode: 'mp4',
    projectId,
    branchId: null,
    // Pinning modelOverride pins BOTH the run and the brief extraction
    // (agent-runner: runModel = body.modelOverride ?? resolveModel(...)). Without
    // it, budget/auto resolve to whatever provider key is present — here a stale
    // DASHSCOPE_API_KEY routes to qwen and 401s.
    modelOverride: model as Req['modelOverride'],
    modelTier: tier as Req['modelTier'],
    aiQualityReview: false, // the benchmark grades the artifact; the agent's own taste review stays off
    runBudgetUsd: 8,
    // Build path: omitted → runner default (SINGLE-AGENT — the parent builds every
    // scene itself); `--path director` turns sub-agents on so the whole-video
    // director (runDirectorLoop) builds instead. The blind fan-out was deleted
    // 2026-08.
    ...(opts.subAgents ? { subAgents: true } : {}),
    // Sandbox: media-gen tools return $0 placeholder assets (no provider call), so an
    // imagery case can EMIT + place generate_image without an image key or cost. The
    // agent's own reasoning still uses the model key like any other case.
    ...(opts.sandbox ? { sandboxMode: true } : {}),
  }

  let err: string | undefined
  try {
    await runAgentRequest({
      body,
      authenticatedUserId: null,
      abortSignal: new AbortController().signal,
      emit: (e) => events.push(e as unknown as Record<string, unknown>),
    })
  } catch (e) {
    err = (e as Error).message
  }

  // Planned count = the scenes[] of the LAST plan_scenes call. No dedicated event
  // exposes the machine scenePlan (plan_proposed carries the free-form write_plan
  // markdown, not scenePlan.scenes), but every tool call emits tool_complete with
  // its toolInput, so read the plan the agent actually committed to from there.
  const planCalls = events.filter(
    (e) => e.type === 'tool_complete' && (e as { toolName?: string }).toolName === 'plan_scenes',
  )
  const lastPlan = planCalls[planCalls.length - 1] as { toolInput?: { scenes?: unknown[] } } | undefined
  const plannedCount = Array.isArray(lastPlan?.toolInput?.scenes) ? lastPlan!.toolInput!.scenes!.length : 0

  // Every tool the agent actually emitted (tool_complete carries toolName) — the
  // expectImagery assertion checks an AI-gen tool was reachable AND called.
  const emittedTools = [
    ...new Set(
      events
        .filter((e) => e.type === 'tool_complete')
        .map((e) => (e as { toolName?: string }).toolName)
        .filter((n): n is string => typeof n === 'string'),
    ),
  ]

  const persistEvt = events.find((e) => e.type === 'persist_done')
  const persistOk = persistEvt ? Boolean((persistEvt as { persistOk?: boolean }).persistOk) : false

  // Read scenes back via the blessed agent-path reader (blob flattened + id, no
  // relations — safe in this standalone tsx context; see normalizeScene).
  const sceneRows = (await getProjectScenesLight(projectId)) as Array<Record<string, unknown>>

  // Intent alignment (best-effort): the agent's resolved videoType from the brief.
  let resolvedVideoType: string | undefined
  try {
    resolvedVideoType = (await getProjectBrief(projectId))?.videoType
  } catch {
    /* no brief persisted — alignment check is skipped in the scorer */
  }

  const scenes = sceneRows.map(normalizeScene)

  // Offscreen render health — the failures a user actually hits (errors / blank).
  // Only render scenes that persisted real code AND whose HTML landed on disk.
  if (opts.render) {
    const { resolveScenesDir } = await import('@/lib/scene-html-paths')
    const scenesDir = resolveScenesDir()
    const renderableIds = scenes
      .filter((s) => !s.isPlaceholder && s.code.trim().length > 0 && existsSync(join(scenesDir, `${s.id}.html`)))
      .map((s) => s.id)
    const health = renderHealthForScenes(opts.here, scenesDir, renderableIds)
    for (const s of scenes) if (health[s.id]) s.render = health[s.id]
  }

  const obs: RunObservation = { plannedCount, persistOk, resolvedVideoType, emittedTools, scenes }
  return { score: scoreBenchmark(row, obs), err }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tier = args['model-tier'] || 'auto'
  // Default to a valid Anthropic budget model so the harness runs out-of-the-box
  // here (auto/budget tier resolution routes to a dead qwen key on this machine).
  // Pass --model claude-sonnet-4-6 (etc.) for a real benchmark on the shipped model.
  const model = args['model'] || 'claude-haiku-4-5-20251001'
  const maxCases = args['max-cases'] ? parseInt(args['max-cases'], 10) : Infinity

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.MOONSHOT_API_KEY)
  if (!hasKey) {
    console.log('[benchmark] SKIP — no agent provider key configured (.env). Not a failure.')
    process.exit(0)
  }

  // Safety: the runner creates throwaway `bench-*` projects — never let that land
  // in a DB anyone cares about. `config({ path: '.env' })` above loads
  // `DATABASE_URL=file:./dev.db`, the developer's working database, so the DB
  // must be one you explicitly named as scratch (allowlist, not blocklist).
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!isScratchDbUrl(dbUrl)) {
    console.error(
      `[benchmark] REFUSING to run against ${dbUrl || '(DATABASE_URL unset)'} — the benchmark creates\n` +
        `throwaway bench-* projects and will only write to a DB you name as scratch\n` +
        `(the URL must contain "bench", "scratch", or be :memory:).\n` +
        `Point DATABASE_URL at a throwaway file first, e.g.:\n` +
        `  DATABASE_URL=file:./bench.db npm run db:migrate\n` +
        `  DATABASE_URL=file:./bench.db npm run eval:benchmark`,
    )
    process.exit(2)
  }

  // Build path: `director` (whole-video mind) turns sub-agents ON for the run.
  // Omitting --path leaves the flag unset → the runner's own default decides,
  // which is SINGLE-AGENT (the parent builds every scene itself).
  const pathArg = (args['path'] || 'default').toLowerCase()
  if (!['default', 'director'].includes(pathArg)) {
    console.error(`[benchmark] --path must be one of: default | director (got "${pathArg}")`)
    process.exit(2)
  }
  const render = (args['render'] || 'on').toLowerCase() !== 'off'
  // --sandbox makes media-gen $0 (placeholder assets) so imagery cases prove the
  // unblock without image/video keys. Off by default to preserve the paid real-media run.
  const sandbox = args['sandbox'] !== undefined && args['sandbox'] !== 'false' && args['sandbox'] !== 'off'
  const paths: Array<{ label: 'default' | 'director'; subAgents?: boolean }> =
    pathArg === 'director' ? [{ label: 'director', subAgents: true }] : [{ label: 'default' }]

  const here = fileURLToPath(new URL('.', import.meta.url))
  const only = args['case']
  const suite = loadSuite(here)
    .filter((r) => !only || r.id === only)
    .slice(0, maxCases)
  console.error(
    `[benchmark] cases=${suite.length} tier=${tier} model=${model} path=${pathArg} render=${render ? 'on' : 'off'} sandbox=${sandbox ? 'on' : 'off'}${only ? ` case=${only}` : ''}`,
  )

  // scored per path label → the case scores in suite order.
  const byPath: Record<string, Array<ReturnType<typeof scoreBenchmark>>> = {}
  for (const p of paths) byPath[p.label] = []

  for (const row of suite) {
    for (const p of paths) {
      process.stderr.write(`[benchmark] ${p.label}:${row.id}… `)
      try {
        const { score, err } = await runCase(row, tier, model, { subAgents: p.subAgents, render, here, sandbox })
        byPath[p.label].push(score)
        const gate = score.renderGateApplied ? '' : ' [render-gate SKIPPED]'
        process.stderr.write(
          `${score.passed ? 'PASS' : 'FAIL'} (${score.renderable}/${score.planned || score.renderable} scenes, ${score.defects.length} defects${gate}${err ? `, run-error: ${err}` : ''})\n`,
        )
      } catch (e) {
        process.stderr.write(`ERROR: ${(e as Error).message}\n`)
      }
    }
  }

  const reportsDir = join(here, 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const passRateOf = (list: Array<ReturnType<typeof scoreBenchmark>>) =>
    list.length ? list.filter((s) => s.passed).length / list.length : 0
  writeFileSync(
    join(reportsDir, `benchmark-${pathArg}-${tier}-${stamp}.json`),
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        tier,
        model,
        path: pathArg,
        render,
        byPath,
        passRate: Object.fromEntries(Object.entries(byPath).map(([k, v]) => [k, passRateOf(v)])),
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`\n=== BENCHMARK (render-health + structural, NOT taste) ===`)
  for (const [label, list] of Object.entries(byPath)) {
    const passed = list.filter((s) => s.passed).length
    console.log(`\n--- ${label} · ${passed}/${list.length} passed ---`)
    for (const s of list) {
      const kinds = s.defects.map((d) => d.kind).join(', ') || 'clean'
      const adv = s.advisories.length ? ` · adv: ${s.advisories.map((a) => a.kind).join(', ')}` : ''
      const gate = s.renderGateApplied ? '' : ' · render-gate SKIPPED'
      console.log(
        `  ${s.passed ? 'PASS' : 'FAIL'}  ${s.caseId.padEnd(22)} ${s.renderable} scenes · ${kinds}${adv}${gate}`,
      )
    }
  }

  const flat = Object.values(byPath).flat()
  console.log(`\nPass rate: ${flat.filter((s) => s.passed).length}/${flat.length}`)
  process.exit(flat.every((s) => s.passed) ? 0 : 1)
}

// Only auto-run when invoked as a script. Without this, merely IMPORTING this
// module (e.g. a unit test on the DB guard below) would launch a real, paid,
// DB-writing benchmark — which is precisely the accident the guard exists to stop.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('[benchmark] fatal:', e)
    process.exit(2)
  })
}
