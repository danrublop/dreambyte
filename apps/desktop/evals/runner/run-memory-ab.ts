#!/usr/bin/env tsx
/**
 * Memory A/B eval gate.
 *
 * Runs each golden prompt TWICE — clean (baseline) and with a learned
 * preference injected the SAME way context-builder injects it — then asks the
 * pure gate (memory-ab.ts) whether the memory helped, was neutral, or harmed
 * the output. A harmful learned preference MUST be detected (gate fails the
 * run); a benign one MUST NOT regress quality.
 *
 * Usage:
 *   npx tsx evals/runner/run-memory-ab.ts --model claude-haiku-4-5-20251001
 *   npx tsx evals/runner/run-memory-ab.ts --no-judge        # validity-only (cheap)
 *
 * Key-gated: with no text provider key configured it prints a SKIP and exits 0
 * (CI without keys must not red-fail — the deterministic gate logic is covered
 * by memory-ab.test.ts). With keys, exits 1 if the gate fails.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { generateCode, hasAnyTextProviderKey } from '@/lib/generation/generate'
import type { SceneType } from '@/lib/types'
import { judgeCodeValidity } from './judges/code-validity'
import { judgeWithLlm } from './judges/llm-judge'
import { buildAbGateReport, type AbCaseResult, type MemoryKind, type VariantScore } from './memory-ab'

interface AbSuiteCase {
  id: string
  prompt: string
  sceneType: SceneType
  kind: MemoryKind
  /** The learned preference line, e.g. "[style] preferred_palette: warm tones". */
  memory: string
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

function buildScene(sceneType: SceneType, code: string) {
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

/**
 * Inject a memory the way context-builder does: as an active-default block the
 * generation must follow unless the request contradicts it. generateCode has no
 * memory param, so we prepend the same contract to the prompt — exercising the
 * end-to-end "a learned pref shapes output" path.
 */
function withMemoryPrompt(prompt: string, memory: string): string {
  return [
    `## Learned User Preference — apply by default`,
    `Follow this preference unless this request contradicts it: ${memory}`,
    ``,
    prompt,
  ].join('\n')
}

async function scoreVariant(
  sceneType: SceneType,
  prompt: string,
  model: string,
  useLlmJudge: boolean,
): Promise<VariantScore> {
  let code = ''
  try {
    const res = await generateCode(sceneType, prompt, { modelId: model })
    code = res.code
  } catch {
    return { valid: false, llmScore: null }
  }
  const validity = judgeCodeValidity(buildScene(sceneType, code))
  let llmScore: number | null = null
  if (useLlmJudge) {
    const j = await judgeWithLlm({ prompt, sceneType, generatedCode: code })
    llmScore = j.score
  }
  return { valid: validity.passed, llmScore }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const model = (args.model as string) || 'claude-haiku-4-5-20251001'
  const useLlmJudge = !args['no-judge']

  if (!hasAnyTextProviderKey()) {
    console.error('[memory-ab] SKIP — no text provider key configured (gate logic covered by memory-ab.test.ts)')
    process.exit(0)
  }

  const here = fileURLToPath(new URL('.', import.meta.url))
  const raw = readFileSync(join(here, 'suites', 'memory-ab.jsonl'), 'utf-8')
  const cases = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AbSuiteCase)

  console.error(`[memory-ab] model=${model} cases=${cases.length} judge=${useLlmJudge}`)

  const results: AbCaseResult[] = []
  for (const c of cases) {
    process.stderr.write(`[memory-ab] ${c.id} (${c.kind})... `)
    const baseline = await scoreVariant(c.sceneType, c.prompt, model, useLlmJudge)
    const withMemory = await scoreVariant(c.sceneType, withMemoryPrompt(c.prompt, c.memory), model, useLlmJudge)
    results.push({ id: c.id, kind: c.kind, baseline, withMemory })
    process.stderr.write(
      `base(valid=${baseline.valid},llm=${baseline.llmScore ?? '-'}) ` +
        `mem(valid=${withMemory.valid},llm=${withMemory.llmScore ?? '-'})\n`,
    )
  }

  const report = buildAbGateReport(results)
  for (const v of report.verdicts) {
    console.log(`${v.ok ? 'OK ' : 'XX '} [${v.kind}] ${v.id}: ${v.detail}`)
  }
  console.log(`\n[memory-ab] gate ${report.passed ? 'PASSED' : 'FAILED'}`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((e) => {
  console.error('[memory-ab] fatal:', e)
  process.exit(2)
})
