import { describe, it, expect } from 'vitest'
import {
  timelineToFCPXML,
  secondsToRationalTime,
  rationalTimebase,
  frameDurationString,
  defaultResolveAsset,
  type ResolvedAsset,
} from './fcpxml'
import type { Timeline, Clip } from '@/lib/types'

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeClip(over: Partial<Clip> = {}): Clip {
  return {
    id: over.id ?? 'c1',
    trackId: over.trackId ?? 'V1',
    sourceType: over.sourceType ?? 'video',
    sourceId: over.sourceId ?? '/media/clip.mp4',
    label: over.label ?? 'Clip',
    startTime: over.startTime ?? 0,
    duration: over.duration ?? 2,
    trimStart: over.trimStart ?? 0,
    trimEnd: over.trimEnd ?? null,
    speed: over.speed ?? 1,
    opacity: over.opacity ?? 1,
    position: over.position ?? { x: 0, y: 0 },
    scale: over.scale ?? { x: 1, y: 1 },
    rotation: over.rotation ?? 0,
    filters: over.filters ?? [],
    keyframes: over.keyframes ?? [],
    ...over,
  }
}

function makeTimeline(tracks: Timeline['tracks']): Timeline {
  return { tracks }
}

/** Parse with jsdom's DOMParser and fail on any <parsererror>. */
function assertWellFormed(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const err = doc.querySelector('parsererror')
  expect(err, err?.textContent ?? undefined).toBeNull()
  return doc
}

// ── Rational-time conversion ────────────────────────────────────────────────

describe('secondsToRationalTime — frame-accurate rational time', () => {
  it('emits 0s for zero', () => {
    const tb = rationalTimebase(30)
    expect(secondsToRationalTime(0, tb)).toEqual({ frames: 0, timeString: '0s' })
  })

  it('snaps to whole frames and reduces by GCD (1s @ 30fps → "1s")', () => {
    const tb = rationalTimebase(30)
    expect(secondsToRationalTime(1, tb)).toEqual({ frames: 30, timeString: '1s' })
  })

  it('keeps a sub-second time rational (2 frames @ 30fps → "1/15s")', () => {
    const tb = rationalTimebase(30)
    // 2 frames = 2/30s = 1/15s after GCD reduction.
    const r = secondsToRationalTime(2 / 30, tb)
    expect(r.frames).toBe(2)
    expect(r.timeString).toBe('1/15s')
  })

  it('snaps an off-grid time to the nearest frame', () => {
    const tb = rationalTimebase(30)
    // 0.5034s * 30 = 15.1 → 15 frames = 1/2s.
    const r = secondsToRationalTime(0.5034, tb)
    expect(r.frames).toBe(15)
    expect(r.timeString).toBe('1/2s')
  })

  it('uses an NTSC timebase for 29.97 (frameDuration 1001/30000s)', () => {
    const tb = rationalTimebase(29.97)
    expect(frameDurationString(tb)).toBe('1001/30000s')
    // 1 frame → 1001/30000s.
    expect(secondsToRationalTime(1001 / 30000, tb).timeString).toBe('1001/30000s')
  })

  it('integer 30fps frameDuration is 1/30s', () => {
    expect(frameDurationString(rationalTimebase(30))).toBe('1/30s')
  })
})

// ── Resolver ────────────────────────────────────────────────────────────────

describe('defaultResolveAsset', () => {
  it('returns null for code-rendered scenes (no media file)', () => {
    expect(defaultResolveAsset(makeClip({ sourceType: 'scene' }))).toBeNull()
  })

  it('resolves a video clip to a file:// src with audio+video', () => {
    const a = defaultResolveAsset(makeClip({ sourceType: 'video', sourceId: '/media/a.mp4' }))
    expect(a?.src).toBe('file:///media/a.mp4')
    expect(a?.hasVideo).toBe(true)
    expect(a?.hasAudio).toBe(true)
  })

  it('marks an image as a still', () => {
    const a = defaultResolveAsset(makeClip({ sourceType: 'image', sourceId: '/media/p.png' }))
    expect(a?.isImage).toBe(true)
    expect(a?.hasAudio).toBe(false)
  })

  it('passes through an already-URL sourceId', () => {
    const a = defaultResolveAsset(makeClip({ sourceType: 'audio', sourceId: 'https://x/y.mp3' }))
    expect(a?.src).toBe('https://x/y.mp3')
  })
})

// ── Document structure ──────────────────────────────────────────────────────

