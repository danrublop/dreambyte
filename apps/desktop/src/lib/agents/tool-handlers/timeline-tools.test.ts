// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture emitted actions so we can assert init_timeline is replayable.
const emitted: Array<{ type: string; params: any }> = []
vi.mock('./action-emitter', () => ({
  emitAgentAction: (input: { type: string; params: any }) => {
    emitted.push(input)
    return { id: 'a', ...input }
  },
  emitterDepsForWorld: () => ({ projectId: 'p', runId: 'r' }),
}))

import { createTimelineToolHandler } from './timeline-tools'
import { setPcmDecoder, type DecodedPcm } from '@/lib/edit-engines/pcm-decoder'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { Clip, Track } from '@/lib/types'

const handler = createTimelineToolHandler({ executeTool: (async () => ({ success: true })) as any })

/** Deterministic PCM with transient bursts (identical seed → identical content). */
function burstsPcm(durationSec = 10, seed = 7): DecodedPcm {
  const SR = 48000
  const n = Math.round(durationSec * SR)
  const samples = new Float32Array(n)
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff)
  for (let i = 0; i < n; i++) samples[i] = 0.001 * (rand() - 0.5)
  for (let b = 0; b < 6; b++) {
    const at = Math.round(rand() * (durationSec - 0.3) * SR)
    for (let k = 0; k < 0.05 * SR && at + k < n; k++) {
      samples[at + k] += 0.6 * Math.sin((2 * Math.PI * 440 * k) / SR)
    }
  }
  return { samples, sampleRate: SR }
}

function makeClip(over: Partial<Clip> & { id: string; trackId: string }): Clip {
  return {
    sourceType: 'scene',
    sourceId: 's1',
    label: 'c',
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
    transition: null,
    ...over,
  } as Clip
}

function makeTrack(over: Partial<Track> & { id: string }): Track {
  return { name: 'V1', type: 'video', clips: [], muted: false, locked: false, position: 0, ...over } as Track
}

function makeWorld(tracks: Track[], scenes: any[] = []): WorldStateMutable {
  return {
    scenes,
    projectId: 'project-test',
    currentRunId: 'run-test',
    timeline: tracks.length ? { tracks } : null,
  } as unknown as WorldStateMutable
}

beforeEach(() => {
  emitted.length = 0
})

describe('clip-targeting tools fail on an unknown clipId (no silent success)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['clip', { op: 'trim', clipId: 'nope', duration: 3 }],
    ['keyframe', { action: 'set', clipId: 'nope', property: 'opacity', time: 1, value: 0.5 }],
    ['keyframe', { action: 'remove', clipId: 'nope', property: 'opacity', time: 1 }],
    ['clip', { op: 'props', clipId: 'nope', filter: { filterType: 'blur', value: 2 } }],
    ['clip', { op: 'props', clipId: 'nope', filter: { filterType: 'blur' } }],
    ['clip', { op: 'props', clipId: 'nope', blendMode: 'screen' }],
  ]
  it.each(cases)('%s on a missing clip → success:false', async (tool, args) => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler(tool, args, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('trim_clip on an existing clip still succeeds', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler('clip', { op: 'trim', clipId: 'c1', duration: 3 }, world)
    expect(res.success).toBe(true)
    expect(world.timeline!.tracks[0].clips[0].duration).toBe(3)
  })
})

