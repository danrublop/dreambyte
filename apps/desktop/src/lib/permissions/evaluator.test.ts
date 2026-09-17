import { describe, it, expect } from 'vitest'
import type { PermissionContext, PermissionRule, SpendState } from '../types/permissions'
import { evaluatePermission } from './evaluator'
import { matchSpecifier } from './specifier-matcher'
import { parseRule, formatRule, RuleParseError } from './rule-parser'

const NO_SPEND: SpendState = {
  sessionSpend: 0,
  sessionLimit: null,
  monthlySpend: 0,
  monthlyLimit: null,
}

const CTX: PermissionContext = {
  userId: 'u1',
  workspaceId: 'w1',
  projectId: 'p1',
  conversationId: 'c1',
  api: 'imageGen',
  call: { provider: 'flux-schnell', estimatedCostUsd: 0.01 },
}

function rule(overrides: Partial<PermissionRule>): PermissionRule {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    scope: overrides.scope ?? 'user',
    userId: 'u1',
    workspaceId: overrides.workspaceId ?? null,
    projectId: overrides.projectId ?? null,
    conversationId: overrides.conversationId ?? null,
    decision: overrides.decision ?? 'allow',
    api: overrides.api ?? 'imageGen',
    specifier: overrides.specifier ?? null,
    costCapUsd: overrides.costCapUsd ?? null,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: new Date(),
    createdBy: 'user-settings',
    notes: overrides.notes ?? null,
  }
}

describe('evaluatePermission — deny-wins across scopes', () => {
  it('user-scope deny overrides session-scope allow', () => {
    const rules = [
      rule({ scope: 'user', decision: 'deny', api: 'imageGen' }),
      rule({ scope: 'session', decision: 'allow', api: 'imageGen', conversationId: 'c1' }),
    ]
    const result = evaluatePermission(CTX, rules, NO_SPEND)
    expect(result.action).toBe('deny')
  })

  it('* deny rule blocks specific API call', () => {
    const rules = [rule({ scope: 'user', decision: 'deny', api: '*' })]
    expect(evaluatePermission(CTX, rules, NO_SPEND).action).toBe('deny')
  })
})

describe('evaluatePermission — allow precedence', () => {
  it('returns allow when a matching allow exists and no deny', () => {
    const rules = [rule({ scope: 'project', decision: 'allow' })]
    expect(evaluatePermission(CTX, rules, NO_SPEND).action).toBe('allow')
  })

  it('picks the highest-scope (closest) allow when multiple match', () => {
    const userAllow = rule({ id: 'U', scope: 'user', decision: 'allow' })
    const sessionAllow = rule({ id: 'S', scope: 'session', decision: 'allow', conversationId: 'c1' })
    const result = evaluatePermission(CTX, [userAllow, sessionAllow], NO_SPEND)
    expect(result.action).toBe('allow')
    expect(result.matchedRuleId).toBe('S')
  })
})

describe('evaluatePermission — cost cap', () => {
  it('escalates to ask when estimate exceeds a costCapUsd on any matching rule', () => {
    const rules = [rule({ scope: 'user', decision: 'allow', costCapUsd: 0.02 })]
    const ctx: PermissionContext = { ...CTX, call: { ...CTX.call, estimatedCostUsd: 0.05 } }
    const result = evaluatePermission(ctx, rules, NO_SPEND)
    expect(result.action).toBe('ask')
    if (result.action === 'ask') expect(result.costTriggered).toBe(true)
  })

  it('does not escalate when estimate is within cap', () => {
    const rules = [rule({ scope: 'user', decision: 'allow', costCapUsd: 0.1 })]
    expect(evaluatePermission(CTX, rules, NO_SPEND).action).toBe('allow')
  })
})

describe('evaluatePermission — spend limits', () => {
  it('session spend limit trips before rules evaluate', () => {
    const rules = [rule({ scope: 'user', decision: 'allow' })]
    const spend: SpendState = { ...NO_SPEND, sessionSpend: 5, sessionLimit: 5 }
    const result = evaluatePermission(CTX, rules, spend)
    expect(result.action).toBe('deny')
    if (result.action === 'deny') expect(result.reason).toMatch(/Session spend/i)
  })

  it('monthly spend limit trips before rules evaluate', () => {
    const rules = [rule({ scope: 'user', decision: 'allow' })]
    const spend: SpendState = { ...NO_SPEND, monthlySpend: 100, monthlyLimit: 100 }
    expect(evaluatePermission(CTX, rules, spend).action).toBe('deny')
  })
})

