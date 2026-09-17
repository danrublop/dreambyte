import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RuleConfig } from '@/lib/types/rules'

vi.mock('@/lib/db/queries/rules', () => ({ listActiveRules: vi.fn() }))
import { listActiveRules } from '@/lib/db/queries/rules'
import { buildRulesSection } from './rules-context'

const mk = (over: Partial<RuleConfig>): RuleConfig => ({
  id: '1',
  scope: 'user',
  projectId: null,
  name: 'Rule',
  body: 'body',
  applyMode: 'always',
  globPattern: null,
  enabled: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  ...over,
})

const mocked = listActiveRules as unknown as ReturnType<typeof vi.fn>

describe('buildRulesSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty string when there are no rules', async () => {
    mocked.mockResolvedValue([])
    expect(await buildRulesSection(null)).toBe('')
  })

  it('always-mode rules inject; glob rules without a scene match (or scenes) do not', async () => {
    mocked.mockResolvedValue([
      mk({ id: 'a', name: 'KeepThis', applyMode: 'always', body: 'do x' }),
      mk({ id: 'b', name: 'GlobRule', applyMode: 'glob', globPattern: 'Intro*', body: 'no inject' }),
    ])
    // No scenes passed → no glob match.
    const out = await buildRulesSection(null)
    expect(out).toContain('KeepThis')
    expect(out).toContain('do x')
    expect(out).not.toContain('GlobRule')
    // Scenes present but none match the pattern.
    const out2 = await buildRulesSection(null, [{ name: 'Outro' }])
    expect(out2).not.toContain('GlobRule')
  })

  it('F4: a glob ("By scene") rule injects when a scene NAME matches, annotated with the scenes', async () => {
    mocked.mockResolvedValue([mk({ id: 'b', name: 'IntroStyle', applyMode: 'glob', globPattern: 'Intro*', body: 'use the brand serif' })])
    const out = await buildRulesSection(null, [{ name: 'Intro' }, { name: 'Intro Detail' }, { name: 'Outro' }])
    expect(out).toContain('IntroStyle')
    expect(out).toContain('use the brand serif')
    expect(out).toContain('Applies to scenes: "Intro", "Intro Detail"')
    expect(out).not.toContain('"Outro"')
  })

  it('F4: a glob rule also matches scene TYPE, case-insensitively', async () => {
    mocked.mockResolvedValue([mk({ id: 'b', name: 'ChartRules', applyMode: 'glob', globPattern: 'D3', body: 'label every axis' })])
    const out = await buildRulesSection(null, [{ name: 'Sales chart', sceneType: 'd3' }])
    expect(out).toContain('ChartRules')
    expect(out).toContain('label every axis')
  })

  it('F4: manual rules never inject; hostile glob patterns fail closed', async () => {
    mocked.mockResolvedValue([
      mk({ id: 'm', name: 'ManualRule', applyMode: 'manual', body: 'manual only' }),
      mk({ id: 'g', name: 'WeirdGlob', applyMode: 'glob', globPattern: '((', body: 'regex chars' }),
    ])
    const out = await buildRulesSection(null, [{ name: '((', sceneType: 'react' }])
    expect(out).not.toContain('ManualRule')
    // '((' matches the literal scene named '((' — escaping makes it literal, not a regex error.
    expect(out).toContain('WeirdGlob')
  })

  it('returns empty string on DB error so an agent run never breaks', async () => {
    mocked.mockRejectedValue(new Error('db down'))
    expect(await buildRulesSection('p1')).toBe('')
  })

  it('caps total injected size, dropping rules over budget', async () => {
    mocked.mockResolvedValue([
      mk({ id: 'a', name: 'First', body: 'small' }),
      mk({ id: 'b', name: 'Huge', body: 'x'.repeat(9000) }),
    ])
    const out = await buildRulesSection(null)
    expect(out).toContain('First')
    expect(out).not.toContain('Huge')
  })
})
