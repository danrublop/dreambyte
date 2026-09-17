// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProjectAsset } from '@/lib/types'

// ── Store mock (same pattern as timeline-import.test.ts) ────────────────────

interface MockTrack {
  id: string
  type: string
  locked: boolean
  position: number
  clips: Array<{ id: string; startTime: number; duration: number }>
}

interface MockStoreState {
  project: { timeline: { tracks: MockTrack[] } | null; mp4Settings?: unknown }
  scenes: Array<{ id: string; videoLayer: { enabled: boolean; src: string | null; opacity: number } }>
  initTimeline: ReturnType<typeof vi.fn>
  addTrack: ReturnType<typeof vi.fn>
  addClip: ReturnType<typeof vi.fn>
  batchUpdateClips: ReturnType<typeof vi.fn>
  addScene: ReturnType<typeof vi.fn>
  updateScene: ReturnType<typeof vi.fn>
  saveSceneHTML: ReturnType<typeof vi.fn>
  syncTimelineFromScenes: ReturnType<typeof vi.fn>
  updateClip: ReturnType<typeof vi.fn>
}

let mockState: MockStoreState

function freshState(tracks: MockTrack[] = []): MockStoreState {
  return {
    project: { timeline: { tracks } },
    scenes: [{ id: 'scene-new', videoLayer: { enabled: false, src: null, opacity: 1 } }],
    initTimeline: vi.fn(),
    addTrack: vi.fn((kind: string) => `track-${kind}-1`),
    addClip: vi.fn(() => 'clip-1'),
    batchUpdateClips: vi.fn(),
    addScene: vi.fn(() => 'scene-new'),
    updateScene: vi.fn(),
    saveSceneHTML: vi.fn(),
    syncTimelineFromScenes: vi.fn(),
    updateClip: vi.fn(),
  }
}

vi.mock('@/lib/store', () => ({
  useVideoStore: { getState: () => mockState },
}))

const { addAssetToTimeline } = await import('./add-asset-to-timeline')

function asset(over: Partial<ProjectAsset>): ProjectAsset {
  return {
    id: 'a1',
    name: 'test-asset',
    type: 'image',
    publicUrl: '/media/a1.png',
    ...over,
  } as ProjectAsset
}

beforeEach(() => {
  mockState = freshState([{ id: 'V1', type: 'video', locked: false, position: 0, clips: [] }])
})