describe('evaluatePermission — default and ask', () => {
  it('asks when no rule matches', () => {
    expect(evaluatePermission(CTX, [], NO_SPEND).action).toBe('ask')
  })

  it('asks when explicit ask rule exists and no allow matches', () => {
    const rules = [rule({ scope: 'project', decision: 'ask' })]
    const result = evaluatePermission(CTX, rules, NO_SPEND)
    expect(result.action).toBe('ask')
  })

  it('expired rules are ignored', () => {
    const rules = [
      rule({
        scope: 'session',
        decision: 'allow',
        conversationId: 'c1',
        expiresAt: new Date(Date.now() - 60_000),
      }),
    ]
    expect(evaluatePermission(CTX, rules, NO_SPEND).action).toBe('ask')
  })
})

describe('matchSpecifier', () => {
  const call = {
    prompt: 'Draw a red square logo',
    duration: 4,
    provider: 'flux-schnell',
    model: 'flux-schnell-v1',
    estimatedCostUsd: 0.03,
  }

  it('null specifier matches anything', () => {
    expect(matchSpecifier(null, call)).toBe(true)
  })

  it('matches by provider and model', () => {
    expect(matchSpecifier({ provider: 'flux-schnell' }, call)).toBe(true)
    expect(matchSpecifier({ provider: 'veo3' }, call)).toBe(false)
    expect(matchSpecifier({ model: 'flux-schnell-v1' }, call)).toBe(true)
    expect(matchSpecifier({ model: 'flux-pro' }, call)).toBe(false)
  })

  it('matches by duration bounds', () => {
    expect(matchSpecifier({ durationMax: 5 }, call)).toBe(true)
    expect(matchSpecifier({ durationMax: 3 }, call)).toBe(false)
    expect(matchSpecifier({ durationMin: 2, durationMax: 5 }, call)).toBe(true)
    expect(matchSpecifier({ durationMin: 10 }, call)).toBe(false)
  })

  it('matches by costMax (inclusive)', () => {
    expect(matchSpecifier({ costMax: 0.03 }, call)).toBe(true)
    expect(matchSpecifier({ costMax: 0.02 }, call)).toBe(false)
  })

  it('promptContains requires ALL substrings (case-insensitive)', () => {
    expect(matchSpecifier({ promptContains: ['logo', 'red'] }, call)).toBe(true)
    expect(matchSpecifier({ promptContains: ['LOGO'] }, call)).toBe(true)
    expect(matchSpecifier({ promptContains: ['logo', 'missing'] }, call)).toBe(false)
  })

  it('promptNotContains excludes when any substring is present', () => {
    expect(matchSpecifier({ promptNotContains: ['never-here'] }, call)).toBe(true)
    expect(matchSpecifier({ promptNotContains: ['logo'] }, call)).toBe(false)
  })

  it('duration conditions fail when call has no duration', () => {
    expect(matchSpecifier({ durationMax: 5 }, { provider: 'x' })).toBe(false)
    expect(matchSpecifier({ durationMin: 1 }, { provider: 'x' })).toBe(false)
  })
})

describe('rule parser', () => {
  it('parses bare API', () => {
    expect(parseRule('allow: freesound')).toEqual({
      decision: 'allow',
      api: 'freesound',
      specifier: null,
    })
  })

  it('parses specifier with multiple fields', () => {
    const r = parseRule('allow: imageGen(model:flux-schnell,costMax:0.05)')
    expect(r.decision).toBe('allow')
    expect(r.api).toBe('imageGen')
    expect(r.specifier).toEqual({ model: 'flux-schnell', costMax: 0.05 })
  })

  it('parses pipe-separated list values', () => {
    const r = parseRule('deny: elevenLabs(promptContains:badword|slur)')
    expect(r.specifier?.promptContains).toEqual(['badword', 'slur'])
  })

  it('round-trips via formatRule', () => {
    const input = 'ask: veo3(durationMax:5,costMax:2)'
    expect(formatRule(parseRule(input))).toBe(input)
  })

  it('rejects unknown decision', () => {
    expect(() => parseRule('maybe: imageGen')).toThrow(RuleParseError)
  })

  it('rejects missing colon', () => {
    expect(() => parseRule('allow imageGen')).toThrow(RuleParseError)
  })

  it('rejects unknown specifier key', () => {
    expect(() => parseRule('allow: imageGen(color:red)')).toThrow(RuleParseError)
  })

  it('rejects non-numeric where number expected', () => {
    expect(() => parseRule('allow: imageGen(costMax:cheap)')).toThrow(RuleParseError)
  })
})