describe('clip', () => {
  it('to a non-existent track → fails and does NOT delete the clip', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler('clip', { op: 'move', clipId: 'c1', toTrackId: 'ghost', startTime: 2 }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/track ghost not found/i)
    // The clip must still be on V1 — not vanished.
    expect(world.timeline!.tracks[0].clips.find((c) => c.id === 'c1')).toBeTruthy()
  })

  it('clamps a negative startTime to 0', async () => {
    // A VIDEO clip (not scene) — scene clips are sync-managed on V1 and refuse
    // a cross-track move (v6 B3), so the clamp is exercised with a clip type
    // that can legitimately cross tracks.
    const world = makeWorld([
      makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1', sourceType: 'video', sourceId: 'v1' })] }),
      makeTrack({ id: 'V2', position: 1, clips: [] }),
    ])
    const res = await handler('clip', { op: 'move', clipId: 'c1', toTrackId: 'V2', startTime: -5 }, world)
    expect(res.success).toBe(true)
    const moved = world.timeline!.tracks.find((t) => t.id === 'V2')!.clips.find((c) => c.id === 'c1')!
    expect(moved.startTime).toBe(0)
  })

  it('unknown clip → fails', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [] })])
    const res = await handler('clip', { op: 'move', clipId: 'nope', toTrackId: 'V1', startTime: 0 }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('P2: an audio move onto an OCCUPIED audio lane spills to a free lane (no stack)', async () => {
    // A1 already holds `existing` at [0,5]. Moving `mover` onto A1 at t=1 would
    // stack two clips on one audio track — the per-scene mixer can't separate
    // them. move_clip must spill to the free lane A2 instead (mirrors place_clip).
    const world = makeWorld([
      makeTrack({
        id: 'A1',
        type: 'audio',
        name: 'A1',
        clips: [
          makeClip({ id: 'existing', trackId: 'A1', sourceType: 'audio', sourceId: 'm1', startTime: 0, duration: 5 }),
          makeClip({ id: 'mover', trackId: 'A1', sourceType: 'audio', sourceId: 'm2', startTime: 10, duration: 3 }),
        ],
      }),
      makeTrack({ id: 'A2', type: 'audio', name: 'A2', position: 1, clips: [] }),
    ])
    const res = await handler('clip', { op: 'move', clipId: 'mover', toTrackId: 'A1', startTime: 1 }, world)
    expect(res.success).toBe(true)
    expect(res.changes?.[0]?.description).toMatch(/spilled/i)
    // A1 keeps ONLY `existing`; `mover` lands on A2 — never two clips stacked on A1.
    const a1 = world.timeline!.tracks.find((t) => t.id === 'A1')!
    const a2 = world.timeline!.tracks.find((t) => t.id === 'A2')!
    expect(a1.clips.map((c) => c.id)).toEqual(['existing'])
    expect(a2.clips.map((c) => c.id)).toEqual(['mover'])
    expect(a2.clips[0].startTime).toBe(1)
  })

  it('P2: an audio move onto an occupied lane MINTS a new lane when none is free', async () => {
    // Only A1 exists and it is occupied at the destination — the spill mints A2.
    const world = makeWorld([
      makeTrack({
        id: 'A1',
        type: 'audio',
        name: 'A1',
        clips: [
          makeClip({ id: 'existing', trackId: 'A1', sourceType: 'audio', sourceId: 'm1', startTime: 0, duration: 5 }),
          makeClip({ id: 'mover', trackId: 'A1', sourceType: 'audio', sourceId: 'm2', startTime: 10, duration: 3 }),
        ],
      }),
    ])
    const res = await handler('clip', { op: 'move', clipId: 'mover', toTrackId: 'A1', startTime: 1 }, world)
    expect(res.success).toBe(true)
    const audioTracks = world.timeline!.tracks.filter((t) => t.type === 'audio')
    expect(audioTracks).toHaveLength(2) // A1 + a freshly minted lane
    const a1 = world.timeline!.tracks.find((t) => t.id === 'A1')!
    expect(a1.clips.map((c) => c.id)).toEqual(['existing'])
    const minted = audioTracks.find((t) => t.id !== 'A1')!
    expect(minted.clips.map((c) => c.id)).toEqual(['mover'])
    // A track/add action was emitted for the minted lane so the renderer rebuilds it.
    expect(emitted.some((e) => e.type === 'track/add' && e.params.type === 'audio')).toBe(true)
  })

  it('P2: a same-lane audio nudge that only overlaps ITSELF does NOT spill', async () => {
    // `solo` is the only clip on A1. Nudging it within A1 (overlapping just its own
    // old span) is a normal move — excludeId=clipId means no false spill.
    const world = makeWorld([
      makeTrack({
        id: 'A1',
        type: 'audio',
        name: 'A1',
        clips: [
          makeClip({ id: 'solo', trackId: 'A1', sourceType: 'audio', sourceId: 'm1', startTime: 5, duration: 4 }),
        ],
      }),
      makeTrack({ id: 'A2', type: 'audio', name: 'A2', position: 1, clips: [] }),
    ])
    const res = await handler('clip', { op: 'move', clipId: 'solo', toTrackId: 'A1', startTime: 6 }, world)
    expect(res.success).toBe(true)
    expect(res.changes?.[0]?.description ?? '').not.toMatch(/spilled/i)
    const a1 = world.timeline!.tracks.find((t) => t.id === 'A1')!
    const a2 = world.timeline!.tracks.find((t) => t.id === 'A2')!
    expect(a1.clips.map((c) => c.id)).toEqual(['solo'])
    expect(a2.clips).toHaveLength(0)
    expect(a1.clips[0].startTime).toBe(6)
  })
})

