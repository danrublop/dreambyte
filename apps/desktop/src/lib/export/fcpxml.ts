/**
 * FCPXML 1.9 interchange export — turn a Dreambyte timeline into an .fcpxml
 * document that Final Cut Pro / DaVinci Resolve (and Premiere via a Resolve
 * bridge) can import for finishing. We target FCPXML 1.9 (rather than the
 * older FCP7 XMEML) because its rational, frame-accurate time and first-class `lane`s map
 * cleanly onto our seconds-based, multi-track clip model.
 *
 * Lives in src/lib/export (electron-free) so it is fully unit-testable and the SAME
 * serializer can run from the agent tool path and a future desktop Export menu.
 *
 * What transports:
 * - Media clips only: video / image / audio (and pre-rendered scenes/avatars
 *   when a resolver maps them to a file). Real `<asset>` resources are emitted.
 * - Clip placement & trim → `offset` / `start` / `duration` (frame-accurate rational time).
 * - Multi-track → lanes: lowest *populated* video track = spine; higher video tracks
 *   = +lanes; audio tracks = negative lanes. Empty / all-skipped tracks neither
 *   occupy the spine nor burn a lane number.
 * - Non-contiguous spine timing → explicit `<gap>` filler. The spine is a sequential
 *   storyline, so a hole between clips must be an explicit gap or importers slide the
 *   later clip left (silently corrupting timing). Connected lanes are absolute-offset
 *   positioned and need no filler.
 * - Transform (position / scale / rotation) → `<adjust-transform>` (approx; see header note).
 * - Opacity → `<adjust-blend amount>`.
 * - Volume → `<adjust-volume amount="<dB>dB">`. The clip's linear `audioGain` is
 *   multiplied by the track mixer `volume`; `clip.audioMuted` forces silence.
 * - Disabled clip, muted/hidden track, or a non-soloed track while another is soloed
 *   → `enabled="0"`.
 *
 * What does NOT transport (lossy):
 * - Code-rendered scenes with no media file (skipped, reported via `skipped[]`).
 * - Speed / retime, keyframe animation, filters / grade / blend modes / crop / fades, pan.
 * - Transform coordinate space is an approximation: our position is a top-left
 *   pixel offset; FCP centres its origin. We pass pixels 1:1 and document it.
 */

import type { Timeline, Clip, Track } from '@/lib/types'

// ── Public API ──────────────────────────────────────────────────────────────

export interface FCPXMLOptions {
  /** Frames per second of the emitted sequence (drives the rational timebase). Default 30. */
  fps?: number
  /** Sequence width in pixels. Default 1920. */
  width?: number
  /** Sequence height in pixels. Default 1080. */
  height?: number
  /** Sequence / project display name. Default 'Dreambyte Timeline'. */
  name?: string
  /**
   * Maps a clip to its backing media file.
   * Return `null` to mark the clip as not exportable (e.g. a code-scene with no
   * rendered file) — it is skipped and reported in `skipped[]`. The default
   * resolver derives a file reference from `clip.sourceId` for real media
   * sources (video/image/audio/avatar) and returns `null` for code scenes.
   */
  resolveAsset?: (clip: Clip) => ResolvedAsset | null
}

export interface ResolvedAsset {
  /** Display name (FCP asset name). */
  name: string
  /** A `src` URL for the media file — typically a `file://` path. */
  src: string
  /** Source media duration in seconds (full asset length, not the trimmed clip). */
  durationSeconds: number
  /** Whether the asset has a video/image picture track. */
  hasVideo: boolean
  /** Whether the asset has an audio track. */
  hasAudio: boolean
  /** Source pixel width (defaults to the sequence width if unknown). */
  width?: number
  /** Source pixel height (defaults to the sequence height if unknown). */
  height?: number
  /** True for a still image (exported as a `<video>` element, not `<asset-clip>`). */
  isImage?: boolean
}

export interface FCPXMLResult {
  /** The serialized FCPXML 1.9 document (UTF-8 XML text). */
  xml: string
  /** Number of media clips written into the spine + lanes. */
  clipCount: number
  /** Clips that could NOT be exported (mainly code-rendered scenes with no file). */
  skipped: Array<{ clipId: string; sourceType: string; reason: string }>
}

/**
 * Serialize a Dreambyte timeline to an FCPXML 1.9 document. Media clips are
 * exported; code-rendered scenes without a backing file are skipped and reported
 * in `result.skipped` (never silently dropped — see plan doc).
 */
