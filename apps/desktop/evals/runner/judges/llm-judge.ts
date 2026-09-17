/**
 * LLM-as-judge: scores scene-codegen output 0-10 on (correctness, style,
 * efficiency) using Claude Sonnet. Stub for v1 — returns null + a reason
 * when ANTHROPIC_API_KEY is missing so the harness still runs end-to-end
 * with just the code-validity judge.
 *
 * Run with `temperature: 0` and 3 samples (median wins) to dampen judge
 * variance. For now we run once; sampling is a follow-up.
 */

import { getAnthropicClient } from '@/lib/agents/providers'

export interface LlmJudgeResult {
  /** 0-10, or null if the judge couldn't run (no key, parse failure, etc.) */
  score: number | null
  /** One-paragraph rationale from the judge. */
  rationale: string
  /** Sub-scores for each axis when the judge produces them. */
  axes?: { correctness: number; style: number; efficiency: number }
  /** Why the judge returned null, if applicable. */
  skippedReason?: string
}

export interface LlmJudgeInput {
  prompt: string
  sceneType: string
  generatedCode: string
  /** Optional reference output to compare against. */
  reference?: string
}

const JUDGE_MODEL = 'claude-sonnet-4-6'

const JUDGE_SYSTEM_PROMPT = `You are a senior animation engineer reviewing AI-generated scene code for an explainer-video editor (Dreambyte).

Score the candidate code 0-10 on three axes:
- correctness: does it implement what the prompt asked for, with no syntax/runtime errors?
- style: is it clean, idiomatic for its scene type (svg/react/canvas2d/d3/three/motion), and free of obvious anti-patterns?
- efficiency: does it avoid unnecessary work, runaway loops, or DOM thrash?

Return ONLY valid JSON with this exact shape, no prose:
{
  "correctness": <0-10>,
  "style": <0-10>,
  "efficiency": <0-10>,
  "overall": <0-10>,
  "rationale": "<one paragraph, max 3 sentences>"
}`

export async function judgeWithLlm(input: LlmJudgeInput): Promise<LlmJudgeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { score: null, rationale: '', skippedReason: 'ANTHROPIC_API_KEY not set' }
  }

  const userMessage = `PROMPT: ${input.prompt}
SCENE TYPE: ${input.sceneType}

CANDIDATE CODE:
\`\`\`
${input.generatedCode.slice(0, 12_000)}
\`\`\`
${input.reference ? `\nREFERENCE (accepted prior output for similar prompt):\n\`\`\`\n${input.reference.slice(0, 8_000)}\n\`\`\`\n` : ''}
Return JSON only.`

  let raw = ''
  try {
    const client = getAnthropicClient()
    const result = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
    const block = result.content.find((b) => b.type === 'text')
    raw = block?.type === 'text' ? block.text : ''
  } catch (e) {
    return { score: null, rationale: '', skippedReason: `judge call failed: ${(e as Error).message}` }
  }

  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  let parsed: { correctness?: number; style?: number; efficiency?: number; overall?: number; rationale?: string }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return {
      score: null,
      rationale: '',
      skippedReason: `judge returned non-JSON: ${cleaned.slice(0, 100)}`,
    }
  }

  const score = typeof parsed.overall === 'number' ? parsed.overall : null
  return {
    score,
    rationale: parsed.rationale ?? '',
    axes:
      typeof parsed.correctness === 'number' &&
      typeof parsed.style === 'number' &&
      typeof parsed.efficiency === 'number'
        ? {
            correctness: parsed.correctness,
            style: parsed.style,
            efficiency: parsed.efficiency,
          }
        : undefined,
  }
}