describe('sync_audio same-track overlap', () => {
  // Identical content → lag 0 → the follower's synced start lands exactly on the
  // reference. On a SHARED audio track that means two overlapping clips (audio is
  // 'allow' overlap policy, so move_clip would silently stack them).
  const decodeIdentical = {
    async decode(): Promise<DecodedPcm> {
      return burstsPcm()
    },
  }

  it('refuses to sync a follower that would overlap the reference on their shared track', async () => {
    setPcmDecoder(decodeIdentical)
    try {
      const world = makeWorld([
        makeTrack({
          id: 'A1',
          type: 'audio',
          name: 'A1',
          clips: [
            makeClip({ id: 'ref', trackId: 'A1', sourceType: 'audio', sourceId: 'ref', startTime: 5, duration: 10 }),
            makeClip({ id: 'tgt', trackId: 'A1', sourceType: 'audio', sourceId: 'tgt', startTime: 18, duration: 10 }),
          ],
        }),
      ])
      const res = await handler(
        'sync_audio',
        { referenceClipId: 'ref', targetClipId: 'tgt', searchWindowSeconds: 5 },
        world,
      )
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/own audio track|shared track|overlap/i)
      // The follower must NOT have moved on top of the reference.
      const tgt = world.timeline!.tracks[0].clips.find((c) => c.id === 'tgt')!
      expect(tgt.startTime).toBe(18)
    } finally {
      setPcmDecoder(null)
    }
  })

  it('syncs a follower that lives on its own audio track', async () => {
    setPcmDecoder(decodeIdentical)
    try {
      const world = makeWorld([
        makeTrack({
          id: 'A1',
          type: 'audio',
          name: 'A1',
          clips: [
            makeClip({ id: 'ref', trackId: 'A1', sourceType: 'audio', sourceId: 'ref', startTime: 5, duration: 10 }),
          ],
        }),
        makeTrack({
          id: 'A2',
          type: 'audio',
          name: 'A2',
          position: 1,
          clips: [
            makeClip({ id: 'tgt', trackId: 'A2', sourceType: 'audio', sourceId: 'tgt', startTime: 18, duration: 10 }),
          ],
        }),
      ])
      const res = await handler(
        'sync_audio',
        { referenceClipId: 'ref', targetClipId: 'tgt', searchWindowSeconds: 5 },
        world,
      )
      expect(res.success).toBe(true)
    } finally {
      setPcmDecoder(null)
    }
  })

  it('preview mode reports an offset without moving the clip', async () => {
    setPcmDecoder(decodeIdentical)
    try {
      const world = makeWorld([
        makeTrack({
          id: 'A1',
          type: 'audio',
          name: 'A1',
          clips: [
            makeClip({ id: 'ref', trackId: 'A1', sourceType: 'audio', sourceId: 'ref', startTime: 5, duration: 10 }),
          ],
        }),
        makeTrack({
          id: 'A2',
          type: 'audio',
          name: 'A2',
          position: 1,
          clips: [
            makeClip({ id: 'tgt', trackId: 'A2', sourceType: 'audio', sourceId: 'tgt', startTime: 18, duration: 10 }),
          ],
        }),
      ])
      const res = await handler(
        'sync_audio',
        { referenceClipId: 'ref', targetClipId: 'tgt', searchWindowSeconds: 5, preview: true },
        world,
      )
      expect(res.success).toBe(true)
      expect((res.data as any)?.preview).toBe(true)
      // The clip must NOT have moved in preview mode.
      const tgt = world.timeline!.tracks.find((t) => t.id === 'A2')!.clips.find((c) => c.id === 'tgt')!
      expect(tgt.startTime).toBe(18)
    } finally {
      setPcmDecoder(null)
    }
  })

  it('multi-target: one matchable + one missing → success with both synced[] and failed[]', async () => {
    setPcmDecoder(decodeIdentical)
    try {
      const world = makeWorld([
        makeTrack({
          id: 'A1',
          type: 'audio',
          name: 'A1',
          clips: [
            makeClip({ id: 'ref', trackId: 'A1', sourceType: 'audio', sourceId: 'ref', startTime: 5, duration: 10 }),
          ],
        }),
        makeTrack({
          id: 'A2',
          type: 'audio',
          name: 'A2',
          position: 1,
          clips: [
            makeClip({ id: 'tgt', trackId: 'A2', sourceType: 'audio', sourceId: 'tgt', startTime: 18, duration: 10 }),
          ],
        }),
      ])
      const res = await handler(
        'sync_audio',
        { referenceClipId: 'ref', targetClipIds: ['tgt', 'ghost'], searchWindowSeconds: 5 },
        world,
      )
      expect(res.success).toBe(true)
      expect((res.data as any)?.synced).toHaveLength(1)
      expect((res.data as any)?.failed).toHaveLength(1)
      expect((res.data as any)?.failed[0].clipId).toBe('ghost')
    } finally {
      setPcmDecoder(null)
    }
  })
})

