/**
 * Markdown reporter for eval runs. Pure function over case results — no
 * filesystem I/O, just string construction. The CLI in run-eval.ts decides
 * whether to print to stdout or write to a file.
 */

import type { SceneType } from '@/lib/types'

export interface CaseResult {
  id: string
  prompt: string
  sceneType: SceneType
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  latencyMs?: number
  truncated?: boolean
  generatedCode?: string
  codeValidity?: ReturnType<typeof import('./judges/code-validity').judgeCodeValidity>
  llmJudge?: Awaited<ReturnType<typeof import('./judges/llm-judge').judgeWithLlm>>
  error?: string
}

export function renderMarkdownReport(opts: {
  suite: string
  model: string
  startedAt: string
  durationMs: number
  results: CaseResult[]
}): string {
  const { suite, model, startedAt, durationMs, results } = opts
  const total = results.length
  const passed = results.filter((r) => r.codeValidity?.passed).length
  const failed = total - passed
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const totalTokens = results.reduce(
    (sum, r) => sum + (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
    0,
  )
  const avgLatencyMs =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + (r.latencyMs ?? 0), 0) / results.length)
      : 0
  const judgeScores = results.map((r) => r.llmJudge?.score).filter((s): s is number => s !== null && s !== undefined)
  const avgJudgeScore =
    judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : null

  const lines: string[] = []
  lines.push(`# Eval report — ${suite}`)
  lines.push('')
  lines.push(`- **Model:** ${model}`)
  lines.push(`- **Started:** ${startedAt}`)
  lines.push(`- **Duration:** ${(durationMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|---|---|`)
  lines.push(`| Cases | ${total} |`)
  lines.push(`| Passed (code validity) | ${passed} (${total > 0 ? ((passed / total) * 100).toFixed(0) : 0}%) |`)
  lines.push(`| Failed | ${failed} |`)
  lines.push(`| Total tokens | ${totalTokens.toLocaleString()} |`)
  lines.push(`| Total cost | $${totalCost.toFixed(4)} |`)
  lines.push(`| Avg latency | ${(avgLatencyMs / 1000).toFixed(2)}s |`)
  if (avgJudgeScore !== null) {
    lines.push(`| Avg LLM-judge score | ${avgJudgeScore.toFixed(2)} / 10 |`)
  }
  lines.push('')

  lines.push('## Cases')
  lines.push('')
  lines.push(`| ID | Type | Pass | Tokens | Cost | Latency | Judge | Notes |`)
  lines.push(`|---|---|---|---|---|---|---|---|`)
  for (const r of results) {
    const pass = r.codeValidity?.passed ? 'OK' : 'FAIL'
    const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0)
    const cost = `$${(r.costUsd ?? 0).toFixed(4)}`
    const latency = `${((r.latencyMs ?? 0) / 1000).toFixed(2)}s`
    const judge = r.llmJudge?.score !== null && r.llmJudge?.score !== undefined ? r.llmJudge.score.toFixed(1) : '—'
    const notes = r.error
      ? `error: ${r.error.slice(0, 60)}`
      : r.codeValidity?.hardFailures.length
        ? r.codeValidity.hardFailures[0].slice(0, 60)
        : ''
    lines.push(`| ${r.id} | ${r.sceneType} | ${pass} | ${tokens} | ${cost} | ${latency} | ${judge} | ${notes} |`)
  }
  lines.push('')

  const failures = results.filter((r) => r.error || !r.codeValidity?.passed)
  if (failures.length > 0) {
    lines.push('## Failures')
    lines.push('')
    for (const r of failures) {
      lines.push(`### ${r.id} (${r.sceneType})`)
      lines.push('')
      lines.push(`Prompt: ${r.prompt}`)
      lines.push('')
      if (r.error) {
        lines.push(`Error: ${r.error}`)
      }
      if (r.codeValidity?.hardFailures.length) {
        lines.push('Hard failures:')
        for (const f of r.codeValidity.hardFailures) lines.push(`- ${f}`)
      }
      if (r.codeValidity?.softWarnings.length) {
        lines.push('Soft warnings:')
        for (const f of r.codeValidity.softWarnings) lines.push(`- ${f}`)
      }
      if (r.llmJudge?.rationale) {
        lines.push('')
        lines.push(`Judge: ${r.llmJudge.rationale}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
