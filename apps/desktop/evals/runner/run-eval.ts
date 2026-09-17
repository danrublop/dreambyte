#!/usr/bin/env tsx
/**
 * Eval harness CLI.
 *
 * Usage:
 *   npx tsx evals/runner/run-eval.ts --suite scene-codegen --model claude-haiku-4-5-20251001
 *   npx tsx evals/runner/run-eval.ts --suite scene-codegen --model deepseek-chat --max-cases 3
 *   npx tsx evals/runner/run-eval.ts --suite scene-codegen --model deepseek-chat --no-judge
 *
 * Reads a JSONL suite of prompts, generates code via `src/lib/generation/generate.ts`,
 * runs the code-validity judge (always) and the LLM judge (when key + flag),
 * writes a markdown report to `evals/runner/reports/{suite}-{model}-{timestamp}.md`.
 *
 * Exits non-zero if any case throws or has hard validity failures — so it
 * can gate CI / pre-merge checks.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { generateCode } from '@/lib/generation/generate'
import type { SceneType } from '@/lib/types'
import { judgeCodeValidity } from './judges/code-validity'
import { judgeWithLlm } from './judges/llm-judge'
import { renderMarkdownReport, type CaseResult } from './report'

export type { CaseResult } from './report'

interface SuiteCase {
  id: string
  prompt: string
  sceneType: SceneType
  tags?: string[]
  reference?: string
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

function loadSuite(suiteName: string, here: string): SuiteCase[] {
  const path = join(here, 'suites', `${suiteName}.jsonl`)
  const raw = readFileSync(path, 'utf-8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as SuiteCase
    } catch (e) {
      throw new Error(`Failed to parse suite line ${idx + 1}: ${(e as Error).message}`)
    }
  })
}

function buildScene(sceneType: SceneType, code: string) {
  // Build a minimal Scene-shaped object so quickValidateScene can reason
  // about it. Field names mirror what generateCode populates per scene type.
  const base = {
    id: 'eval',
    name: 'eval',
    sceneType,
    duration: 8,
    durationSeconds: 8,
    bgColor: '#000',
    aiLayers: [],
    svgObjects: [],
    interactions: [],
    variables: [],
    textOverlays: [],
  } as Record<string, unknown>
  if (sceneType === 'svg') base.svgContent = code
  else if (sceneType === 'canvas2d') base.canvasCode = code
  else if (sceneType === 'react') base.reactCode = code
  else base.sceneCode = code
  return base as never
}

async function runCase(caseDef: SuiteCase, model: string, useLlmJudge: boolean): Promise<CaseResult> {
  const startedAt = Date.now()
  let result: Awaited<ReturnType<typeof generateCode>> | null = null
  let error: string | undefined
  try {
    result = await generateCode(caseDef.sceneType, caseDef.prompt, { modelId: model })
  } catch (e) {
    error = (e as Error).message
  }
  const latencyMs = Date.now() - startedAt

  const out: CaseResult = {
    id: caseDef.id,
    prompt: caseDef.prompt,
    sceneType: caseDef.sceneType,
    latencyMs,
    error,
  }
  if (!result) return out

  out.inputTokens = result.usage.input_tokens
  out.outputTokens = result.usage.output_tokens
  out.costUsd = result.usage.cost_usd
  out.truncated = result.truncated
  out.generatedCode = result.code
  out.codeValidity = judgeCodeValidity(buildScene(caseDef.sceneType, result.code))

  if (useLlmJudge) {
    out.llmJudge = await judgeWithLlm({
      prompt: caseDef.prompt,
      sceneType: caseDef.sceneType,
      generatedCode: result.code,
      reference: caseDef.reference,
    })
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const suiteName = (args.suite as string) || 'scene-codegen'
  const model = (args.model as string) || 'claude-haiku-4-5-20251001'
  const maxCases = args['max-cases'] ? parseInt(args['max-cases'] as string, 10) : Infinity
  const useLlmJudge = !args['no-judge']
  const writeReport = !args['stdout-only']

  const here = fileURLToPath(new URL('.', import.meta.url))
  const cases = loadSuite(suiteName, here).slice(0, maxCases)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  console.error(`[eval] suite=${suiteName} model=${model} cases=${cases.length} judge=${useLlmJudge}`)

  const results: CaseResult[] = []
  for (const c of cases) {
    process.stderr.write(`[eval] ${c.id} (${c.sceneType})... `)
    const r = await runCase(c, model, useLlmJudge)
    results.push(r)
    const status = r.error ? 'ERROR' : r.codeValidity?.passed ? 'PASS' : 'FAIL'
    process.stderr.write(`${status} (${(r.latencyMs ?? 0) / 1000}s, $${(r.costUsd ?? 0).toFixed(4)})\n`)
  }

  const durationMs = Date.now() - t0
  const report = renderMarkdownReport({ suite: suiteName, model, startedAt, durationMs, results })

  if (writeReport) {
    const reportsDir = join(here, 'reports')
    mkdirSync(reportsDir, { recursive: true })
    const ts = startedAt.replace(/[:.]/g, '-')
    const safeModel = model.replace(/[^a-z0-9.-]/gi, '_')
    const reportPath = join(reportsDir, `${suiteName}-${safeModel}-${ts}.md`)
    writeFileSync(reportPath, report, 'utf-8')
    console.error(`[eval] report written: ${resolve(reportPath)}`)
  }

  process.stdout.write(report)

  const hasFailure = results.some((r) => r.error || !r.codeValidity?.passed)
  process.exit(hasFailure ? 1 : 0)
}

main().catch((e) => {
  console.error('[eval] fatal:', e)
  process.exit(2)
})
