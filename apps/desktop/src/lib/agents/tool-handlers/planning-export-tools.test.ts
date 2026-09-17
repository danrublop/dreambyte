import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPlanningExportToolHandler, assessVisualCoverage } from './planning-export-tools'
import { PLAN_SCENES } from '../tools'
import { createExportJob, updateExportJob } from '../export-jobs'
import type { WorldStateMutable } from '../world-state'

// The export-timing guard imports this lazily; mock it so we control pending video jobs.
const { listActiveMock } = vi.hoisted(() => ({ listActiveMock: vi.fn() }))
vi.mock('@/lib/db/queries/media-generations', () => ({ listActiveMediaGenerations: listActiveMock }))

const GLOBAL_KEY = '__dreambyteExportJobs__'
function clearRegistry(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY]
}

function makeWorld(): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {} as never,
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: '' },
  } as WorldStateMutable
}

const handle = createPlanningExportToolHandler()

beforeEach(() => clearRegistry())

describe('export', () => {
  it('returns a run_export client action with export settings', async () => {
    const res = await handle('export', { resolution: '720p', fps: 24 }, makeWorld())
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).clientAction).toBe('run_export')
    expect((res.data as Record<string, unknown>).exportSettings).toEqual({ format: 'mp4', resolution: '720p', fps: 24 })
  })

  it('defaults resolution/fps when omitted', async () => {
    const res = await handle('export', {}, makeWorld())
    expect((res.data as Record<string, unknown>).exportSettings).toEqual({
      format: 'mp4',
      resolution: '1080p',
      fps: 30,
    })
  })

  it('no projectId → skips the pending-video check (existing worlds unaffected)', async () => {
    listActiveMock.mockReset()
    const res = await handle('export', {}, makeWorld()) // makeWorld has no projectId
    expect(res.success).toBe(true)
    expect(listActiveMock).not.toHaveBeenCalled()
  })

  it('GUARDED: refuses to export while an AI video clip is still generating (would be a black frame)', async () => {
    listActiveMock.mockResolvedValue([
      { id: 'v1', kind: 'video', status: 'running' },
      { id: 'a1', kind: 'audio', status: 'running' }, // non-video active jobs are ignored
    ])
    const world = { ...makeWorld(), projectId: 'p1' } as WorldStateMutable
    const res = await handle('export', {}, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/1 AI video clip\(s\) are still generating/)
  })

  it('exports normally when no video jobs are pending (audio-only active is fine)', async () => {
    listActiveMock.mockResolvedValue([{ id: 'a1', kind: 'audio', status: 'running' }])
    const world = { ...makeWorld(), projectId: 'p1' } as WorldStateMutable
    const res = await handle('export', {}, world)
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).clientAction).toBe('run_export')
  })

  it('a DB read failure does not block a legitimate export (non-fatal)', async () => {
    listActiveMock.mockRejectedValue(new Error('db down'))
    const world = { ...makeWorld(), projectId: 'p1' } as WorldStateMutable
    const res = await handle('export', {}, world)
    expect(res.success).toBe(true)
  })
})

describe('get_export_status (T2: jobId required)', () => {
  it('fails when no jobId is provided (no "latest" resolution)', async () => {
    // Even with a rendering job in the registry, a jobId-less poll must fail —
    // the old getLatestExportJob fallback (cross-path poisoning) is gone.
    createExportJob(2)
    const res = await handle('get_export_status', {}, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/requires a jobId/i)
  })

  it('returns status:none for an unknown jobId (honest, not a crash)', async () => {
    const res = await handle('get_export_status', { jobId: 'nope' }, makeWorld())
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>).status).toBe('none')
    expect((res.data as Record<string, unknown>).jobId).toBe('nope')
  })

  it('reports monotonic overall progress for a rendering job', async () => {
    const job = createExportJob(4)
    updateExportJob(job.jobId, { currentScene: 2, progress: 50 })
    const res = await handle('get_export_status', { jobId: job.jobId }, makeWorld())
    expect(res.success).toBe(true)
    const data = res.data as Record<string, unknown>
    // overall = (currentScene-1 + sceneProgress/100) / totalScenes
    //         = (1 + 0.5) / 4 = 37.5% → 38
    expect(data.progress).toBe(38)
    expect(data.sceneProgress).toBe(50)
    expect(data.status).toBe('rendering')
  })

  it('reports 100 + outputPath when complete', async () => {
    const job = createExportJob(2)
    updateExportJob(job.jobId, { status: 'complete', outputPath: '/tmp/v.mp4', progress: 100 })
    const res = await handle('get_export_status', { jobId: job.jobId }, makeWorld())
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('complete')
    expect(data.progress).toBe(100)
    expect(data.outputPath).toBe('/tmp/v.mp4')
  })
})

