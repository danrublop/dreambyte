// E5 — trim-aware context durations.
//
// The agent re-times footage the user already cut because context durations come
// only from scene.duration while timeline sync preserves clip trims. buildWorldState
// now accepts a timeline and surfaces the effective (trimmed) clip duration so the
// agent stops re-timing cut footage. No timeline → behavior unchanged (regression).

import { describe, expect, it } from 'vitest'
import { buildWorldState, serializeWorldState } from './context-builder'
import type { Scene, GlobalStyle, Timeline, Clip } from '../types'

function scene(id: string, duration: number): Scene {
  return {
    id,
    name: id.toUpperCase(),
    prompt: 'a scene',
    sceneType: 'react',
    duration,
    bgColor: '#000',
    transition: 'none',
  } as unknown as Scene
}

const STYLE: GlobalStyle = {
  presetId: null,
  palette: ['#000', '#111', '#222', '#333'],
  duration: 8,
  theme: 'light',
} as unknown as GlobalStyle

function sceneClip(sceneId: string, duration: number, trimStart: number, trimEnd: number | null): Clip {
  return {
    id: `clip-${sceneId}`,
    trackId: 'v1',
    sourceType: 'scene',
    sourceId: sceneId,
    label: sceneId,
    startTime: 0,
    duration,
    trimStart,
    trimEnd,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
  } as Clip
}

function timeline(clips: Clip[]): Timeline {
  return { tracks: [{ id: 'v1', name: 'V1', type: 'scene', clips, muted: false, locked: false, position: 0 }] }
}

describe('E5 effective (trimmed) durations in world state', () => {
  it('renders effective duration for a trimmed scene clip', () => {
    const scenes = [scene('s1', 8)]
    // 8s scene, clip trimmed to play 4s.
    const tl = timeline([sceneClip('s1', 4, 0, 4)])
    const world = buildWorldState(scenes, STYLE, 'P', 'mp4', null, tl)
    const out = serializeWorldState(world)
    expect(out).toContain('dur:8s (plays 4s — clip trimmed)')
  })

  it('uses plain dur for a full-length (untrimmed) clip', () => {
    const scenes = [scene('s1', 8)]
    const tl = timeline([sceneClip('s1', 8, 0, null)])
    const world = buildWorldState(scenes, STYLE, 'P', 'mp4', null, tl)
    const out = serializeWorldState(world)
    expect(out).toContain('dur:8s bg:')
    expect(out).not.toContain('plays')
  })

  it('regression: no timeline → unchanged plain dur', () => {
    const scenes = [scene('s1', 8)]
    const world = buildWorldState(scenes, STYLE, 'P', 'mp4', null)
    const out = serializeWorldState(world)
    expect(out).toContain('dur:8s bg:')
    expect(out).not.toContain('plays')
  })

  it('does not surface a trim that does not actually shorten the scene', () => {
    const scenes = [scene('s1', 8)]
    // trimStart 1 (so "trimmed" by the recognizer) but plays the full 8s.
    const tl = timeline([sceneClip('s1', 8, 1, null)])
    const world = buildWorldState(scenes, STYLE, 'P', 'mp4', null, tl)
    const out = serializeWorldState(world)
    expect(out).not.toContain('plays')
  })

  it('ignores a timeline with no clip for the scene', () => {
    const scenes = [scene('s1', 8)]
    const tl = timeline([sceneClip('other', 4, 0, 4)])
    const world = buildWorldState(scenes, STYLE, 'P', 'mp4', null, tl)
    const out = serializeWorldState(world)
    expect(out).not.toContain('plays')
  })
})
