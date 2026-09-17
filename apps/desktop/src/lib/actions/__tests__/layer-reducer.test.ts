// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { dispatchSync } from '../executor'
import type { ProjectState, AILayer } from '../types'
import { createDefaultProject, createDefaultScene } from '@/lib/store/helpers'

function makeState(): ProjectState {
  const scene = createDefaultScene()
  scene.id = 'scene-1'
  scene.aiLayers = []
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

function makeLayer(id: string, prompt = 'circle'): AILayer {
  return {
    id,
    type: 'veo3',
    prompt,
    negativePrompt: null,
    aspectRatio: '16:9',
    duration: 5,
    loop: false,
    playbackRate: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    opacity: 1,
    zIndex: 0,
    videoUrl: null,
    thumbnailUrl: null,
    status: 'pending',
    operationName: null,
    startAt: 0,
    label: id,
  } as unknown as AILayer
}

describe('layer reducer', () => {
  it('layer/add inserts a layer; inverse removes it', () => {
    const state = makeState()
    const layer = makeLayer('L1')
    const { result } = dispatchSync(
      state,
      { type: 'layer/add', params: { sceneId: 'scene-1', layerId: 'L1', layer } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.scenes[0].aiLayers!.map((l) => l.id)).toEqual(['L1'])

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.state!.scenes[0].aiLayers!).toEqual([])
  })

  it('layer/update patches a layer and inverse restores prior values', () => {
    const state = makeState()
    state.scenes[0].aiLayers = [makeLayer('L1')]
    const { result } = dispatchSync(
      state,
      { type: 'layer/update', params: { sceneId: 'scene-1', layerId: 'L1', patch: { prompt: 'square' } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect((result.state!.scenes[0].aiLayers![0] as { prompt: string }).prompt).toBe('square')

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect((undone.state!.scenes[0].aiLayers![0] as { prompt: string }).prompt).toBe('circle')
  })

  it('agent dispatch is rejected when the user is editing the same layer', () => {
    const state = makeState()
    state.scenes[0].aiLayers = [makeLayer('L1')]
    state.uiEditingLayerId = 'L1'
    const { result } = dispatchSync(
      state,
      { type: 'layer/update', params: { sceneId: 'scene-1', layerId: 'L1', patch: { prompt: 'agent edit' } } },
      { source: 'agent' },
    )
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('LAYER_EDITING')
  })

  it('user dispatch passes through even when editing — the lock only blocks agents', () => {
    const state = makeState()
    state.scenes[0].aiLayers = [makeLayer('L1')]
    state.uiEditingLayerId = 'L1'
    const { result } = dispatchSync(
      state,
      { type: 'layer/update', params: { sceneId: 'scene-1', layerId: 'L1', patch: { prompt: 'user edit' } } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
  })

  it('layer/remove removes a layer and inverse restores it at the same index', () => {
    const state = makeState()
    state.scenes[0].aiLayers = [makeLayer('L1'), makeLayer('L2'), makeLayer('L3')]
    const { result } = dispatchSync(
      state,
      { type: 'layer/remove', params: { sceneId: 'scene-1', layerId: 'L2' } },
      { source: 'user' },
    )
    expect(result.success).toBe(true)
    expect(result.state!.scenes[0].aiLayers!.map((l) => l.id)).toEqual(['L1', 'L3'])

    const { result: undone } = dispatchSync(result.state!, result.inverseAction!, { source: 'replay' })
    expect(undone.state!.scenes[0].aiLayers!.map((l) => l.id)).toEqual(['L1', 'L2', 'L3'])
  })
})
