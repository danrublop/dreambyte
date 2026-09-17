/**
 * Scene-determinism lint.
 *
 * Scenes are rendered frame-by-frame and seeked deterministically by the
 * exporter, so any wall-clock time, real timers, or unseeded randomness makes
 * the same frame render differently across runs — the MP4 flickers and is not
 * reproducible. The system prompt already TELLS the model to avoid these
 * constructs (use `mulberry32(SEED)` for randomness, drive animation from the
 * frame clock), and the seeded-PRNG/time helpers are injected as scene globals.
 * But prompting is not enforcement: a scene can still call `Math.random()` and
 * render fine in the verifier (no throw) yet vary on export.
 *
 * This is the lint that catches it. It is intentionally a static, regex-based
 * scan with no parser dependency — cheap enough to run on every scene write.
 * It is ADVISORY: callers surface the violations to the agent so it can
 * self-correct; nothing here blocks a write or marks a scene errored.
 */

export interface DeterminismViolation {
  /** The offending construct, e.g. `Math.random(`. */
  construct: string
  /** Actionable fix the agent can act on. */
  hint: string
  /** 1-based line number of the first match, when locatable. */
  line?: number
}

const HINT_RANDOM =
  'use mulberry32(SEED)() — a seeded PRNG global — for reproducible randomness'
const HINT_CLOCK =
  'use the scene frame/time (useDreambyteTime/useCurrentFrame or the t parameter), never wall-clock time — it breaks frame-accurate export'
const HINT_TIMER =
  'drive animation from the frame clock (useDreambyteSeek / t), not timers — the renderer seeks frames deterministically'

/**
 * Each rule matches a non-deterministic call. Patterns operate on code that has
 * already had comments and string contents neutralized (see `stripNoise`), so
 * matches inside `// foo` or `"Math.random"` do not fire.
 *
 * `severity` is informational — `error` constructs (random, wall-clock time)
 * always break export; `warn` constructs (timers) are sometimes shimmed by the
 * renderer, so they are flagged more softly. All are returned; the caller
 * decides how loudly to surface them.
 */
interface Rule {
  construct: string
  re: RegExp
  hint: string
  severity: 'error' | 'warn'
  /**
   * Match against the ORIGINAL source instead of the noise-stripped copy.
   * Only `new Date()` needs this: stripping a string arg (`new Date("…")`)
   * blanks it to spaces, leaving `new Date(   )`, which the empty-parens
   * pattern would then wrongly flag as the zero-arg form. Matching the raw
   * source keeps the arg visible so a fixed timestamp is correctly ignored.
   * Comment/string false positives for this single rule are an acceptable
   * trade — the scan is advisory.
   */
  raw?: boolean
}

const RULES: Rule[] = [
  // Unseeded randomness — the canonical flicker source.
  { construct: 'Math.random(', re: /\bMath\s*\.\s*random\s*\(/g, hint: HINT_RANDOM, severity: 'error' },

  // Wall-clock time. `Date.now()`, `performance.now()`, and the zero-arg
  // `new Date()` all read the host clock. A `new Date(<arg>)` form (a fixed
  // timestamp) is deterministic and deliberately NOT matched — the `\)`
  // immediately after the optional whitespace ensures we only flag the
  // empty-parens form (scanned against raw source — see `raw` above).
  { construct: 'Date.now(', re: /\bDate\s*\.\s*now\s*\(/g, hint: HINT_CLOCK, severity: 'error' },
  { construct: 'performance.now(', re: /\bperformance\s*\.\s*now\s*\(/g, hint: HINT_CLOCK, severity: 'error' },
  { construct: 'new Date()', re: /\bnew\s+Date\s*\(\s*\)/g, hint: HINT_CLOCK, severity: 'error', raw: true },

  // Real timers. Sometimes shimmed onto the frame clock, hence lower severity.
  { construct: 'setTimeout(', re: /\bsetTimeout\s*\(/g, hint: HINT_TIMER, severity: 'warn' },
  { construct: 'setInterval(', re: /\bsetInterval\s*\(/g, hint: HINT_TIMER, severity: 'warn' },
  { construct: 'requestAnimationFrame(', re: /\brequestAnimationFrame\s*\(/g, hint: HINT_TIMER, severity: 'warn' },
]

/**
 * Neutralize comments and string/template contents so call patterns inside them
 * do not produce false positives, while preserving character offsets (and thus
 * line numbers) by replacing masked spans with spaces.
 *
 * This is a lightweight tokenizer, not a full JS parser — it handles the common
 * cases (line/block comments, '…', "…", `…`, escaped quotes). Pathological code
 * (e.g. a regex literal containing `Math.random(`) may slip through, but the
 * scan is advisory, so an occasional miss/extra is acceptable.
 */
function stripNoise(code: string): string {
  const out = code.split('')
  const n = code.length
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'

  const mask = (idx: number) => {
    // Keep newlines so line numbers stay accurate; blank everything else.
    if (out[idx] !== '\n') out[idx] = ' '
  }

  while (i < n) {
    const c = code[i]
    const c2 = i + 1 < n ? code[i + 1] : ''
    switch (mode) {
      case 'code':
        if (c === '/' && c2 === '/') {
          mode = 'line'
          mask(i)
          mask(i + 1)
          i += 2
          continue
        }
        if (c === '/' && c2 === '*') {
          mode = 'block'
          mask(i)
          mask(i + 1)
          i += 2
          continue
        }
        if (c === "'") {
          mode = 'single'
          mask(i)
          i++
          continue
        }
        if (c === '"') {
          mode = 'double'
          mask(i)
          i++
          continue
        }
        if (c === '`') {
          mode = 'template'
          mask(i)
          i++
          continue
        }
        i++
        continue
      case 'line':
        if (c === '\n') {
          mode = 'code'
          i++
          continue
        }
        mask(i)
        i++
        continue
      case 'block':
        if (c === '*' && c2 === '/') {
          mask(i)
          mask(i + 1)
          mode = 'code'
          i += 2
          continue
        }
        mask(i)
        i++
        continue
      case 'single':
      case 'double':
      case 'template': {
        const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`'
        if (c === '\\') {
          // Escaped char — mask both and skip.
          mask(i)
          mask(i + 1)
          i += 2
          continue
        }
        if (c === quote) {
          mask(i)
          mode = 'code'
          i++
          continue
        }
        mask(i)
        i++
        continue
      }
    }
  }

  return out.join('')
}

function lineOf(code: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') line++
  }
  return line
}

/**
 * Scan generated scene CODE for non-deterministic constructs that break
 * frame-accurate export. Returns one entry per distinct construct found (not
 * per occurrence), each with an actionable hint and the first offending line.
 * Deterministic code returns `[]`.
 *
 * `sceneType` is accepted for future per-type tuning (e.g. relaxing timer
 * warnings on a renderer known to shim them); it currently does not change the
 * ruleset.
 */
export function scanForNondeterminism(
  code: string,
  _sceneType?: string,
): DeterminismViolation[] {
  if (!code || typeof code !== 'string') return []

  const cleaned = stripNoise(code)
  const violations: DeterminismViolation[] = []

  for (const rule of RULES) {
    const target = rule.raw ? code : cleaned
    rule.re.lastIndex = 0
    const match = rule.re.exec(target)
    if (match) {
      violations.push({
        construct: rule.construct,
        hint: rule.hint,
        line: lineOf(target, match.index),
      })
    }
  }

  return violations
}
