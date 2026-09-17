import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createExportJob, updateExportJob, getExportJob, exportJobCount, errorJobPatch } from './export-jobs'

const GLOBAL_KEY = '__dreambyteExportJobs__'

// The registry is process-global. Clear it between tests so a stray rendering
// job from one test can't perturb prune/count assertions in another.
function clearRegistry(): void {
  const g = globalThis as unknown as Record<string, unknown>
  delete g[GLOBAL_KEY]
}

beforeEach(() => clearRegistry())
afterEach(() => {
  vi.useRealTimers()
  clearRegistry()
})

describe('export-jobs', () => {
  it('creates a rendering job with a jobId and totalScenes', () => {
    const job = createExportJob(3)
    expect(job.jobId).toBeTruthy()
    expect(job.status).toBe('rendering')
    expect(job.totalScenes).toBe(3)
    expect(job.progress).toBe(0)
    expect(getExportJob(job.jobId)).toMatchObject({ status: 'rendering', totalScenes: 3 })
  })

  it('merges progress then completion via updateExportJob', () => {
    const job = createExportJob(2)
    updateExportJob(job.jobId, { progress: 47, currentScene: 1 })
    expect(getExportJob(job.jobId)).toMatchObject({ status: 'rendering', progress: 47, currentScene: 1 })
    updateExportJob(job.jobId, { status: 'complete', outputPath: '/Users/me/Downloads/v.mp4', progress: 100 })
    expect(getExportJob(job.jobId)).toMatchObject({
      status: 'complete',
      outputPath: '/Users/me/Downloads/v.mp4',
      progress: 100,
    })
  })

  it('records an error status', () => {
    const job = createExportJob()
    updateExportJob(job.jobId, { status: 'error', error: 'render crashed' })
    expect(getExportJob(job.jobId)).toMatchObject({ status: 'error', error: 'render crashed' })
  })

  it('update on an unknown jobId is a no-op', () => {
    expect(() => updateExportJob('does-not-exist', { status: 'complete' })).not.toThrow()
    expect(getExportJob('does-not-exist')).toBeNull()
  })

  // ── T2 item 6: monotonic progress ────────────────────────────────────────
  describe('updateExportJob monotonic guard (T1 item 6)', () => {
    it('never regresses currentScene while still rendering', () => {
      const job = createExportJob(5)
      updateExportJob(job.jobId, { currentScene: 3, progress: 80 })
      // A stale, out-of-order update for an earlier scene must not move us back.
      updateExportJob(job.jobId, { currentScene: 1, progress: 10 })
      const after = getExportJob(job.jobId)
      expect(after?.currentScene).toBe(3)
      // ...and its per-scene progress is ignored too (it belonged to scene 1).
      expect(after?.progress).toBe(80)
    })

    it('still advances currentScene forward normally', () => {
      const job = createExportJob(5)
      updateExportJob(job.jobId, { currentScene: 2, progress: 50 })
      updateExportJob(job.jobId, { currentScene: 4, progress: 20 })
      expect(getExportJob(job.jobId)).toMatchObject({ currentScene: 4, progress: 20 })
    })

    it('a terminal completion bypasses the guard', () => {
      const job = createExportJob(5)
      updateExportJob(job.jobId, { currentScene: 4, progress: 90 })
      // completion arrives with currentScene reset — must still apply.
      updateExportJob(job.jobId, { status: 'complete', currentScene: 5, progress: 100 })
      expect(getExportJob(job.jobId)).toMatchObject({ status: 'complete', progress: 100 })
    })
  })

  // ── T2 item 7: prune never evicts a rendering job ─────────────────────────
  describe('prune (T2 item 7)', () => {
    it('evicts the oldest TERMINAL jobs but never a rendering one', () => {
      vi.useFakeTimers()
      // Fill the registry past MAX_JOBS (25) with terminal jobs, with one
      // rendering job as the very OLDEST (would be first evicted by age).
      vi.setSystemTime(1_000_000_000_000)
      const oldestRendering = createExportJob(1) // stays 'rendering'
      for (let i = 1; i <= 30; i++) {
        vi.setSystemTime(1_000_000_000_000 + i * 1000)
        const j = createExportJob(1)
        updateExportJob(j.jobId, { status: 'complete', progress: 100 })
      }
      // The oldest rendering job survives despite being the oldest by age.
      expect(getExportJob(oldestRendering.jobId)?.status).toBe('rendering')
      // The map was pruned back toward the cap (1 rendering + 25 cap window).
      expect(exportJobCount()).toBeLessThanOrEqual(26)
    })

    it('does not evict when every job is rendering, even past the cap', () => {
      vi.useFakeTimers()
      const ids: string[] = []
      for (let i = 0; i < 30; i++) {
        vi.setSystemTime(1_000_000_000_000 + i * 1000)
        ids.push(createExportJob(1).jobId) // all stay 'rendering'
      }
      // No rendering job is ever evicted — registry exceeds MAX_JOBS rather
      // than drop a live render.
      for (const id of ids) expect(getExportJob(id)).not.toBeNull()
      expect(exportJobCount()).toBe(30)
    })
  })

  // ── T2 edge case: empty registry after a main-process restart ─────────────
  it('returns null for any jobId after a restart wipes the in-memory registry', () => {
    const job = createExportJob(2)
    expect(getExportJob(job.jobId)).not.toBeNull()
    // Simulate a main-process restart: the global map is gone.
    clearRegistry()
    expect(exportJobCount()).toBe(0)
    expect(getExportJob(job.jobId)).toBeNull()
  })
})

describe('scene-indexed error fields (11b)', () => {
  it('a terminal error patch carries errorSceneIndex/errorSceneId through to readers', () => {
    const job = createExportJob(8)
    updateExportJob(job.jobId, {
      status: 'error',
      error: 'scene 5/8: boom',
      errorSceneIndex: 5,
      errorSceneId: 's5',
    })
    const read = getExportJob(job.jobId)
    expect(read?.status).toBe('error')
    expect(read?.errorSceneIndex).toBe(5)
    expect(read?.errorSceneId).toBe('s5')
    expect(read?.error).toBe('scene 5/8: boom')
  })
})

describe('errorJobPatch (11b — runner error → job patch mapping)', () => {
  it('maps the re-attached sceneIndex/sceneId onto the job fields', () => {
    const e = Object.assign(new Error('scene 3/8: boom'), { sceneIndex: 3, sceneId: 's3' })
    expect(errorJobPatch(e)).toEqual({
      status: 'error',
      error: 'scene 3/8: boom',
      errorSceneIndex: 3,
      errorSceneId: 's3',
    })
  })

  it('omits the fields when absent or malformed; stringifies non-Errors', () => {
    expect(errorJobPatch(new Error('plain failure'))).toEqual({ status: 'error', error: 'plain failure' })
    const bad = Object.assign(new Error('x'), { sceneIndex: NaN, sceneId: '' })
    expect(errorJobPatch(bad)).toEqual({ status: 'error', error: 'x' })
    expect(errorJobPatch('string reject')).toEqual({ status: 'error', error: 'string reject' })
  })
})
