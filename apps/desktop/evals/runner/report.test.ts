// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { renderMarkdownReport } from './report'
import type { CaseResult } from './run-eval'

describe('renderMarkdownReport', () => {
  const baseResults: CaseResult[] = [
    {
      id: 'svg-001',
      prompt: 'Animated bar chart',
      sceneType: 'svg',
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.0042,
      latencyMs: 3200,
      truncated: false,
      generatedCode: '<svg></svg>',
      codeValidity: { passed: true, warnings: [], hardFailures: [], softWarnings: [] },
    },
    {
      id: 'react-001',
      prompt: 'Three step cards',
      sceneType: 'react',
      inputTokens: 1500,
      outputTokens: 1200,
      costUsd: 0.0061,
      latencyMs: 4800,
      truncated: false,
      generatedCode: 'export default function Scene() { return <div /> }',
      codeValidity: {
        passed: false,
        warnings: ['EMPTY: Scene has no visual content'],
        hardFailures: ['EMPTY: Scene has no visual content'],
        softWarnings: [],
      },
    },
  ]

  it('renders header, summary, and per-case table', () => {
    const md = renderMarkdownReport({
      suite: 'scene-codegen',
      model: 'claude-haiku-4-5-20251001',
      startedAt: '2026-05-12T21:00:00.000Z',
      durationMs: 8000,
      results: baseResults,
    })
    expect(md).toContain('# Eval report — scene-codegen')
    expect(md).toContain('claude-haiku-4-5-20251001')
    expect(md).toContain('## Summary')
    expect(md).toContain('| Cases | 2 |')
    expect(md).toContain('Passed (code validity) | 1 (50%)')
    expect(md).toContain('| svg-001 | svg | OK |')
    expect(md).toContain('| react-001 | react | FAIL |')
  })

  it('includes failures section with prompt + hard failures', () => {
    const md = renderMarkdownReport({
      suite: 'scene-codegen',
      model: 'm',
      startedAt: '2026-05-12T21:00:00.000Z',
      durationMs: 1000,
      results: baseResults,
    })
    expect(md).toContain('## Failures')
    expect(md).toContain('### react-001')
    expect(md).toContain('Three step cards')
    expect(md).toContain('EMPTY: Scene has no visual content')
  })

  it('omits Failures section when everything passed', () => {
    const md = renderMarkdownReport({
      suite: 'scene-codegen',
      model: 'm',
      startedAt: '2026-05-12T21:00:00.000Z',
      durationMs: 1000,
      results: [baseResults[0]],
    })
    expect(md).not.toContain('## Failures')
  })

  it('handles error rows and shows them in the table', () => {
    const md = renderMarkdownReport({
      suite: 's',
      model: 'm',
      startedAt: '2026-05-12T21:00:00.000Z',
      durationMs: 1000,
      results: [
        {
          id: 'crash-001',
          prompt: 'p',
          sceneType: 'svg',
          latencyMs: 500,
          error: 'Network timeout while calling provider',
        },
      ],
    })
    expect(md).toContain('| crash-001 | svg | FAIL |')
    expect(md).toContain('error: Network timeout')
    expect(md).toContain('Error: Network timeout while calling provider')
  })

  it('reports avg LLM-judge score when judges ran', () => {
    const withJudge: CaseResult = {
      ...baseResults[0],
      llmJudge: { score: 8.5, rationale: 'looks good' },
    }
    const md = renderMarkdownReport({
      suite: 's',
      model: 'm',
      startedAt: '2026-05-12T21:00:00.000Z',
      durationMs: 1000,
      results: [withJudge],
    })
    expect(md).toContain('Avg LLM-judge score | 8.50 / 10')
  })
})
