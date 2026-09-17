// Pure time mapping for preview playback.
//
// A scene iframe reports SOURCE time (`masterTL.time()`): it starts at the clip's
// in-point (`trimStart`) and advances at the clip's `speed`. The preview playhead and
// timecode work in CLIP-LOCAL (timeline) time — 0 at the clip's left edge, advancing
// one second per timeline-second — because `globalTime = sceneStartOffset + currentTime`.
//
// The seek path maps timeline→source as `sourceT = trimStart + localT * speed`. This is
// the inverse, used by the playback tick so a left-trimmed / split-right-half / sped clip
// doesn't make the playhead overshoot (the source clock would otherwise leak `trimStart`
// and the `speed` factor into the global timecode).

/**
 * Convert a clip's SOURCE time (iframe `masterTL.time()`) to CLIP-LOCAL timeline time.
 * Untrimmed, speed-1 clips (and the no-clip gap case, where trimStart=0 / speed=1)
 * reduce to `sourceTime` unchanged. `speed` is clamped to a positive value so a stored
 * 0 / negative can't produce Infinity or a backwards clock.
 */
export function clipLocalTime(
  sourceTime: number,
  trimStart: number | null | undefined,
  speed: number | null | undefined,
): number {
  const start = typeof trimStart === 'number' && Number.isFinite(trimStart) ? trimStart : 0
  const spd = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1
  return (sourceTime - start) / spd
}

/**
 * Seconds of CLIP-LOCAL timeline time left before the clip's out-point, given the
 * iframe's reported SOURCE time. `clip.duration` is the clip's TIMELINE length
 * (post trim + speed), so the remaining window is `duration - clipLocalTime(t)`.
 *
 * Used by the fade-transition window check: the cross-fade starts when
 * `remaining < transition.duration`. The pre-fix math (`duration - t * speed`)
 * multiplied source time by speed instead of dividing, and ignored `trimStart`
 * entirely — a left-trimmed or sped clip started its fade at the wrong moment
 * (or never). For an untrimmed speed-1 clip this reduces to exactly the old
 * `duration - sourceTime`.
 */
export function fadeRemaining(
  sourceTime: number,
  clip: { duration: number; trimStart?: number | null; speed?: number | null },
): number {
  return clip.duration - clipLocalTime(sourceTime, clip.trimStart, clip.speed)
}
