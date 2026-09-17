/**
 * Storyboard — the per-scene shot list (Lane 1, quality by construction).
 *
 * THE FLOW requires a scene to be a sequence of timed beats the camera travels
 * between, not a static slide. This module makes that structure a REQUIRED build
 * artifact rather than a prompt hope: every planned scene carries a storyboard,
 * derived from its narration when the agent didn't author one explicitly. The
 * derived skeleton is deliberately structural (alternating TEXT / ANIMATION beats
 * mapped to camera stations) — it scaffolds per-beat thinking; it does not judge
 * taste. The FLOW gate (tool-executor.flowBlockForTool) separately enforces that
 * the built code actually realizes this structure.
 *
 * Pure + leaf (no imports from types.ts / orchestrator) so both plan_scenes and
 * the orchestrator can use it without a cycle, and it is trivially unit-testable.
 */

export interface StoryboardBeat {
  /** TEXT beats are big kinetic headlines; ANIMATION beats develop the idea visually. */
  kind: 'text' | 'animation'
  /** The line shown/spoken (TEXT) or the thing that animates (ANIMATION). */
  copy: string
  /** Where the camera sits / what the world shows at this beat. */
  station?: string
}

/** The minimal shape deriveStoryboard reads — a PlannedScene / SceneSpec subset.
 *  visualElements is string on SceneSpec but string[] on PlannedScene, so accept
 *  both (a comma-joined string would otherwise corrupt an element containing a
 *  comma, and an array would crash the string .split path). */
export interface StoryboardSource {
  storyboard?: StoryboardBeat[]
  narrationDraft?: string
  visualElements?: string | string[]
  purpose?: string
  name?: string
}

// A scene shouldn't sprawl into 20 stations, so the DERIVED skeleton (mechanical
// narration / visualElements splits) is capped. Author-provided beats are NOT
// capped — a hand-authored shot list is intentional and must never be dropped (③.6).
const MAX_BEATS = 6

/**
 * Return the scene's storyboard, deriving one when the agent didn't author it, so
 * a storyboard is ALWAYS present by construction. Preference order:
 *  1. author-provided beats (forward-compatible with a future plan_scenes field);
 *  2. narration split into phrase beats, alternating TEXT / ANIMATION;
 *  3. visualElements as animation beats;
 *  4. a two-beat skeleton from the purpose.
 * Always returns >= 2 beats so THE FLOW has stations to travel between.
 *
 * `onWarn` (optional) is invoked when a DERIVED split is truncated at MAX_BEATS, so
 * that cap is never silent. Author-provided beats are returned in FULL — they are
 * never truncated, so they never warn.
 */
export function deriveStoryboard(src: StoryboardSource, onWarn?: (msg: string) => void): StoryboardBeat[] {
  let beats: StoryboardBeat[] = []

  if (src.storyboard && src.storyboard.length > 0) {
    // Author-provided — keep EVERY beat (a hand-authored shot list is intentional;
    // the old slice(0, MAX_BEATS) silently dropped the tail, so a 10-beat plan shipped
    // as 6, the "dropped story beats" defect). Still falls through to the >= 2 pad below
    // so a single authored beat can't produce a self-contradicting one-station plan.
    beats = [...src.storyboard]
  }

  const narration = (src.narrationDraft ?? '').trim()
  if (beats.length === 0 && narration) {
    const allPhrases = narration
      .split(/(?<=[.!?;:])\s+|\s+—\s+/)
      .map((p) => p.trim())
      .filter(Boolean)
    const phrases = allPhrases.slice(0, MAX_BEATS)
    if (allPhrases.length > MAX_BEATS) {
      onWarn?.(`Storyboard derived from narration truncated to ${MAX_BEATS} beats (from ${allPhrases.length} phrases).`)
    }
    beats = phrases.map((copy, i) => ({
      kind: i % 2 === 0 ? 'text' : 'animation',
      copy,
      station: `station ${i + 1}`,
    }))
  }

  if (beats.length === 0) {
    // Accept string[] (PlannedScene) or a comma/semicolon string (SceneSpec)
    // without a lossy join→split round-trip.
    const allVisuals = (
      Array.isArray(src.visualElements) ? src.visualElements : (src.visualElements ?? '').split(/[,;]/)
    )
      .map((v) => v.trim())
      .filter(Boolean)
    const visuals = allVisuals.slice(0, MAX_BEATS)
    if (allVisuals.length > MAX_BEATS) {
      onWarn?.(`Storyboard derived from visualElements truncated to ${MAX_BEATS} beats (from ${allVisuals.length}).`)
    }
    beats = visuals.map((copy, i) => ({ kind: 'animation' as const, copy, station: `station ${i + 1}` }))
  }

  if (beats.length === 0) {
    beats = [{ kind: 'text', copy: src.purpose || src.name || 'Open on the key idea', station: 'station 1' }]
  }

  // THE FLOW needs at least two stations to travel between — pad a closing beat.
  if (beats.length < 2) {
    beats.push({
      kind: 'animation',
      copy: 'Develop the idea, then hand off to the next beat',
      station: `station ${beats.length + 1}`,
    })
  }

  return beats
}

/**
 * Render the storyboard into the MANDATORY shot-list block handed to a scene
 * builder. Empty string when there are no beats (defensive — plan_scenes always
 * derives at least two).
 */
export function renderStoryboardBlock(beats: StoryboardBeat[] | undefined): string {
  if (!beats || beats.length === 0) return ''
  const lines = beats
    .map((b, i) => `${i + 1}. [${b.kind.toUpperCase()}] ${b.copy}${b.station ? ` — ${b.station}` : ''}`)
    .join('\n')
  return (
    `\n## Storyboard (shot list — build these beats IN ORDER)\n` +
    `Realize each beat as a station in ONE oversized world, and move the camera ` +
    `(interpolated translate + scale) between stations, timed across the scene. TEXT beats are ` +
    `BIG kinetic headlines; ANIMATION beats develop the idea visually. This shot list is the ` +
    `required structure — the scene must travel it, not present a static slide.\n${lines}`
  )
}
