// Cue translation for dubbing (Tier 3). Translates each SRT cue into the target language while
// keeping a strict 1:1 line correspondence — the dub pipeline time-fits cue N's translation to cue
// N's source window, so a merged/split/reordered line would desync every cue after it. We force a
// numbered response and parse it back by index, ignoring any model preamble.
//
// The raw model call is injected (`complete`) so this stays unit-testable; the real `complete` wires
// over src/lib/agents/providers/adapter.ts (streamChat) app-side.

export interface TranslateDeps {
  /** One-shot text completion. Returns the model's full text response. */
  complete: (prompt: string) => Promise<string>
}

export class TranslateError extends Error {}

/** Build the numbered translate prompt. Exported for test/inspection. */
export function buildTranslatePrompt(texts: string[], targetLanguage: string, sourceLanguage?: string): string {
  const from = sourceLanguage ? ` from ${sourceLanguage}` : ''
  const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim()}`).join('\n')
  return [
    `You are a professional dubbing translator. Translate the following ${texts.length} subtitle cues${from} into ${targetLanguage}.`,
    `Rules:`,
    `- Output EXACTLY ${texts.length} lines, each prefixed with its number and a period, matching the input 1:1.`,
    `- Translate each cue independently — never merge, split, reorder, add, or drop a line.`,
    `- Keep each translation natural and similar in spoken length to the source (this is for lip-synced dubbing).`,
    `- Preserve a line's meaning and tone; do not add commentary, notes, or the original text.`,
    ``,
    `Cues:`,
    numbered,
  ].join('\n')
}

/** Parse a numbered model response back into one translation per input index. Tolerates preamble,
 *  blank lines, and `1.` / `1)` / `1:` numbering. Throws if any cue index is missing. */
export function parseNumberedResponse(response: string, expectedCount: number): string[] {
  const byIndex = new Map<number, string>()
  for (const rawLine of response.replace(/\r\n/g, '\n').split('\n')) {
    const m = rawLine.match(/^\s*(\d+)\s*[.):]\s*(.+?)\s*$/)
    if (!m) continue
    const idx = Number(m[1])
    if (idx >= 1 && idx <= expectedCount && !byIndex.has(idx)) byIndex.set(idx, m[2].trim())
  }
  const out: string[] = []
  const missing: number[] = []
  for (let i = 1; i <= expectedCount; i++) {
    const v = byIndex.get(i)
    if (v === undefined) missing.push(i)
    out.push(v ?? '')
  }
  if (missing.length > 0) {
    throw new TranslateError(
      `Translation response is missing ${missing.length} of ${expectedCount} cues (lines ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}) — refusing to dub with desynced timing.`,
    )
  }
  return out
}

/**
 * Translate cues 1:1. Empty input → empty output (no model call). The returned array always has the
 * same length and order as `texts`; throws TranslateError on a count mismatch (the dub orchestrator
 * also guards this, but failing here gives a clearer message + avoids the TTS spend).
 */
export async function translateSegments(
  texts: string[],
  targetLanguage: string,
  sourceLanguage: string | undefined,
  deps: TranslateDeps,
): Promise<string[]> {
  if (texts.length === 0) return []
  if (!targetLanguage) throw new TranslateError('A target language is required')
  const prompt = buildTranslatePrompt(texts, targetLanguage, sourceLanguage)
  const response = await deps.complete(prompt)
  return parseNumberedResponse(response, texts.length)
}
