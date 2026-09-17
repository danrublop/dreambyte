import type { APIName, PermissionDecision, RuleSpecifier } from '../types/permissions'

export interface ParsedRule {
  decision: PermissionDecision
  api: APIName | '*'
  specifier: RuleSpecifier | null
}

export class RuleParseError extends Error {}

/** Parse a single rule line. Examples:
 *    allow: freesound
 *    deny:  heygen
 *    allow: imageGen(model:flux-schnell,costMax:0.05)
 *    ask:   veo3(durationMax:5)
 *    allow: elevenLabs(promptContains:intro|outro)
 *
 *  List values (promptContains / promptNotContains) are pipe-separated.
 *  Numeric values are parsed via Number(); non-numeric → parse error. */
export function parseRule(line: string): ParsedRule {
  const trimmed = line.trim()
  if (!trimmed) throw new RuleParseError('Empty rule')

  const colon = trimmed.indexOf(':')
  if (colon < 0) throw new RuleParseError(`Missing ':' in "${trimmed}"`)

  const decisionRaw = trimmed.slice(0, colon).trim().toLowerCase()
  if (decisionRaw !== 'allow' && decisionRaw !== 'deny' && decisionRaw !== 'ask') {
    throw new RuleParseError(`Unknown decision "${decisionRaw}"`)
  }

  const rest = trimmed.slice(colon + 1).trim()
  const parenStart = rest.indexOf('(')

  const api = (parenStart < 0 ? rest : rest.slice(0, parenStart)).trim() as APIName | '*'
  if (!api) throw new RuleParseError('Missing API name')

  let specifier: RuleSpecifier | null = null
  if (parenStart >= 0) {
    if (!rest.endsWith(')')) throw new RuleParseError(`Unterminated specifier in "${rest}"`)
    const inner = rest.slice(parenStart + 1, -1).trim()
    specifier = inner ? parseSpecifier(inner) : null
  }

  return { decision: decisionRaw, api, specifier }
}

function parseSpecifier(inner: string): RuleSpecifier {
  const out: RuleSpecifier = {}
  for (const pair of splitPairs(inner)) {
    const eq = pair.indexOf(':')
    if (eq < 0) throw new RuleParseError(`Specifier "${pair}" needs key:value`)
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()

    switch (key) {
      case 'provider':
        out.provider = value
        break
      case 'model':
        out.model = value
        break
      case 'durationMax':
        out.durationMax = numOrThrow(key, value)
        break
      case 'durationMin':
        out.durationMin = numOrThrow(key, value)
        break
      case 'costMax':
        out.costMax = numOrThrow(key, value)
        break
      case 'promptContains':
        out.promptContains = value
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case 'promptNotContains':
        out.promptNotContains = value
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      default:
        throw new RuleParseError(`Unknown specifier key "${key}"`)
    }
  }
  return out
}

function splitPairs(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function numOrThrow(key: string, value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new RuleParseError(`Expected number for ${key}, got "${value}"`)
  return n
}

/** Serialize back to text-syntax form for settings UI display. Round-trips with `parseRule`. */
export function formatRule(rule: ParsedRule): string {
  const spec = rule.specifier ? formatSpecifier(rule.specifier) : ''
  return `${rule.decision}: ${rule.api}${spec}`
}

function formatSpecifier(s: RuleSpecifier): string {
  const parts: string[] = []
  if (s.provider !== undefined) parts.push(`provider:${s.provider}`)
  if (s.model !== undefined) parts.push(`model:${s.model}`)
  if (s.durationMax !== undefined) parts.push(`durationMax:${s.durationMax}`)
  if (s.durationMin !== undefined) parts.push(`durationMin:${s.durationMin}`)
  if (s.costMax !== undefined) parts.push(`costMax:${s.costMax}`)
  if (s.promptContains?.length) parts.push(`promptContains:${s.promptContains.join('|')}`)
  if (s.promptNotContains?.length) parts.push(`promptNotContains:${s.promptNotContains.join('|')}`)
  return parts.length ? `(${parts.join(',')})` : ''
}