describe('decode/transcribe tools resolve synthetic scene-mirror sourceIds', () => {
  // auto_cut_silence / cut_by_transcript / add_captions pass the clip's source to
  // ffmpeg / the transcriber. Scene-mirror clips carry synthetic ids (tts-/mus-/
  // aud-<sceneId>) ffmpeg can't open; the handler must resolve them to the real
  // audioLayer URL first. (sync_audio shipped this resolver; these tools shared
  // the same bug.)
  it('auto_cut_silence decodes the real audioLayer URL, not the synthetic tts- id', async () => {
    let decodedSource: string | null = null
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        decodedSource = source
        return burstsPcm()
      },
    })
    try {
      const scenes = [{ id: 's1', audioLayer: { tts: { src: 'file:///real-narration.wav' } } }]
      const world = makeWorld(
        [
          makeTrack({
            id: 'A1',
            type: 'audio',
            name: 'A1',
            clips: [makeClip({ id: 'c1', trackId: 'A1', sourceType: 'audio', sourceId: 'tts-s1', duration: 10 })],
          }),
        ],
        scenes,
      )
      // preview:true → computes spans without mutating; still exercises the decode.
      const res = await handler('auto_cut', { mode: 'silence', clipId: 'c1', preview: true }, world)
      expect(res.success).toBe(true)
      expect(decodedSource).toBe('file:///real-narration.wav')
    } finally {
      setPcmDecoder(null)
    }
  })

  it('falls back to sourceId for imported clips (id not in the scene map)', async () => {
    let decodedSource: string | null = null
    setPcmDecoder({
      async decode(source: string): Promise<DecodedPcm> {
        decodedSource = source
        return burstsPcm()
      },
    })
    try {
      const world = makeWorld(
        [
          makeTrack({
            id: 'A1',
            type: 'audio',
            name: 'A1',
            clips: [
              makeClip({
                id: 'c1',
                trackId: 'A1',
                sourceType: 'audio',
                sourceId: 'dreambyte://uploads/take.wav',
                duration: 10,
              }),
            ],
          }),
        ],
        [],
      )
      const res = await handler('auto_cut', { mode: 'silence', clipId: 'c1', preview: true }, world)
      expect(res.success).toBe(true)
      expect(decodedSource).toBe('dreambyte://uploads/take.wav')
    } finally {
      setPcmDecoder(null)
    }
  })
})