export function timelineToFCPXML(timeline: Timeline, options: FCPXMLOptions = {}): FCPXMLResult {
  const fps = options.fps && options.fps > 0 ? options.fps : 30
  const width = options.width && options.width > 0 ? options.width : 1920
  const height = options.height && options.height > 0 ? options.height : 1080
  const name = options.name ?? 'Dreambyte Timeline'
  const resolve = options.resolveAsset ?? defaultResolveAsset

  const tb = rationalTimebase(fps)
  const frameDuration = frameDurationString(tb)

  const skipped: FCPXMLResult['skipped'] = []

  // Stable resource ids. The format resource is always r1.
  const formatId = 'r1'
  let nextResourceId = 2
  // One asset resource per unique media src, reused across clips.
  const assetIdBySrc = new Map<string, string>()
  const assetNodes: XMLNode[] = []

  function assetResourceFor(asset: ResolvedAsset): string {
    const existing = assetIdBySrc.get(asset.src)
    if (existing) return existing
    const id = `r${nextResourceId++}`
    assetIdBySrc.set(asset.src, id)
    const dur = secondsToRationalTime(asset.durationSeconds, tb).timeString
    const attrs: Array<[string, string]> = [
      ['id', id],
      ['name', asset.name],
      ['start', '0s'],
      ['duration', dur],
      ['hasVideo', asset.hasVideo ? '1' : '0'],
      ['hasAudio', asset.hasAudio ? '1' : '0'],
      ['format', formatId],
    ]
    if (asset.hasVideo) attrs.push(['videoSources', '1'])
    if (asset.hasAudio) attrs.push(['audioSources', '1'], ['audioChannels', '2'], ['audioRate', '48000'])
    assetNodes.push(
      el('asset', attrs, [
        el('media-rep', [
          ['kind', 'original-media'],
          ['src', asset.src],
        ]),
      ]),
    )
    return id
  }

  // Build clip elements per track. Lowest video track = spine; others = lanes.
  const sortedTracks = [...timeline.tracks].sort((a, b) => a.position - b.position)
  const videoTracks = sortedTracks.filter((t) => t.type !== 'audio')
  const audioTracks = sortedTracks.filter((t) => t.type === 'audio')

  // Solo is a TIMELINE-wide state: if ANY track is soloed, every non-soloed
  // track is silenced (mirrors the mixer in src/lib/types/timeline.ts:130).
  const anySolo = timeline.tracks.some((t) => t.solo === true)

  let clipCount = 0
  const spineChildren: XMLNode[] = []

  /**
   * The whole clip is disabled (`enabled="0"`) — both picture and audio — when the
   * clip is toggled off, its track is muted, or (for a PICTURE track only) the
   * track is hidden. `track.hidden` is a picture-visibility toggle, so it must NOT
   * disable an audio track's clips; solo is an audio-only concept handled via gain,
   * not here (soloing an audio track must not blank the video). See `soloMuted`.
   */
  function clipDisabled(clip: Clip, track: Track): boolean {
    return clip.enabled === false || track.muted === true || (track.hidden === true && track.type !== 'audio')
  }

  /** Audio is silenced (no picture effect) when this track is soloed out. */
  function soloMuted(track: Track): boolean {
    return anySolo && track.solo !== true
  }

  /** A spine filler covering [offsetFrames, offsetFrames+durFrames). */
  function gapNode(offsetFrames: number, durFrames: number): XMLNode {
    return el('gap', [
      ['name', 'Gap'],
      ['offset', framesToRationalString(offsetFrames, tb)],
      ['duration', framesToRationalString(durFrames, tb)],
    ])
  }

  /** Resolve a clip → asset, recording an honest skip when unresolvable. */
  function resolveOrSkip(clip: Clip): ResolvedAsset | null {
    const asset = resolve(clip)
    if (!asset) {
      skipped.push({
        clipId: clip.id,
        sourceType: clip.sourceType,
        reason:
          clip.sourceType === 'scene'
            ? 'code-rendered scene has no media file (render to MP4 first to include it)'
            : 'no media file could be resolved for this clip',
      })
      return null
    }
    return asset
  }

  function emitClip(clip: Clip, asset: ResolvedAsset, track: Track, lane: number | null): XMLNode {
    const resId = assetResourceFor(asset)
    clipCount++

    const offset = secondsToRationalTime(clip.startTime, tb).timeString
    const duration = secondsToRationalTime(clip.duration, tb).timeString
    const start = secondsToRationalTime(Math.max(0, clip.trimStart), tb).timeString

    const attrs: Array<[string, string]> = []
    if (lane != null) attrs.push(['lane', String(lane)])
    attrs.push(['ref', resId], ['name', asset.name], ['offset', offset], ['duration', duration])
    // Stills don't carry a source in-point.
    if (!asset.isImage) attrs.push(['start', start])
    if (clipDisabled(clip, track)) attrs.push(['enabled', '0'])

    const children = adjustments(clip, track, soloMuted(track))
    // A still image is a <video> element; everything with a real timeline source
    // (video / audio / pre-rendered scene) is an <asset-clip>.
    const tag = asset.isImage ? 'video' : 'asset-clip'
    return el(tag, attrs, children)
  }

  // Resolve clips per track UP FRONT so lane numbers are assigned only to tracks
  // that actually produce ≥1 clip. A track whose every clip resolves to null
  // (e.g. a code-scene track) must not occupy the spine or burn a lane number.
  type ResolvedTrack = { track: Track; clips: Array<{ clip: Clip; asset: ResolvedAsset }> }
  function resolveTrack(track: Track): ResolvedTrack {
    const out: Array<{ clip: Clip; asset: ResolvedAsset }> = []
    for (const clip of sortClips(track.clips)) {
      const asset = resolveOrSkip(clip)
      if (asset) out.push({ clip, asset })
    }
    return { track, clips: out }
  }

  // Map (recording skips) in position order, THEN drop the empties so the spine
  // is the lowest *populated* video track.
  const populatedVideo = videoTracks.map(resolveTrack).filter((t) => t.clips.length > 0)
  const populatedAudio = audioTracks.map(resolveTrack).filter((t) => t.clips.length > 0)

  // Lowest populated video track = spine (lane 0); the rest stack as +lanes.
  populatedVideo.forEach((rt, idx) => {
    if (idx === 0) {
      // The spine is a SEQUENTIAL storyline. Walk a running playhead and insert
      // an explicit <gap> before any clip that starts past it (and a leading gap
      // when the first clip starts > 0) so a non-contiguous track keeps its
      // timing instead of clips sliding left to close the holes.
      let playheadFrames = 0
      for (const { clip, asset } of rt.clips) {
        const startFrames = secondsToRationalTime(clip.startTime, tb).frames
        if (startFrames > playheadFrames) {
          spineChildren.push(gapNode(playheadFrames, startFrames - playheadFrames))
        }
        spineChildren.push(emitClip(clip, asset, rt.track, null))
        const durFrames = secondsToRationalTime(clip.duration, tb).frames
        playheadFrames = Math.max(playheadFrames, startFrames + durFrames)
      }
    } else {
      const lane = idx // 1, 2, … connected lanes above the spine
      for (const { clip, asset } of rt.clips) {
        spineChildren.push(emitClip(clip, asset, rt.track, lane))
      }
    }
  })

  // Audio tracks → negative lanes (-1, -2, …) by populated order.
  populatedAudio.forEach((rt, aIndex) => {
    const lane = -(aIndex + 1)
    for (const { clip, asset } of rt.clips) {
      spineChildren.push(emitClip(clip, asset, rt.track, lane))
    }
  })

  // FCPXML needs a primary storyline. If no video track populated the spine but
  // connected (audio) clips exist, anchor them to one spanning <gap> so importers
  // don't choke on a spine whose only children are connected (negative-lane) clips.
  // Span the EMITTED audio extent — not timelineDuration, which would count a
  // longer skipped code-scene track and over-extend the gap past the real audio.
  if (populatedVideo.length === 0 && spineChildren.length > 0) {
    let endFrames = 1
    for (const rt of populatedAudio) {
      for (const { clip } of rt.clips) {
        endFrames = Math.max(endFrames, secondsToRationalTime(clip.startTime + clip.duration, tb).frames)
      }
    }
    spineChildren.unshift(gapNode(0, endFrames))
  }

  const totalDuration = secondsToRationalTime(timelineDuration(timeline), tb).timeString

  const formatNode = el('format', [
    ['id', formatId],
    ['name', `FFVideoFormat${height}p${Math.round(fps)}`],
    ['frameDuration', frameDuration],
    ['width', String(width)],
    ['height', String(height)],
    ['colorSpace', '1-1-1 (Rec. 709)'],
  ])

  const root = el(
    'fcpxml',
    [['version', '1.9']],
    [
      el('resources', [], [formatNode, ...assetNodes]),
      el(
        'library',
        [],
        [
          el(
            'event',
            [['name', name]],
            [
              el(
                'project',
                [['name', name]],
                [
                  el(
                    'sequence',
                    [
                      ['format', formatId],
                      ['duration', totalDuration],
                      ['tcStart', '0s'],
                      // Drop-frame only for true NTSC drop rates (29.97 / 59.94); every
                      // other rate (incl. 23.976) is non-drop.
                      ['tcFormat', tb.numPerFrame === 1001 && Math.round(fps) % 30 === 0 ? 'DF' : 'NDF'],
                      ['audioLayout', 'stereo'],
                      ['audioRate', '48k'],
                    ],
                    [el('spine', [], spineChildren)],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + '<!DOCTYPE fcpxml>\n' + render(root, 0) + '\n'

  return { xml, clipCount, skipped }
}

// ── Time conversion (frame-accurate rational) ────────────────────────────────

/**
 * The rational timebase denominator for a given fps. NTSC rates (23.976, 29.97,
 * 59.94 ≈ N*1000/1001) use a /1000 base so a frame is `1001/(N*1000)s`; integer
 * rates use the fps itself so a frame is `1/Ns`.
 */
export function rationalTimebase(fps: number): { numPerFrame: number; scale: number } {
  const rounded = Math.round(fps)
  const ntscRate = (rounded * 1000) / 1001
  const isNtsc = Math.abs(fps - ntscRate) < Math.abs(fps - rounded)
  if (isNtsc) return { numPerFrame: 1001, scale: rounded * 1000 }
  return { numPerFrame: 1, scale: rounded }
}

/** The `frameDuration` time string for a timebase (e.g. `1/30s`, `1001/30000s`). */
export function frameDurationString(tb: { numPerFrame: number; scale: number }): string {
  return `${tb.numPerFrame}/${tb.scale}s`
}

/**
 * Convert `seconds` to a frame-snapped FCPXML rational time string. Every time
 * is rounded to a whole frame so importers never warn about off-grid clips and
 * round-trips stay stable. Returns the frame count too (useful for tests).
 */
export function secondsToRationalTime(
  seconds: number,
  tb: { numPerFrame: number; scale: number },
): { frames: number; timeString: string } {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  // frame index = round(seconds * fps), where fps = scale / numPerFrame.
  const fps = tb.scale / tb.numPerFrame
  const frames = Math.round(safe * fps)
  return { frames, timeString: framesToRationalString(frames, tb) }
}

/**
 * Canonical FCPXML rational-time string for a whole-frame count — the single
 * owner of the time-string format (reduce by GCD so `30/30s → 1s`). Both
 * `secondsToRationalTime` and the spine `<gap>` builder go through here so clip
 * and gap times can never format differently in the same document.
 */
function framesToRationalString(frames: number, tb: { numPerFrame: number; scale: number }): string {
  if (frames <= 0) return '0s'
  const num = frames * tb.numPerFrame
  const g = gcd(num, tb.scale)
  const rn = num / g
  const rd = tb.scale / g
  return rd === 1 ? `${rn}s` : `${rn}/${rd}s`
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a || 1
}

// ── Adjustments (transform / opacity / volume) ───────────────────────────────

function adjustments(clip: Clip, track: Track, soloMuted: boolean): XMLNode[] {
  const out: XMLNode[] = []

  const px = clip.position?.x ?? 0
  const py = clip.position?.y ?? 0
  const sx = clip.scale?.x ?? 1
  const sy = clip.scale?.y ?? 1
  const rot = clip.rotation ?? 0
  const hasTransform =
    Math.abs(px) > 0.001 ||
    Math.abs(py) > 0.001 ||
    Math.abs(sx - 1) > 0.001 ||
    Math.abs(sy - 1) > 0.001 ||
    Math.abs(rot) > 0.001
  if (hasTransform) {
    out.push(
      el('adjust-transform', [
        ['position', `${fmt(px)} ${fmt(py)}`],
        ['scale', `${fmt(sx)} ${fmt(sy)}`],
        ['rotation', fmt(rot)],
      ]),
    )
  }

  // Opacity → blend amount (FCPXML has no per-clip opacity attribute on a clip).
  const opacity = clip.opacity ?? 1
  if (opacity < 0.999) {
    out.push(el('adjust-blend', [['amount', fmt(clamp01(opacity))]]))
  }

  // Volume (linear gain) → dB. The clip's own gain is multiplied by the track
  // mixer fader (`track.volume`, linear, unity when undefined); `audioMuted` or
  // being soloed-out mutes only the audio side (full silence — no picture
  // effect). Skip near-unity; -inf clamps to a quiet floor.
  let gain = typeof clip.audioGain === 'number' ? clip.audioGain : 1
  if (typeof track.volume === 'number') gain *= track.volume
  if (clip.audioMuted === true || soloMuted) gain = 0
  if (Math.abs(gain - 1) > 0.001) {
    const db = gain <= 0 ? -96 : 20 * Math.log10(gain)
    out.push(el('adjust-volume', [['amount', `${fmt(db)}dB`]]))
  }

  return out
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function fmt(n: number): string {
  // Trim trailing zeros; FCPXML accepts plain decimals.
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString()
}

// ── Defaults / helpers ───────────────────────────────────────────────────────

/**
 * Default clip → media resolver. Real media sources (video/image/audio/avatar)
 * derive a file reference from `sourceId`; code scenes resolve to `null` (skipped).
 * Desktop wiring can pass a richer resolver that knows absolute file paths,
 * source dimensions, and durations.
 */
export function defaultResolveAsset(clip: Clip): ResolvedAsset | null {
  switch (clip.sourceType) {
    case 'scene':
      return null // code-rendered, no file
    case 'image':
      return {
        name: clip.label || clip.sourceId,
        src: toFileSrc(clip.sourceId),
        durationSeconds: Math.max(clip.duration, clip.trimStart + clip.duration),
        hasVideo: true,
        hasAudio: false,
        isImage: true,
      }
    case 'audio':
      return {
        name: clip.label || clip.sourceId,
        src: toFileSrc(clip.sourceId),
        durationSeconds: clipSourceDuration(clip),
        hasVideo: false,
        hasAudio: true,
      }
    case 'video':
    case 'avatar':
      return {
        name: clip.label || clip.sourceId,
        src: toFileSrc(clip.sourceId),
        durationSeconds: clipSourceDuration(clip),
        hasVideo: true,
        hasAudio: true,
      }
    case 'title':
    default:
      return null
  }
}

/** A conservative source-duration estimate when the resolver has no metadata. */
function clipSourceDuration(clip: Clip): number {
  const trimmed = clip.trimStart + clip.duration
  if (clip.trimEnd != null && clip.trimEnd > trimmed) return clip.trimEnd
  return Math.max(trimmed, clip.duration)
}

/** Turn a sourceId into a `src` URL. Absolute/already-URL ids pass through. */
function toFileSrc(sourceId: string): string {
  if (/^[a-z]+:\/\//i.test(sourceId)) return sourceId
  if (sourceId.startsWith('/')) return `file://${sourceId}`
  return `file://${sourceId}`
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startTime - b.startTime)
}

/** Total timeline duration across all tracks (last clip end), in seconds. */
function timelineDuration(timeline: Timeline): number {
  let max = 0
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const dur = Number.isFinite(clip.duration) ? clip.duration : 0
      max = Math.max(max, clip.startTime + dur)
    }
  }
  return max
}

// ── Minimal XML tree + renderer ──────────────────────────────────────────────
// Structure is declared with `el`, and `render`
// owns all indentation + escaping so no fragment hardcodes whitespace.

interface XMLNode {
  name: string
  attributes: Array<[string, string]>
  children: XMLNode[]
}

function el(name: string, attributes: Array<[string, string]> = [], children: XMLNode[] = []): XMLNode {
  return { name, attributes, children }
}

function render(node: XMLNode, indent: number): string {
  const pad = ' '.repeat(indent)
  const attrs = node.attributes.map(([k, v]) => ` ${k}="${escapeXML(v)}"`).join('')
  if (node.children.length === 0) return `${pad}<${node.name}${attrs}/>`
  const inner = node.children.map((c) => render(c, indent + 4)).join('\n')
  return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`
}

function escapeXML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
