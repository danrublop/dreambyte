// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { computeSurvivingCuts } from './structural-cuts'
import type { StructuralCut } from './types'
import type { Clip, Scene, Timeline } from '@/lib/types'
import { createDefaultScene } from '@/lib/store/helpers'

function scene(id: string, name: string, duration = 8): Scene {
  return { ...createDefaultScene(), id, name, duration }
}

function clip(id: string, sourceType: Clip['sourceType'], sourceId: string): Clip {
  return {
    id,
    trackId: 't',
    sourceType,
    sourceId,
    label: id,
    startTime: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
  }
}

const cut = (sceneId: string, sceneName: string, detail = 'repeats scene 1'): StructuralCut => ({
  sceneId,
  sceneName,
  detail,
  kind: 'redundancy',
})

describe('computeSurvivingCuts', () => {
  it('returns [] for null/empty proposals', () => {
    expect(computeSurvivingCuts(null, [], null)).toEqual([])
    expect(computeSurvivingCuts([], [scene('s1', 'a')], null)).toEqual([])
  })

  it('defensively dedups by sceneId (one row per scene)', () => {
    const scenes = [scene('s1', 'Intro'), scene('s2', 'Recap')]
    const proposed = [cut('s2', 'Recap', 'repeats 1'), cut('s2', 'Recap', 'also repeats 1')]
    const survivors = computeSurvivingCuts(proposed, scenes, null)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].cut.detail).toBe('repeats 1')
  })

  it('drops a cut whose scene no longer exists (live re-read)', () => {
    const scenes = [scene('s1', 'Intro'), scene('s2', 'Body')]
    const proposed = [cut('s2', 'Body'), cut('gone', 'Deleted recap')]
    const survivors = computeSurvivingCuts(proposed, scenes, null)
    expect(survivors.map((s) => s.cut.sceneId)).toEqual(['s2'])
  })

  it('reports the live 1-based position and live scene (not the proposal snapshot)', () => {
    const scenes = [scene('s1', 'Intro'), scene('s2', 'Recap', 12)]
    // Proposal carried a stale name; the card should surface the LIVE scene.
    const survivors = computeSurvivingCuts([cut('s2', 'Old name')], scenes, null)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].position).toBe(2)
    expect(survivors[0].scene.name).toBe('Recap')
    expect(survivors[0].scene.duration).toBe(12)
    expect(survivors[0].clipImpact).toBe(0) // no timeline
  })

  it('counts dependent timeline clips (scene + derived audio + avatar) as impact', () => {
    const s2 = scene('s2', 'Recap')
    s2.aiLayers = [{ id: 'av1', type: 'avatar' } as unknown as (typeof s2.aiLayers)[number]]
    const scenes = [scene('s1', 'Intro'), s2]
    const timeline: Timeline = {
      tracks: [
        {
          id: 'main',
          name: 'Main',
          type: 'scene',
          muted: false,
          locked: false,
          position: 0,
          clips: [
            clip('sc1', 'scene', 's1'), // belongs to s1 — not counted
            clip('sc2', 'scene', 's2'), // s2 scene clip
            clip('tts2', 'audio', 'tts-s2'), // s2 narration
            { ...clip('avv', 'avatar', 'av1'), linkGroupId: 'avatar:av1' }, // s2 avatar video
            { ...clip('ava', 'audio', 'avatar-audio:av1'), linkGroupId: 'avatar:av1' }, // s2 avatar audio
            clip('other', 'audio', 'voiceover'), // unrelated
          ],
        },
      ],
    }
    const survivors = computeSurvivingCuts([cut('s2', 'Recap')], scenes, timeline)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].clipImpact).toBe(4) // sc2 + tts2 + avv + ava
  })
})
