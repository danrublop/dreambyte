/**
 * @-mentions for scenes in the agent composer (scenes and named AI layers).
 *
 * Pure helpers — the popover/keyboard wiring lives in AgentChat, mirroring
 * the slash-command autocomplete. Detection is TAIL-ANCHORED (the active
 * mention is the '@token' the user is typing at the end of the input), the
 * same simplification the slash menu makes by only matching input start —
 * no caret plumbing.
 *
 * Resolution happens at send time: mentioned scene names are resolved to ids
 * and appended as a bracketed note on the outgoing text, following the
 * existing attached-asset-note precedent. The note is what makes a mention
 * USEFUL — the model already has every scene in world state; the mention
 * pins WHICH scene the user means (duplicate names resolve to all matches).
 */

/** Minimal scene shape the helpers need (keeps tests dependency-free). */
export interface MentionableScene {
  id: string
  name: string
  sceneType?: string
  duration?: number
  /** AI layers carry user-facing labels (the Layers panel shows them) — the
   *  only layer kind with stable names, so the only kind mentionable.
   *  svgObjects/textOverlays have prompts/content, not names — future work. */
  aiLayers?: Array<{ id: string; label?: string }>
}

/** One thing an '@' can resolve to: a scene or a named AI layer. */
export interface MentionTarget {
  kind: 'scene' | 'layer'
  id: string
  name: string
  /** For layers: the owning scene. */
  sceneId?: string
  sceneName?: string
  /** Popover description — 'react · 8s' for scenes, 'layer · in Intro' for layers. */
  detail?: string
}

/** Flatten scenes + their labeled AI layers into the mentionable universe. */
export function collectMentionTargets(scenes: MentionableScene[]): MentionTarget[] {
  const out: MentionTarget[] = []
  for (const s of scenes) {
    if (!s.name || !s.name.trim()) continue
    const meta = [s.sceneType, typeof s.duration === 'number' ? `${s.duration}s` : null].filter(Boolean).join(' · ')
    out.push({ kind: 'scene', id: s.id, name: s.name, detail: meta || undefined })
    for (const l of s.aiLayers ?? []) {
      if (!l.label || !l.label.trim()) continue
      out.push({
        kind: 'layer',
        id: l.id,
        name: l.label,
        sceneId: s.id,
        sceneName: s.name,
        detail: `layer · in ${s.name}`,
      })
    }
  }
  return out
}

/** Case-insensitive name filter over targets: prefix before substring. */
export function filterTargetsForMention(targets: MentionTarget[], query: string): MentionTarget[] {
  const q = query.toLowerCase()
  if (!q) return targets.slice(0, 6)
  const prefix = targets.filter((t) => t.name.toLowerCase().startsWith(q))
  const substr = targets.filter((t) => !t.name.toLowerCase().startsWith(q) && t.name.toLowerCase().includes(q))
  return [...prefix, ...substr].slice(0, 6)
}

/** The '@token' being typed at the end of the input, or null when none.
 *  The '@' must start the input or follow whitespace; the token may contain
 *  spaces only via popover insertion (typing stops matching at whitespace). */
export function getMentionQuery(input: string): string | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(input)
  return m ? m[2] : null
}

const MAX_SUGGESTIONS = 6

/** Case-insensitive name filter: prefix matches rank before substring matches. */
export function filterScenesForMention(scenes: MentionableScene[], query: string): MentionableScene[] {
  const q = query.toLowerCase()
  const named = scenes.filter((s) => s.name && s.name.trim().length > 0)
  if (!q) return named.slice(0, MAX_SUGGESTIONS)
  const prefix = named.filter((s) => s.name.toLowerCase().startsWith(q))
  const substr = named.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q))
  return [...prefix, ...substr].slice(0, MAX_SUGGESTIONS)
}

/** Replace the trailing '@token' with the selected scene's mention. */
export function insertMention(input: string, sceneName: string): string {
  return input.replace(/@[^\s@]*$/, `@${sceneName} `)
}

/**
 * Resolve @-mentions in the outgoing text to scene ids and render the
 * bracketed note (or null when nothing resolves). Longest names match first
 * so "@Intro Detail" never half-matches a scene named "Intro". Duplicate
 * names resolve to every match — ambiguity is surfaced, not guessed away.
 */
export function buildMentionNote(text: string, scenes: MentionableScene[]): string | null {
  if (!text.includes('@')) return null
  const byLength = collectMentionTargets(scenes).sort((a, b) => b.name.length - a.name.length)
  const mentioned: MentionTarget[] = []
  const seen = new Set<string>()
  let remaining = text
  for (const t of byLength) {
    const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`@${esc}(?=\\s|$|[.,!?;:])`, 'i')
    if (re.test(remaining)) {
      // Consume the matched mention so a shorter same-prefix name can't
      // re-match the same token; same-NAME duplicates (incl. a scene and a
      // layer sharing a name) still all resolve — ambiguity surfaced, not
      // guessed away.
      for (const dup of byLength) {
        if (dup.name.toLowerCase() === t.name.toLowerCase() && !seen.has(`${dup.kind}:${dup.id}`)) {
          seen.add(`${dup.kind}:${dup.id}`)
          mentioned.push(dup)
        }
      }
      remaining = remaining.replace(re, '')
    }
  }
  if (mentioned.length === 0) return null
  const lines = mentioned.map((t) =>
    t.kind === 'scene'
      ? `"${t.name}" (sceneId ${t.id}${t.detail ? `; ${t.detail.replace(' · ', ', ')}` : ''})`
      : `"${t.name}" (layerId ${t.id} in scene "${t.sceneName}" sceneId ${t.sceneId})`,
  )
  return `\n\n[Referenced: ${lines.join(' · ')}. Target scenes by sceneId and layers by layerId.]`
}