describe('get_export_status — scene-indexed errors (11b)', () => {
  it('names the failing scene in the description and carries the structured fields', async () => {
    const job = createExportJob(5)
    updateExportJob(job.jobId, {
      status: 'error',
      error: 'scene 3/5 ("Intro"): render exploded',
      errorSceneIndex: 3,
      errorSceneId: 'scene-abc',
    })
    const res = await handle('get_export_status', { jobId: job.jobId }, makeWorld())
    expect(res.success).toBe(false) // an errored render must report honest failure
    const description = (res.changes?.[0] as { description: string }).description
    expect(description).toContain('failed at scene 3/5')
    expect(description).toContain('sceneId scene-abc')
    const data = res.data as Record<string, unknown>
    expect(data.errorSceneIndex).toBe(3)
    expect(data.errorSceneId).toBe('scene-abc')
  })

  it('a non-scene-scoped error (stitch/concat) gets no scene tag', async () => {
    const job = createExportJob(5)
    updateExportJob(job.jobId, { status: 'error', error: 'concat failed' })
    const res = await handle('get_export_status', { jobId: job.jobId }, makeWorld())
    const description = (res.changes?.[0] as { description: string }).description
    expect(description).toBe('Export failed: concat failed')
  })
})

describe('publish_interactive (v4 #1: honest failure, no consumer)', () => {
  it('fails honestly instead of reporting a fake publish', async () => {
    // Used to return success with a bare { action:'publish' } that nothing consumes
    // — the agent told users the project was published when nothing happened.
    const res = await handle('publish_interactive', {}, makeWorld())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/publish/i)
  })
})

describe('plan_scenes — narration is a duration FLOOR, not an override (durations are law)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // The tool RESULT is a compact confirmation now; the plan itself lives on the world.
  const durOf = (world: any) => (world.scenePlan.scenes as Array<{ duration: number }>).map((s) => s.duration)

  it('honors a deliberately long duration — short narration does not shrink it', async () => {
    const world = makeWorld()
    const res = await handle(
      'plan_scenes',
      {
        title: 'V1',
        scenes: [{ name: 'Hook', purpose: 'p', duration: 20, narrationDraft: 'Hello world.' }],
        totalDuration: 20,
      },
      world,
    )
    expect(durOf(world)[0]).toBe(20) // was shrunk to ~4 by the old wordCount override
  })

  it('extends a too-short duration so dense narration fits', async () => {
    const world = makeWorld()
    const dense = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ') // floor ≈ round(50/2.5+3)=23
    const res = await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 6, narrationDraft: dense }], totalDuration: 6 },
      world,
    )
    expect(durOf(world)[0]).toBe(23)
  })

  it('leaves a no-narration duration untouched (within the [6,30] clamp)', async () => {
    const world = makeWorld()
    const res = await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 12 }], totalDuration: 12 },
      world,
    )
    expect(durOf(world)[0]).toBe(12)
  })
})