describe('timelineToFCPXML — document structure', () => {
  it('emits a well-formed FCPXML 1.9 document with resources + sequence + spine', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'c1', sourceId: '/media/a.mp4', startTime: 0, duration: 2 })],
      },
    ])
    const { xml, clipCount, skipped } = timelineToFCPXML(tl, { fps: 30, width: 1920, height: 1080 })
    expect(clipCount).toBe(1)
    expect(skipped).toEqual([])

    const doc = assertWellFormed(xml)
    expect(doc.documentElement.nodeName).toBe('fcpxml')
    expect(doc.documentElement.getAttribute('version')).toBe('1.9')

    const format = doc.querySelector('resources format')
    expect(format?.getAttribute('frameDuration')).toBe('1/30s')
    expect(format?.getAttribute('width')).toBe('1920')
    expect(format?.getAttribute('height')).toBe('1080')

    const asset = doc.querySelector('resources asset')
    expect(asset?.getAttribute('hasVideo')).toBe('1')
    expect(asset?.querySelector('media-rep')?.getAttribute('src')).toBe('file:///media/a.mp4')

    const spine = doc.querySelector('sequence spine')
    expect(spine).not.toBeNull()
  })

  it('writes frame-accurate offset/duration/start on a trimmed clip', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [
          makeClip({ id: 'c1', sourceId: '/media/a.mp4', startTime: 1, duration: 2, trimStart: 0.5 }),
        ],
      },
    ])
    const { xml } = timelineToFCPXML(tl, { fps: 30 })
    const doc = assertWellFormed(xml)
    const clip = doc.querySelector('spine asset-clip')!
    expect(clip.getAttribute('offset')).toBe('1s') // 30 frames
    expect(clip.getAttribute('duration')).toBe('2s') // 60 frames
    expect(clip.getAttribute('start')).toBe('1/2s') // 15 frames (0.5s)
    expect(clip.getAttribute('ref')).toBe('r2') // r1 is the format
  })

  it('skips code-rendered scenes and reports them (never silently dropped)', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [
          makeClip({ id: 'scene1', sourceType: 'scene', sourceId: 'scene-uuid', startTime: 0, duration: 6 }),
          makeClip({ id: 'vid1', sourceType: 'video', sourceId: '/media/a.mp4', startTime: 6, duration: 2 }),
        ],
      },
    ])
    const { xml, clipCount, skipped } = timelineToFCPXML(tl)
    expect(clipCount).toBe(1)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ clipId: 'scene1', sourceType: 'scene' })
    expect(skipped[0].reason).toMatch(/render to mp4/i)
    // The spine has exactly the one media clip.
    const doc = assertWellFormed(xml)
    expect(doc.querySelectorAll('spine asset-clip')).toHaveLength(1)
  })

  it('maps multi-track to lanes: spine (no lane), +video lanes, −audio lanes', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'v1', sourceId: '/media/a.mp4', startTime: 0, duration: 4 })],
      },
      {
        id: 'V2',
        name: 'V2',
        type: 'video',
        muted: false,
        locked: false,
        position: 1,
        clips: [makeClip({ id: 'v2', sourceId: '/media/b.mp4', startTime: 1, duration: 2 })],
      },
      {
        id: 'A1',
        name: 'A1',
        type: 'audio',
        muted: false,
        locked: false,
        position: 2,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', startTime: 0, duration: 4 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    const spineV1 = doc.querySelector('spine > asset-clip[name="Clip"]')
    // V1 spine clip carries no lane.
    const clips = Array.from(doc.querySelectorAll('spine > asset-clip'))
    const v1 = clips.find((c) => c.getAttribute('ref') === 'r2')!
    const v2 = clips.find((c) => c.getAttribute('ref') === 'r3')!
    const a1 = clips.find((c) => c.getAttribute('ref') === 'r4')!
    expect(spineV1).not.toBeNull()
    expect(v1.getAttribute('lane')).toBeNull()
    expect(v2.getAttribute('lane')).toBe('1')
    expect(a1.getAttribute('lane')).toBe('-1')
  })

  it('emits transform/opacity/volume adjustments when non-default', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [
          makeClip({
            id: 'c1',
            sourceId: '/media/a.mp4',
            position: { x: 100, y: -50 },
            scale: { x: 1.5, y: 1.5 },
            rotation: 15,
            opacity: 0.5,
            audioGain: 2, // +6 dB
          }),
        ],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    const t = doc.querySelector('asset-clip adjust-transform')!
    expect(t.getAttribute('position')).toBe('100 -50')
    expect(t.getAttribute('scale')).toBe('1.5 1.5')
    expect(t.getAttribute('rotation')).toBe('15')
    expect(doc.querySelector('asset-clip adjust-blend')?.getAttribute('amount')).toBe('0.5')
    const vol = doc.querySelector('asset-clip adjust-volume')!.getAttribute('amount')!
    // 20*log10(2) ≈ 6.0206 dB
    expect(vol).toMatch(/^6\.0[0-9]*dB$/)
  })

  it('omits adjustments for an identity clip', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'c1', sourceId: '/media/a.mp4' })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    expect(doc.querySelector('adjust-transform')).toBeNull()
    expect(doc.querySelector('adjust-blend')).toBeNull()
    expect(doc.querySelector('adjust-volume')).toBeNull()
  })

  it('renders a still image as a <video> element, not <asset-clip>', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'c1', sourceType: 'image', sourceId: '/media/p.png', duration: 3 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    expect(doc.querySelector('spine asset-clip')).toBeNull()
    const v = doc.querySelector('spine video')!
    expect(v.getAttribute('offset')).toBe('0s')
    // Stills carry no source in-point.
    expect(v.getAttribute('start')).toBeNull()
  })

  it('reuses one asset resource for two clips of the same source', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [
          makeClip({ id: 'c1', sourceId: '/media/a.mp4', startTime: 0, duration: 2 }),
          makeClip({ id: 'c2', sourceId: '/media/a.mp4', startTime: 2, duration: 2 }),
        ],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    expect(doc.querySelectorAll('resources asset')).toHaveLength(1)
    expect(doc.querySelectorAll('spine asset-clip')).toHaveLength(2)
  })

  it('escapes XML special characters in names', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'c1', label: 'A & B <clip>', sourceId: '/media/a.mp4' })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    expect(xml).toContain('A &amp; B &lt;clip&gt;')
    assertWellFormed(xml) // round-trips through the parser cleanly
  })

  it('emits a leading <gap> when the first spine clip starts past 0 (timing preserved)', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'c1', sourceId: '/media/a.mp4', startTime: 1, duration: 2 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl, { fps: 30 })
    const doc = assertWellFormed(xml)
    const spine = doc.querySelector('sequence spine')!
    // First child is the filler gap; the clip keeps its 1s offset (not slid left).
    const first = spine.children[0]
    expect(first.nodeName).toBe('gap')
    expect(first.getAttribute('offset')).toBe('0s')
    expect(first.getAttribute('duration')).toBe('1s')
    const clip = doc.querySelector('spine asset-clip')!
    expect(clip.getAttribute('offset')).toBe('1s')
  })

  it('inserts a <gap> between two non-contiguous spine clips (no slide-up)', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [
          makeClip({ id: 'c1', sourceId: '/media/a.mp4', startTime: 0, duration: 2 }),
          // 2s hole between c1 (ends at 2s) and c2 (starts at 4s).
          makeClip({ id: 'c2', sourceId: '/media/b.mp4', startTime: 4, duration: 2 }),
        ],
      },
    ])
    const { xml } = timelineToFCPXML(tl, { fps: 30 })
    const doc = assertWellFormed(xml)
    const spine = doc.querySelector('sequence spine')!
    const kinds = Array.from(spine.children).map((c) => c.nodeName)
    expect(kinds).toEqual(['asset-clip', 'gap', 'asset-clip'])
    const gap = spine.children[1]
    expect(gap.getAttribute('offset')).toBe('2s')
    expect(gap.getAttribute('duration')).toBe('2s')
    // Second clip keeps its absolute 4s offset rather than sliding to 2s.
    expect(spine.children[2].getAttribute('offset')).toBe('4s')
  })

  it('puts the first populated video track on the spine even below an all-skipped scene track', () => {
    const tl = makeTimeline([
      {
        id: 'S1',
        name: 'Scenes',
        type: 'scene',
        muted: false,
        locked: false,
        position: 0,
        // All clips are code-scenes → resolve to null → track produces nothing.
        clips: [makeClip({ id: 's1', sourceType: 'scene', sourceId: 'scene-uuid', duration: 6 })],
      },
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 1,
        clips: [makeClip({ id: 'v1', sourceId: '/media/a.mp4', startTime: 0, duration: 4 })],
      },
    ])
    const { xml, clipCount } = timelineToFCPXML(tl)
    expect(clipCount).toBe(1)
    const doc = assertWellFormed(xml)
    const clip = doc.querySelector('spine asset-clip')!
    // The video occupies the spine (no lane), not lane="1".
    expect(clip.getAttribute('lane')).toBeNull()
    expect(clip.getAttribute('ref')).toBe('r2')
  })

  it('anchors an audio-only timeline to a spanning spine <gap>', () => {
    const tl = makeTimeline([
      {
        id: 'A1',
        name: 'A1',
        type: 'audio',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', startTime: 0, duration: 4 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    const spine = doc.querySelector('sequence spine')!
    expect(spine.children[0].nodeName).toBe('gap')
    expect(spine.children[0].getAttribute('duration')).toBe('4s')
    const a1 = doc.querySelector('spine asset-clip')!
    expect(a1.getAttribute('lane')).toBe('-1')
  })

  it('folds the track mixer volume into the clip adjust-volume', () => {
    const tl = makeTimeline([
      {
        id: 'A1',
        name: 'A1',
        type: 'audio',
        muted: false,
        locked: false,
        position: 0,
        volume: 2, // +6 dB track fader
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', audioGain: 2 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    // 2 (clip) * 2 (track) = 4 → 20*log10(4) ≈ 12.04 dB.
    const vol = doc.querySelector('asset-clip adjust-volume')!.getAttribute('amount')!
    expect(vol).toMatch(/^12\.0[0-9]*dB$/)
  })

  it('mutes the audio side via adjust-volume when clip.audioMuted is set', () => {
    const tl = makeTimeline([
      {
        id: 'A1',
        name: 'A1',
        type: 'audio',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', audioMuted: true })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    expect(doc.querySelector('asset-clip adjust-volume')?.getAttribute('amount')).toBe('-96dB')
    // audioMuted is audio-only — the clip stays enabled (picture survives).
    expect(doc.querySelector('asset-clip')?.getAttribute('enabled')).toBeNull()
  })

  it('disables clips on a hidden VIDEO track via enabled="0"', () => {
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 'v1', sourceId: '/media/a.mp4', startTime: 0, duration: 4 })],
      },
      {
        id: 'V2',
        name: 'V2',
        type: 'video',
        muted: false,
        locked: false,
        position: 1,
        hidden: true,
        clips: [makeClip({ id: 'v2', sourceId: '/media/b.mp4', startTime: 0, duration: 4 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    const clips = Array.from(doc.querySelectorAll('spine asset-clip'))
    const v1 = clips.find((c) => c.getAttribute('ref') === 'r2')!
    const v2 = clips.find((c) => c.getAttribute('ref') === 'r3')!
    // V1 visible → enabled; V2 picture hidden → disabled.
    expect(v1.getAttribute('enabled')).toBeNull()
    expect(v2.getAttribute('enabled')).toBe('0')
  })

  it('kitchen-sink: gapped spine + lanes + skipped scene, every ref resolves to a resource', () => {
    // Mirrors scripts/dev/fcpxml-sample.ts — the document we round-trip into a real NLE.
    const tl = makeTimeline([
      {
        id: 'S1', name: 'Scenes', type: 'scene', muted: false, locked: false, position: 0,
        clips: [makeClip({ id: 's1', sourceType: 'scene', sourceId: 'scene-uuid', duration: 6 })],
      },
      {
        id: 'V1', name: 'V1', type: 'video', muted: false, locked: false, position: 1,
        clips: [
          makeClip({ id: 'v1a', label: 'Intro', sourceId: '/media/a.mp4', startTime: 1, duration: 2, trimStart: 0.5 }),
          makeClip({ id: 'v1b', label: 'Body', sourceId: '/media/b.mp4', startTime: 5, duration: 3 }),
        ],
      },
      {
        id: 'V2', name: 'V2', type: 'video', muted: false, locked: false, position: 2,
        clips: [makeClip({ id: 'v2', sourceType: 'image', sourceId: '/media/logo.png', startTime: 2, duration: 3, opacity: 0.8 })],
      },
      {
        id: 'A1', name: 'Music', type: 'audio', muted: false, locked: false, position: 3, volume: 0.5,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/music.mp3', startTime: 0, duration: 8 })],
      },
      {
        id: 'A2', name: 'VO', type: 'audio', muted: false, locked: false, position: 4,
        clips: [makeClip({ id: 'a2', sourceType: 'audio', sourceId: '/media/vo.mp3', startTime: 1, duration: 4 })],
      },
    ])
    const { xml, clipCount, skipped } = timelineToFCPXML(tl, { fps: 30, name: 'Dreambyte Sample' })
    expect(clipCount).toBe(5)
    expect(skipped.map((s) => s.clipId)).toEqual(['s1'])

    const doc = assertWellFormed(xml)
    // Spine primary storyline: leading gap, intro, hole gap, body (in time order).
    const spine = doc.querySelector('sequence spine')!
    const primary = Array.from(spine.children).filter((c) => c.getAttribute('lane') === null)
    expect(primary.map((c) => c.nodeName)).toEqual(['gap', 'asset-clip', 'gap', 'asset-clip'])
    // V2 overlay is a connected +lane; audio on negative lanes.
    expect(doc.querySelector('spine video[lane="1"]')).not.toBeNull()
    expect(doc.querySelector('spine asset-clip[lane="-1"]')).not.toBeNull()
    expect(doc.querySelector('spine asset-clip[lane="-2"]')).not.toBeNull()

    // Importability proxy: EVERY ref on a clip points at a declared <asset>/<format>.
    const declaredIds = new Set(
      Array.from(doc.querySelectorAll('resources > *')).map((n) => n.getAttribute('id')),
    )
    const refs = Array.from(doc.querySelectorAll('spine [ref]')).map((n) => n.getAttribute('ref'))
    expect(refs.length).toBe(5)
    for (const ref of refs) expect(declaredIds.has(ref)).toBe(true)
  })

  it('soloing an audio track silences other audio via -96dB but does NOT disable video', () => {
    const tl = makeTimeline([
      {
        id: 'V1', name: 'V1', type: 'video', muted: false, locked: false, position: 0,
        clips: [makeClip({ id: 'v1', sourceId: '/media/a.mp4', startTime: 0, duration: 4 })],
      },
      {
        id: 'A1', name: 'A1', type: 'audio', muted: false, locked: false, position: 1, solo: true,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', startTime: 0, duration: 4 })],
      },
      {
        id: 'A2', name: 'A2', type: 'audio', muted: false, locked: false, position: 2,
        clips: [makeClip({ id: 'a2', sourceType: 'audio', sourceId: '/media/v.mp3', startTime: 0, duration: 4 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    const v1 = Array.from(doc.querySelectorAll('spine asset-clip')).find((c) => c.getAttribute('ref') === 'r2')!
    const a2 = Array.from(doc.querySelectorAll('spine asset-clip')).find((c) => c.getAttribute('ref') === 'r4')!
    // Video picture is NOT blanked by an audio solo — only its audio is ducked.
    expect(v1.getAttribute('enabled')).toBeNull()
    expect(v1.querySelector('adjust-volume')?.getAttribute('amount')).toBe('-96dB')
    // The non-soloed audio track is silenced via volume, not disabled.
    expect(a2.getAttribute('enabled')).toBeNull()
    expect(a2.querySelector('adjust-volume')?.getAttribute('amount')).toBe('-96dB')
    // The soloed track itself plays at unity (no adjust-volume).
    const a1 = Array.from(doc.querySelectorAll('spine asset-clip')).find((c) => c.getAttribute('ref') === 'r3')!
    expect(a1.querySelector('adjust-volume')).toBeNull()
  })

  it('does not disable an audio track just because it is hidden (hidden is picture-only)', () => {
    const tl = makeTimeline([
      {
        id: 'A1', name: 'A1', type: 'audio', muted: false, locked: false, position: 0, hidden: true,
        clips: [makeClip({ id: 'a1', sourceType: 'audio', sourceId: '/media/m.mp3', startTime: 0, duration: 4 })],
      },
    ])
    const { xml } = timelineToFCPXML(tl)
    const doc = assertWellFormed(xml)
    expect(doc.querySelector('spine asset-clip')?.getAttribute('enabled')).toBeNull()
  })

  it('honors a custom resolver for pre-rendered scenes (Phase 2 hook)', () => {
    const rendered: ResolvedAsset = {
      name: 'Scene 1',
      src: 'file:///renders/scene1.mp4',
      durationSeconds: 6,
      hasVideo: true,
      hasAudio: true,
    }
    const tl = makeTimeline([
      {
        id: 'V1',
        name: 'V1',
        type: 'video',
        muted: false,
        locked: false,
        position: 0,
        clips: [makeClip({ id: 's1', sourceType: 'scene', sourceId: 'scene-uuid', duration: 6 })],
      },
    ])
    const { clipCount, skipped, xml } = timelineToFCPXML(tl, {
      resolveAsset: (c) => (c.sourceType === 'scene' ? rendered : defaultResolveAsset(c)),
    })
    expect(clipCount).toBe(1)
    expect(skipped).toEqual([])
    const doc = assertWellFormed(xml)
    expect(doc.querySelector('media-rep')?.getAttribute('src')).toBe('file:///renders/scene1.mp4')
  })
})
