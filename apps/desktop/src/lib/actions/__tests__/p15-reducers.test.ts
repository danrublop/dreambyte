// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState } from '../types'
import type { HotspotElement, CameraMove } from '@/lib/types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function baseState(): ProjectState {
  const scene = createDefaultScene()
  scene.id = 'scene-1'
  return {
    scenes: [scene],
    globalStyle: {
      presetId: null,
      palette: ['#000', '#111', '#222', '#333'],
      duration: 8,
    } as unknown as ProjectState['globalStyle'],
    project: createDefaultProject([scene]),
    selectedSceneId: scene.id,
    uiEditingLayerId: null,
  }
}

function hotspot(id: string, overrides: Partial<HotspotElement> = {}): HotspotElement {
  return {
    id,
    type: 'hotspot',
    x: 50,
    y: 50,
    width: 10,
    height: 10,
    appearsAt: 0,
    hidesAt: null,
    entranceAnimation: 'fade',
    label: id,
    shape: 'circle',
    style: 'pulse',
    color: '#fff',
    triggersEdgeId: null,
    jumpsToSceneId: null,
    ...overrides,
  }
}

// ── interaction/* ──────────────────────────────────────────────────────────

describe('interaction/add', () => {
  it('inserts at the end by default; inverse removes', () => {
    const state = baseState()
    const r1 = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h1', interaction: hotspot('h1') } },
      { source: 'user' },
    )
    expect(r1.result.success).toBe(true)
    expect(r1.result.state!.scenes[0].interactions.map((i) => i.id)).toEqual(['h1'])
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.scenes[0].interactions).toEqual([])
  })

  it('rejects duplicate ids', () => {
    let state = baseState()
    state = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h1', interaction: hotspot('h1') } },
      { source: 'user' },
    ).result.state!
    const { result } = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h1', interaction: hotspot('h1') } },
      { source: 'user' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('DUPLICATE_ID')
  })
})

describe('interaction/update', () => {
  it('patches a field and inverse restores prior value', () => {
    let state = baseState()
    state = dispatchSync(
      state,
      {
        type: 'interaction/add',
        params: { sceneId: 'scene-1', interactionId: 'h1', interaction: hotspot('h1', { label: 'a' }) },
      },
      { source: 'user' },
    ).result.state!
    const r1 = dispatchSync(
      state,
      {
        type: 'interaction/update',
        params: { sceneId: 'scene-1', interactionId: 'h1', patch: { label: 'b' } as Partial<HotspotElement> },
      },
      { source: 'user' },
    )
    expect((r1.result.state!.scenes[0].interactions[0] as HotspotElement).label).toBe('b')
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect((r2.result.state!.scenes[0].interactions[0] as HotspotElement).label).toBe('a')
  })
})

describe('interaction/remove', () => {
  it('removes the interaction and inverse re-inserts at the same index', () => {
    let state = baseState()
    state = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h1', interaction: hotspot('h1') } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h2', interaction: hotspot('h2') } },
      { source: 'user' },
    ).result.state!
    state = dispatchSync(
      state,
      { type: 'interaction/add', params: { sceneId: 'scene-1', interactionId: 'h3', interaction: hotspot('h3') } },
      { source: 'user' },
    ).result.state!

    const r1 = dispatchSync(
      state,
      { type: 'interaction/remove', params: { sceneId: 'scene-1', interactionId: 'h2' } },
      { source: 'user' },
    )
    expect(r1.result.state!.scenes[0].interactions.map((i) => i.id)).toEqual(['h1', 'h3'])
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.scenes[0].interactions.map((i) => i.id)).toEqual(['h1', 'h2', 'h3'])
  })
})

// ── camera/setMotion ───────────────────────────────────────────────────────

describe('camera/setMotion', () => {
  it('replaces motion and inverse restores prior', () => {
    const state = baseState()
    const initialMotion: CameraMove[] = [
      {
        type: 'pan',
        from: { x: 0, y: 0 },
        to: { x: 100, y: 0 },
        startAt: 0,
        duration: 1,
        easing: 'ease-in-out',
      } as unknown as CameraMove,
    ]
    state.scenes[0].cameraMotion = initialMotion

    const newMotion: CameraMove[] = []
    const r1 = dispatchSync(
      state,
      { type: 'camera/setMotion', params: { sceneId: 'scene-1', motion: newMotion } },
      { source: 'user' },
    )
    expect(r1.result.state!.scenes[0].cameraMotion).toEqual([])
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.scenes[0].cameraMotion).toEqual(initialMotion)
  })

  it('null clears the motion', () => {
    const state = baseState()
    state.scenes[0].cameraMotion = [] as CameraMove[]
    const { result } = dispatchSync(
      state,
      { type: 'camera/setMotion', params: { sceneId: 'scene-1', motion: null } },
      { source: 'user' },
    )
    expect(result.state!.scenes[0].cameraMotion).toBeNull()
  })
})

// ── audio/setLayer ─────────────────────────────────────────────────────────

describe('audio/setLayer', () => {
  it('patches only supplied audioLayer fields', () => {
    const state = baseState()
    const before = state.scenes[0].audioLayer
    const r1 = dispatchSync(
      state,
      { type: 'audio/setLayer', params: { sceneId: 'scene-1', patch: { volume: 0.5 } } },
      { source: 'user' },
    )
    expect(r1.result.state!.scenes[0].audioLayer.volume).toBe(0.5)
    // Other fields should be preserved
    expect(r1.result.state!.scenes[0].audioLayer.enabled).toBe(before.enabled)
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.scenes[0].audioLayer.volume).toBe(before.volume)
  })
})

// ── style/setSceneOverride ─────────────────────────────────────────────────

describe('style/setSceneOverride', () => {
  it('patches a single override field and inverse restores it', () => {
    const state = baseState()
    const r1 = dispatchSync(
      state,
      {
        type: 'style/setSceneOverride',
        params: { sceneId: 'scene-1', patch: { palette: ['#ff0', '#0ff', '#f0f', '#fff'] } },
      },
      { source: 'user' },
    )
    expect(r1.result.state!.scenes[0].styleOverride.palette).toEqual(['#ff0', '#0ff', '#f0f', '#fff'])
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.scenes[0].styleOverride.palette).toBeUndefined()
  })
})

// ── style/setGlobal ────────────────────────────────────────────────────────

describe('style/setGlobal', () => {
  it('patches globalStyle and inverse restores prior values', () => {
    const state = baseState()
    const beforePalette = state.globalStyle.palette
    const r1 = dispatchSync(
      state,
      {
        type: 'style/setGlobal',
        params: {
          patch: { palette: ['#fff', '#000', '#888', '#aaa'] } as unknown as Partial<ProjectState['globalStyle']>,
        },
      },
      { source: 'user' },
    )
    expect(r1.result.state!.globalStyle.palette).toEqual(['#fff', '#000', '#888', '#aaa'])
    const r2 = dispatchSync(r1.result.state!, r1.result.inverseAction!, { source: 'replay' })
    expect(r2.result.state!.globalStyle.palette).toEqual(beforePalette)
  })
})