describe('plan_scenes — the result CONFIRMS, it does not echo the plan back (H4)', () => {
  // The handler used to return the whole `scenePlan`. Measured at 9,616 chars
  // (~2.4k tokens) for six beats — content the model had JUST authored, landing in
  // conversation history and re-sent on every later turn of the run. It now returns
  // only what the model cannot re-derive.
  const sixBeats = Array.from({ length: 6 }, (_, i) => ({
    name: `Beat ${i + 1}`,
    purpose: 'Establish the stakes of the match and why this single save mattered to the tournament run.',
    duration: 14,
    visualForm: (['imagery', 'chart', 'stat', 'diagram', 'imagery', 'text'] as const)[i],
    narrationDraft:
      'In the eighty-ninth minute, with the tie level and the crowd on its feet, everything came down to one moment between the posts, and what happened next would define the whole season.',
    visualElements: 'Full-bleed archival photo, slow ken-burns push, stat card sliding in from the lower third.',
    mediaLayers: 'Archival crowd b-roll behind the stat.',
    cameraMovement: 'kenBurns slow zoom 1.04x',
    carriedElements: ['the orange arrow'],
  }))

  const planSix = (world: WorldStateMutable) =>
    handle(
      'plan_scenes',
      {
        title: 'The Save',
        approach: 'One continuous move, the ball carried across every cut.',
        scenes: sixBeats,
        totalDuration: 84,
      },
      world,
    )

  it('is an order of magnitude smaller than the plan it stores', async () => {
    const world = makeWorld()
    const res = await planSix(world)
    const payload = JSON.stringify(res.data).length
    const wholePlan = JSON.stringify((world as unknown as { scenePlan: unknown }).scenePlan).length
    // Measured 9,616 → 1,648 chars. Pin a ceiling well under the old size rather
    // than an exact number, so wording tweaks don't churn the test.
    expect(payload).toBeLessThan(2500)
    expect(wholePlan).toBeGreaterThan(6000) // guard the guard: the plan really is big
  })

  it('still carries everything the caller cannot re-derive', async () => {
    const world = makeWorld()
    const res = await planSix(world)
    const data = res.data as { message: string; scenes: string[]; totalDuration: number }
    const stored = (world as unknown as { scenePlan: { scenes: Array<{ id: string; duration: number }> } }).scenePlan

    expect(data.scenes).toHaveLength(6)
    expect(data.totalDuration).toBe(stored.scenes.reduce((n, s) => n + s.duration, 0))
    // Every minted id is echoed — the model needs them to re-plan without orphaning built work.
    for (const s of stored.scenes) expect(data.scenes.join('\n')).toContain(s.id)
    // …and the duration the handler ACTUALLY stored, flagged when it differs from the ask.
    expect(data.scenes[0]).toContain(`${stored.scenes[0].duration}s (was 14s)`)
    expect(data.scenes[0]).toContain('imagery') // the committed visualForm
    expect(data.message.length).toBeLessThan(500) // else the runner stubs it out
  })

  it('does NOT echo the authored prose back', async () => {
    const world = makeWorld()
    const res = await planSix(world)
    const payload = JSON.stringify(res.data)
    expect(payload).not.toContain('eighty-ninth minute') // narrationDraft
    expect(payload).not.toContain('ken-burns push') // visualElements
    expect(payload).not.toContain('the orange arrow') // carriedElements
  })
})