// ── B3 (v6): verb-level honesty + write-through ─────────────────────────────
describe('B3 verb honesty', () => {
  it('set_clip_props(speed) REFUSES honestly (speed not exported; would cut content)', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler('clip', { op: 'props', clipId: 'c1', speed: 2 }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not available yet/i)
    expect(res.error).toMatch(/trim_clip|set_scene_duration/)
    // No stealth mutation: the clip's duration/speed are untouched.
    expect(world.timeline!.tracks[0].clips[0].duration).toBe(5)
    expect(world.timeline!.tracks[0].clips[0].speed).toBe(1)
  })

  it('remove_clip REFUSES a scene clip (points at delete_scene)', async () => {
    const world = makeWorld(
      [makeTrack({ id: 'V1', clips: [makeClip({ id: 'cs', trackId: 'V1', sourceType: 'scene', sourceId: 'sx' })] })],
      [{ id: 'sx', duration: 5 }],
    )
    const res = await handler('clip', { op: 'remove', clipId: 'cs' }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/delete_scene/)
    // The scene clip survives the refusal.
    expect(world.timeline!.tracks[0].clips.find((c) => c.id === 'cs')).toBeTruthy()
  })

  it('remove_clip strips the avatar source (aiLayers) so the next sync cannot resurrect it', async () => {
    const world = makeWorld(
      [
        makeTrack({
          id: 'V2',
          clips: [
            makeClip({ id: 'av', trackId: 'V2', sourceType: 'avatar', sourceId: 'lay', linkGroupId: 'avatar:lay' }),
          ],
        }),
      ],
      [{ id: 'sx', duration: 10, aiLayers: [{ id: 'lay', type: 'avatar', label: 'Host', startAt: 0 }] }],
    )
    const res = await handler('clip', { op: 'remove', clipId: 'av' }, world)
    expect(res.success).toBe(true)
    // The avatar layer is gone from scene SOURCE — sync re-derives nothing.
    expect((world.scenes[0] as any).aiLayers).toEqual([])
  })

  it('move_clip writes the avatar startAt back into world.scenes (durable across sync)', async () => {
    const world = makeWorld(
      [
        makeTrack({ id: 'V1', clips: [makeClip({ id: 'cs', trackId: 'V1', sourceType: 'scene', sourceId: 'sx' })] }),
        makeTrack({
          id: 'V2',
          position: 1,
          clips: [
            makeClip({ id: 'av', trackId: 'V2', sourceType: 'avatar', sourceId: 'lay', linkGroupId: 'avatar:lay' }),
          ],
        }),
      ],
      [{ id: 'sx', duration: 10, aiLayers: [{ id: 'lay', type: 'avatar', label: 'Host', startAt: 0 }] }],
    )
    const res = await handler('clip', { op: 'move', clipId: 'av', toTrackId: 'V2', startTime: 3 }, world)
    expect(res.success).toBe(true)
    expect((world.scenes[0] as any).aiLayers[0].startAt).toBe(3)
    expect(world.timeline!.tracks.find((t) => t.id === 'V2')!.clips.find((c) => c.id === 'av')!.startTime).toBe(3)
  })

  it('place_clip spills an overlapping audio clip to a free lane (no double-play)', async () => {
    const world = makeWorld([
      makeTrack({
        id: 'A1',
        type: 'audio',
        clips: [
          makeClip({ id: 'a-existing', trackId: 'A1', sourceType: 'audio', sourceId: 'm1', startTime: 0, duration: 5 }),
        ],
      }),
      makeTrack({ id: 'A2', type: 'audio', position: 1, clips: [] }),
    ])
    const res = await handler(
      'place_clip',
      { trackId: 'A1', sourceType: 'audio', sourceId: 'm2', startTime: 1, duration: 3 },
      world,
    )
    expect(res.success).toBe(true)
    // It must NOT land on A1 (would overlap a-existing) — spilled to A2.
    expect((res.data as { trackId: string }).trackId).toBe('A2')
    expect(world.timeline!.tracks.find((t) => t.id === 'A1')!.clips).toHaveLength(1)
    expect(world.timeline!.tracks.find((t) => t.id === 'A2')!.clips).toHaveLength(1)
  })
})

describe('init_timeline emits replayable actions', () => {
  it('emits track/add + one clip/add per scene', async () => {
    const world = makeWorld(
      [],
      [
        { id: 's1', name: 'A', duration: 4 },
        { id: 's2', name: 'B', duration: 6 },
      ],
    )
    const res = await handler('init_timeline', {}, world)
    expect(res.success).toBe(true)
    const trackAdds = emitted.filter((e) => e.type === 'track/add')
    const clipAdds = emitted.filter((e) => e.type === 'clip/add')
    expect(trackAdds).toHaveLength(1)
    expect(clipAdds).toHaveLength(2) // one per scene
    // The clip/add actions must reference the created track.
    expect(clipAdds.every((c) => c.params.trackId === trackAdds[0].params.trackId)).toBe(true)
    // Strictly-increasing timestamps so replay applies track/add before its
    // clips (same-ms ordering would drop clips with TRACK_NOT_FOUND).
    const trackTs = (trackAdds[0] as any).timestamp
    const clipTs = clipAdds.map((c) => (c as any).timestamp)
    expect(typeof trackTs).toBe('number')
    expect(clipTs.every((t) => t > trackTs)).toBe(true)
    expect(clipTs[1]).toBeGreaterThan(clipTs[0])
  })
})

