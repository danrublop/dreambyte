/**
 * Generate a representative FCPXML 1.9 sample for round-trip validation in a real
 * NLE (Final Cut Pro / DaVinci Resolve). Exercises the structurally interesting
 * cases the unit tests assert in isolation, all in one document:
 *
 *   - a GAPPED spine (leading gap + a hole between two clips),
 *   - a higher video track as a connected +lane with a transform + opacity,
 *   - a still image (<video> element, no source in-point),
 *   - an all-skipped scene track that must NOT occupy the spine or burn a lane,
 *   - two audio tracks on negative lanes, one with a track-volume fader,
 *   - a trimmed clip (source in-point) and frame-accurate rational time.
 *
 * Usage: npx tsx scripts/dev/fcpxml-sample.ts [outPath]
 * Default outPath: src/lib/export/__fixtures__/sample-timeline.fcpxml
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { timelineToFCPXML } from '../../src/lib/export/fcpxml'
import type { Timeline, Clip } from '../../src/lib/types'

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c',
    trackId: 't',
    sourceType: 'video',
    sourceId: '/media/a.mp4',
    label: 'Clip',
    startTime: 0,
    duration: 2,
    trimStart: 0,
    trimEnd: null,
    speed: 1,
    opacity: 1,
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    filters: [],
    keyframes: [],
    ...over,
  }
}

const timeline: Timeline = {
  tracks: [
    {
      // All-skipped scene track ABOVE the real video — must not take the spine.
      id: 'S1',
      name: 'Scenes',
      type: 'scene',
      muted: false,
      locked: false,
      position: 0,
      clips: [clip({ id: 's1', sourceType: 'scene', sourceId: 'scene-uuid', startTime: 0, duration: 6 })],
    },
    {
      // Spine: starts at 1s (leading gap) then a 2s hole before the second clip.
      id: 'V1',
      name: 'V1',
      type: 'video',
      muted: false,
      locked: false,
      position: 1,
      clips: [
        clip({ id: 'v1a', label: 'Intro', sourceId: '/media/a.mp4', startTime: 1, duration: 2, trimStart: 0.5 }),
        clip({ id: 'v1b', label: 'Body', sourceId: '/media/b.mp4', startTime: 5, duration: 3 }),
      ],
    },
    {
      // Connected +lane overlay with a transform + opacity.
      id: 'V2',
      name: 'V2',
      type: 'video',
      muted: false,
      locked: false,
      position: 2,
      clips: [
        clip({
          id: 'v2',
          label: 'Overlay',
          sourceType: 'image',
          sourceId: '/media/logo.png',
          startTime: 2,
          duration: 3,
          position: { x: 200, y: -100 },
          scale: { x: 0.5, y: 0.5 },
          rotation: 10,
          opacity: 0.8,
        }),
      ],
    },
    {
      id: 'A1',
      name: 'Music',
      type: 'audio',
      muted: false,
      locked: false,
      position: 3,
      volume: 0.5, // -6 dB track fader
      clips: [clip({ id: 'a1', label: 'Music', sourceType: 'audio', sourceId: '/media/music.mp3', startTime: 0, duration: 8 })],
    },
    {
      id: 'A2',
      name: 'VO',
      type: 'audio',
      muted: false,
      locked: false,
      position: 4,
      clips: [clip({ id: 'a2', label: 'VO', sourceType: 'audio', sourceId: '/media/vo.mp3', startTime: 1, duration: 4, audioGain: 1.5 })],
    },
  ],
}

const out = process.argv[2] ?? path.join('src', 'lib', 'export', '__fixtures__', 'sample-timeline.fcpxml')
const result = timelineToFCPXML(timeline, { fps: 30, width: 1920, height: 1080, name: 'Dreambyte Sample' })
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, result.xml, 'utf-8')
// eslint-disable-next-line no-console
console.log(`Wrote ${out}\n  clips: ${result.clipCount}\n  skipped: ${result.skipped.length} (${result.skipped.map((s) => s.clipId).join(', ') || 'none'})`)