describe('plan_scenes — re-plan drift guard (stable id carry-forward)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planOf = (world: any) => world.scenePlan.scenes as Array<{ id: string; name: string }>

  it('assigns fresh ids on the first plan and stores the plan on the world', async () => {
    const world = makeWorld()
    const res = await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    expect(res.success).toBe(true)
    expect(planOf(world)[0].id).toMatch(/[0-9a-f-]{36}/)
    expect(world.scenePlan?.scenes).toHaveLength(1)
  })

  it('stores the reasoned `approach` on the scenePlan (the builder reads it)', async () => {
    const world = makeWorld()
    const res = await handle(
      'plan_scenes',
      {
        title: 'Atlas Lions',
        approach:
          'A rising-camera journey from 1970 obscurity to the 2022 semi — one warm pitch-green world, the ball as the connective motif across every cut.',
        scenes: [{ name: 'Hook', purpose: 'p', duration: 8 }],
        totalDuration: 8,
      },
      world,
    )
    expect(res.success).toBe(true)
    expect(world.scenePlan?.approach).toMatch(/rising-camera journey/)
    // The RESULT no longer echoes the plan back (H4) — it confirms what was stored.
    expect((res.data as { message: string }).message).toMatch(/stored/)
  })

  it('carries the stable id forward when a re-plan RENAMES a scene at the same position', async () => {
    const world = makeWorld()
    await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    const originalId = planOf(world)[0].id

    // Agent re-plans with a DRIFTED name, no id echoed (the realistic LLM re-plan).
    await handle(
      'plan_scenes',
      { title: 'V2', scenes: [{ name: 'The Big Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    // Same id → the orchestrator re-finds the already-built shell, no duplicate.
    expect(planOf(world)[0].id).toBe(originalId)
  })

  it('reuses ids by exact name even when scenes are REORDERED', async () => {
    const world = makeWorld()
    await handle(
      'plan_scenes',
      {
        title: 'V1',
        scenes: [
          { name: 'A', purpose: 'p', duration: 8 },
          { name: 'B', purpose: 'p', duration: 8 },
        ],
        totalDuration: 16,
      },
      world,
    )
    const [idA, idB] = planOf(world).map((s) => s.id)

    await handle(
      'plan_scenes',
      {
        title: 'V2',
        scenes: [
          { name: 'B', purpose: 'p', duration: 8 },
          { name: 'A', purpose: 'p', duration: 8 },
        ],
        totalDuration: 16,
      },
      world,
    )
    const plan2 = planOf(world)
    expect(plan2[0].id).toBe(idB) // B kept its id despite moving to front
    expect(plan2[1].id).toBe(idA)
  })

  it('mints a fresh id for a GENUINELY NEW scene and warns about the changed set', async () => {
    const world = makeWorld()
    await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    const originalId = planOf(world)[0].id

    const second = await handle(
      'plan_scenes',
      {
        title: 'V2',
        scenes: [
          { name: 'Hook', purpose: 'p', duration: 8 },
          { name: 'Brand New Closer', purpose: 'p', duration: 8 },
        ],
        totalDuration: 16,
      },
      world,
    )
    const plan2 = planOf(world)
    expect(plan2[0].id).toBe(originalId) // kept
    expect(plan2[1].id).not.toBe(originalId) // new scene, fresh id
    // Re-plan-over-existing warning surfaces the kept/new/dropped tally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnings = (second as any).data.warnings as string[] | undefined
    expect(warnings?.some((w) => /Re-planned over an existing/.test(w))).toBe(true)
  })

  it('respects an explicitly echoed id over any name/position heuristic', async () => {
    const world = makeWorld()
    await handle(
      'plan_scenes',
      { title: 'V1', scenes: [{ name: 'Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    const res = await handle(
      'plan_scenes',
      { title: 'V2', scenes: [{ id: 'pinned-123', name: 'Hook', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    expect(planOf(world)[0].id).toBe('pinned-123')
  })
})

describe('plan_scenes — the schema describes exactly what the handler accepts', () => {
  // The tool schema and the handler are edited independently, and the schema is the
  // single most expensive tool on the per-turn surface (a slim-down target). This is
  // the check that keeps a byte cut honest: every property the schema advertises has
  // to survive into world.scenePlan, and anything the schema no longer offers must not
  // be something the handler needs.
  const sceneProps = (PLAN_SCENES.input_schema as any).properties.scenes.items.properties as Record<string, unknown>

  it('every advertised scene property reaches the stored plan', async () => {
    const world = makeWorld()
    // One sentinel per advertised property, typed to match the schema.
    const scene: Record<string, unknown> = {
      id: 'pinned-1',
      name: 'Hook',
      purpose: 'why this beat exists',
      duration: 12,
      transition: 'fade',
      narrationDraft: 'Some narration.',
      visualForm: 'chart',
      visualElements: 'a full-bleed bar chart',
      audioNotes: 'whoosh on the cut',
      chartSpec: { type: 'bar', dataDescription: 'scores by round' },
      mediaLayers: 'archival photo of the crowd',
      cameraMovement: 'kenBurns slow zoom 1.04x',
      handoffToNext: { type: 'match-cut', note: 'circle to sun' },
      carriedElements: ['the orange arrow'],
    }
    // Fails loudly if a property is added to the schema without a sentinel here.
    expect(Object.keys(scene).sort()).toEqual(Object.keys(sceneProps).sort())

    const res = await handle('plan_scenes', { title: 'V', approach: 'a', scenes: [scene], totalDuration: 12 }, world)
    const stored = (world as any).scenePlan.scenes[0] as Record<string, unknown>
    for (const key of Object.keys(sceneProps)) {
      expect(stored[key], `plan_scenes dropped "${key}" — the schema advertises it`).toBeDefined()
    }
    expect(stored.duration).toBe(12)
    expect(stored.transition).toBe('fade')
    expect(stored.handoffToNext).toEqual({ type: 'match-cut', note: 'circle to sun' })
  })

  it('sceneType is NOT advertised — the handler hardcodes react either way', () => {
    // Removed from the schema because the handler overwrites whatever is sent. Offering
    // it cost bytes on every turn AND output tokens on every planned scene, and it was
    // in `required`, so the model paid for it once per beat.
    expect(sceneProps).not.toHaveProperty('sceneType')
    expect((PLAN_SCENES.input_schema as any).properties.scenes.items.required).not.toContain('sceneType')
  })

  it('every scene is normalized to react even when the caller omits sceneType', async () => {
    const world = makeWorld()
    await handle(
      'plan_scenes',
      { title: 'V', scenes: [{ name: 'A', purpose: 'p', duration: 8 }], totalDuration: 8 },
      world,
    )
    expect((world as any).scenePlan.scenes[0].sceneType).toBe('react')
  })
})

describe('assessVisualCoverage — adaptive visual-plan gate', () => {
  const s = (over: Record<string, unknown> = {}) => ({
    name: 'Beat',
    purpose: 'p',
    sceneType: 'react',
    duration: 8,
    ...over,
  })
  // Minimal ProjectBrief stub — the gate reads only mediaStrategy + confidence.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brief = (over: Record<string, unknown> = {}): any => ({
    confidence: 0.9,
    mediaStrategy: { research: false, stock: false, generate: false, userAssets: false, branding: false },
    ...over,
  })
  const wantsImagery = brief({
    mediaStrategy: { research: true, stock: true, generate: false, userAssets: false, branding: false },
  })
  const hasSlideshow = (w: string[]) => w.some((x) => /flat text slideshow/i.test(x))

  it('nudges a zero-imagery zero-chart plan ONLY when the brief wants imagery', () => {
    expect(hasSlideshow(assessVisualCoverage([s(), s(), s()], wantsImagery))).toBe(true)
  })

  it('does NOT nudge imagery for a deliberately-minimal brief (mediaStrategy all-false)', () => {
    expect(hasSlideshow(assessVisualCoverage([s(), s(), s()], brief()))).toBe(false)
  })

  it('does NOT nudge imagery on a low-confidence (sparse) brief even if it "wants" imagery', () => {
    expect(
      hasSlideshow(
        assessVisualCoverage(
          [s(), s(), s()],
          brief({
            confidence: 0.4,
            mediaStrategy: { research: true, stock: true, generate: false, userAssets: false, branding: false },
          }),
        ),
      ),
    ).toBe(false)
  })

  it('does NOT nudge imagery when there is no brief (non-rigid on no signal)', () => {
    expect(hasSlideshow(assessVisualCoverage([s(), s(), s()]))).toBe(false)
  })

  it('does NOT nudge when imagery is present (brief wants it)', () => {
    expect(
      hasSlideshow(assessVisualCoverage([s({ mediaLayers: 'full-bleed photo of the team' }), s(), s()], wantsImagery)),
    ).toBe(false)
  })

  it('does NOT nudge when a chart is present (brief wants imagery)', () => {
    expect(
      hasSlideshow(
        assessVisualCoverage([s({ chartSpec: { type: 'bar', dataDescription: 'x' } }), s(), s()], wantsImagery),
      ),
    ).toBe(false)
  })

  it('flags a number-heavy beat with no chart — regardless of brief (data-driven)', () => {
    const w = assessVisualCoverage([
      s({ name: 'The Wall', narrationDraft: '77% possession, 0 goals, 120 minutes, 2 penalties saved' }),
      s({ mediaLayers: 'photo' }),
    ])
    expect(w.some((x) => /number-heavy beat/i.test(x) && /The Wall/.test(x))).toBe(true)
  })

  it('does not flag a data beat that already has a chart', () => {
    const w = assessVisualCoverage([
      s({ name: 'Stats', narrationDraft: '77% and 0 and 120 and 2', chartSpec: { type: 'bar' } }),
      s({ mediaLayers: 'photo' }),
    ])
    expect(w.some((x) => /number-heavy/i.test(x))).toBe(false)
  })

  it('empty plan → no warnings', () => {
    expect(assessVisualCoverage([])).toEqual([])
  })
})