// ── apply_color render-tier honesty (review P0) ─────────────────────────────
// The CSS tier applies in the single composite seam. The WebGL tier (LUT / hue
// curves) runs the SAME GPU shader pass in BOTH the preview pool and the export
// host (src/lib/compositor/grade-gl.ts) — so the result reports tier:webgl and an
// honest "preview == export via a GPU pass" note, NOT a silent no-op as "applied".
describe('apply_color render-tier honesty', () => {
  const videoClip = () => makeClip({ id: 'c1', trackId: 'V1', sourceType: 'video', sourceId: 'v1' })

  it('a CSS-tier grade (exposure) succeeds with tier css and NO webgl note', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [videoClip()] })])
    const res = await handler('apply_color', { clipIds: ['c1'], exposure: 0.5 }, world)
    expect(res.success).toBe(true)
    expect((res.data as { tier: string }).tier).toBe('css')
    expect(res.changes?.[0].description).not.toMatch(/GPU/i)
    expect(world.timeline!.tracks[0].clips[0].grade?.exposure).toBe(0.5)
  })

  it('a hue-curve grade reports tier webgl + the GPU preview==export note', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [videoClip()] })])
    const res = await handler(
      'apply_color',
      { clipIds: ['c1'], hueCurves: { targets: [{ targetHue: 30, hueShift: 12 }] } },
      world,
    )
    expect(res.success).toBe(true)
    expect((res.data as { tier: string }).tier).toBe('webgl')
    expect(res.changes?.[0].description).toMatch(/render tier: webgl/i)
    expect(res.changes?.[0].description).toMatch(/GPU/i)
    expect(res.changes?.[0].description).toMatch(/preview and the MP4 export/i)
  })

  it('a CSS nudge onto a clip that ALREADY carries hue curves still reports webgl', async () => {
    const graded = videoClip()
    ;(graded as any).grade = { hueCurves: { targets: [{ targetHue: 200, satScale: 1.4 }] } }
    const world = makeWorld([makeTrack({ id: 'V1', clips: [graded] })])
    const res = await handler('apply_color', { clipIds: ['c1'], exposure: 0.2 }, world)
    expect(res.success).toBe(true)
    // Resulting grade is still webgl even though THIS patch is css-expressible.
    expect((res.data as { tier: string }).tier).toBe('webgl')
    expect(res.changes?.[0].description).toMatch(/GPU/i)
  })

  it('grades a SCENE clip (media-asset scene) with a CSS grade — renders, no caveat', async () => {
    // Default makeClip is a scene clip.
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler('apply_color', { clipIds: ['c1'], exposure: 0.5, temperature: 8000 }, world)
    expect(res.success).toBe(true)
    expect((res.data as { tier: string }).tier).toBe('css')
    expect(res.changes?.[0].description).not.toMatch(/not shown|GPU/i)
    expect(world.timeline!.tracks[0].clips[0].grade?.exposure).toBe(0.5)
  })

  it('a LUT grade on a SCENE clip says the LUT is NOT shown on a scene (honest)', async () => {
    const world = makeWorld([makeTrack({ id: 'V1', clips: [makeClip({ id: 'c1', trackId: 'V1' })] })])
    const res = await handler(
      'apply_color',
      { clipIds: ['c1'], lut: { path: '', strength: 1 }, hueCurves: { targets: [{ targetHue: 30, hueShift: 12 }] } },
      world,
    )
    expect(res.success).toBe(true)
    expect((res.data as { tier: string }).tier).toBe('webgl')
    expect(res.changes?.[0].description).toMatch(/not shown on a scene/i)
    // It must NOT claim the LUT renders in the export for a scene.
    expect(res.changes?.[0].description).not.toMatch(/renders through a GPU/i)
  })
})