describe('addAssetToTimeline — media becomes its OWN scene (no pre-selected scene required)', () => {
  it('video assets create a scene with the asset as its videoLayer', async () => {
    const r = await addAssetToTimeline(asset({ type: 'video', publicUrl: '/media/a1.mp4', durationSeconds: 12.5 }))
    expect(r.ok).toBe(true)
    expect(mockState.addScene).toHaveBeenCalled()
    expect(mockState.updateScene).toHaveBeenCalledWith(
      'scene-new',
      expect.objectContaining({
        name: 'test-asset',
        duration: 12.5,
        videoLayer: expect.objectContaining({ enabled: true, src: '/media/a1.mp4', trimStart: 0, trimEnd: null }),
      }),
    )
    expect(mockState.saveSceneHTML).toHaveBeenCalledWith('scene-new')
    expect(mockState.addClip).not.toHaveBeenCalled()
  })

  it('rejects a reference document instead of adding it as an image', async () => {
    const r = await addAssetToTimeline(asset({ type: 'doc', name: 'notes.md', publicUrl: '/media/notes.md' }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/document/i)
    // Must NOT fall through to the image-scene path.
    expect(mockState.addScene).not.toHaveBeenCalled()
  })

  it('avatar renders ride the videoLayer path too', async () => {
    const r = await addAssetToTimeline(asset({ type: 'avatar', publicUrl: '/media/av.mp4', durationSeconds: 6 }))
    expect(r.ok).toBe(true)
    expect(mockState.updateScene).toHaveBeenCalledWith(
      'scene-new',
      expect.objectContaining({ videoLayer: expect.objectContaining({ src: '/media/av.mp4' }) }),
    )
  })

  it('image assets create a 5s scene with a ready image aiLayer', async () => {
    const r = await addAssetToTimeline(asset({ type: 'image' }))
    expect(r.ok).toBe(true)
    expect(mockState.addScene).toHaveBeenCalled()
    const patch = mockState.updateScene.mock.calls[0][1]
    expect(patch.duration).toBe(5)
    expect(patch.aiLayers).toHaveLength(1)
    expect(patch.aiLayers[0]).toMatchObject({ type: 'image', imageUrl: '/media/a1.png', status: 'ready' })
    expect(mockState.saveSceneHTML).toHaveBeenCalledWith('scene-new')
  })

  it('svg assets ride the same image-layer scene path', async () => {
    const r = await addAssetToTimeline(asset({ type: 'svg', publicUrl: '/media/a1.svg' }))
    expect(r.ok).toBe(true)
    const patch = mockState.updateScene.mock.calls[0][1]
    expect(patch.aiLayers[0].imageUrl).toBe('/media/a1.svg')
  })

  it('audio assets stay clips on an audio track (no scene)', async () => {
    mockState = freshState([
      { id: 'V1', type: 'video', locked: false, position: 0, clips: [] },
      { id: 'A1', type: 'audio', locked: false, position: 1, clips: [] },
    ])
    const r = await addAssetToTimeline(asset({ type: 'audio', publicUrl: '/media/a1.mp3', durationSeconds: 8 }))
    expect(r.ok).toBe(true)
    expect(mockState.addScene).not.toHaveBeenCalled()
    expect(mockState.addClip).toHaveBeenCalledWith('A1', expect.objectContaining({ sourceType: 'audio', duration: 8 }))
  })

  it('audio creates an audio track when none exists, honoring insert mode', async () => {
    mockState = freshState([
      { id: 'A1', type: 'audio', locked: false, position: 0, clips: [{ id: 'c0', startTime: 4, duration: 6 }] },
    ])
    await addAssetToTimeline(asset({ type: 'audio', publicUrl: '/m.mp3', durationSeconds: 3 }), {
      startTime: 2,
      insert: true,
    })
    expect(mockState.batchUpdateClips).toHaveBeenCalledWith([{ id: 'c0', updates: { startTime: 7 } }])
    expect(mockState.addClip).toHaveBeenCalledWith('A1', expect.objectContaining({ startTime: 2 }))
  })
})

describe('linked A/V pair for video drops', () => {
  it('creates a linked audio clip on the audio track when the asset has audio', async () => {
    mockState = freshState([
      {
        id: 'V1',
        type: 'video',
        locked: false,
        position: 0,
        clips: [{ id: 'sc1', startTime: 3, duration: 12.5, sourceType: 'scene', sourceId: 'scene-new' } as never],
      },
      { id: 'A1', type: 'audio', locked: false, position: 1, clips: [] },
    ])
    const r = await addAssetToTimeline(
      asset({ type: 'video', publicUrl: '/m/v.mp4', durationSeconds: 12.5, tags: ['has-audio'] }),
    )
    expect(r.ok).toBe(true)
    expect(mockState.addClip).toHaveBeenCalledWith(
      'A1',
      expect.objectContaining({
        sourceType: 'audio',
        sourceId: '/m/v.mp4',
        startTime: 3,
        linkGroupId: 'avlink:scene-new',
      }),
    )
    expect(mockState.updateClip).toHaveBeenCalledWith('sc1', { linkGroupId: 'avlink:scene-new' })
  })

  it("skips the pair when the upload probe proved 'no-audio'", async () => {
    mockState = freshState([
      {
        id: 'V1',
        type: 'video',
        locked: false,
        position: 0,
        clips: [{ id: 'sc1', startTime: 0, duration: 5, sourceType: 'scene', sourceId: 'scene-new' } as never],
      },
      { id: 'A1', type: 'audio', locked: false, position: 1, clips: [] },
    ])
    await addAssetToTimeline(asset({ type: 'video', publicUrl: '/m/v.mp4', durationSeconds: 5, tags: ['no-audio'] }))
    expect(mockState.addClip).not.toHaveBeenCalled()
  })
})
