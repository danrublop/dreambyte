import { listActiveRules } from '@/lib/db/queries/rules'

/** Cap on total injected rule text, so a few long rules can't blow up the
 *  system prompt / token cost. Rules beyond the budget are dropped. */
const MAX_RULES_CHARS = 8000

/** Minimal scene shape glob matching needs (keeps tests dependency-free). */
export interface RuleMatchScene {
  name: string
  sceneType?: string
}

/**
 * Tiny glob → RegExp: `*` = any run, `?` = one char, everything else literal.
 * Case-insensitive, anchored. No dependency; no brace/class support — rule
 * patterns are user-typed scene names like `Intro*` or types like `d3`.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * A `glob` rule applies when ANY scene's
 * NAME or TYPE matches its pattern — the UI calls this tier "By scene". The
 * in-app agent has no file paths; scenes are the addressable unit.
 */
export function matchScenesForRule(pattern: string, scenes: RuleMatchScene[]): RuleMatchScene[] {
  if (!pattern.trim()) return []
  let re: RegExp
  try {
    re = globToRegExp(pattern.trim())
  } catch {
    return []
  }
  return scenes.filter((s) => re.test(s.name) || (s.sceneType ? re.test(s.sceneType) : false))
}

/**
 * Build the user-authored rules section for the agent system prompt.
 *
 * `always`-mode rules inject unconditionally; `glob` ("By scene") rules
 * inject when any project scene matches their pattern, annotated with the
 * matching scene names so the model knows WHERE the rule applies. `manual`
 * rules stay UI-only. A DB error returns '' so an agent run never breaks
 * on this.
 */
export async function buildRulesSection(projectId?: string | null, scenes: RuleMatchScene[] = []): Promise<string> {
  try {
    const active = await listActiveRules(projectId)
    const applicable: Array<{ name: string; body: string; appliesTo?: string }> = []
    for (const r of active) {
      if (r.applyMode === 'always') {
        applicable.push({ name: r.name, body: r.body })
      } else if (r.applyMode === 'glob' && r.globPattern) {
        const matched = matchScenesForRule(r.globPattern, scenes)
        if (matched.length > 0) {
          const names = matched
            .slice(0, 6)
            .map((s) => `"${s.name}"`)
            .join(', ')
          applicable.push({
            name: r.name,
            body: r.body,
            appliesTo: `${names}${matched.length > 6 ? ` (+${matched.length - 6} more)` : ''}`,
          })
        }
      }
    }
    if (applicable.length === 0) return ''

    let budget = MAX_RULES_CHARS
    const parts: string[] = []
    for (const r of applicable) {
      const scope = r.appliesTo ? `\n_Applies to scenes: ${r.appliesTo}_` : ''
      const block = `### ${r.name}${scope}\n${r.body.trim()}`
      // Skip an oversized rule but keep packing smaller ones that still fit —
      // one huge rule shouldn't suppress every rule after it.
      if (block.length > budget) continue
      budget -= block.length
      parts.push(block)
    }
    if (parts.length === 0) return ''

    return [
      '## User rules',
      'User-authored guidance. Follow it; it takes precedence over defaults where they conflict.',
      '',
      parts.join('\n\n'),
    ].join('\n')
  } catch {
    return ''
  }
}
