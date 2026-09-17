/**
 * LIVE structural-floor eval — generates real scenes through the real
 * REACT_SYSTEM_PROMPT (the prompt carrying the camera-travel exemplar) and checks whether
 * the output clears the OBVIOUS-SLOP FLOOR: no slop + FLOW structure present (camera move,
 * big text, >1 beat). It tells you the model wrote camera-travel code instead of a static
 * slideshow. It does NOT judge whether the video is GOOD — that is a taste call only a human
 * makes (rate the saved scenes against RUBRIC.md). The floor exists to fail slideshows fast.
 *
 * Calls the model DIRECTLY with streaming + a generous timeout (the app's generateCode REST
 * path hardcodes a 60s non-streaming timeout that a full 8192-token react scene can't finish
 * within). NOT part of `vitest run` — real, paid LLM calls. Run explicitly:
 *   npm run eval:motion:live           # default model (claude-sonnet-4-6)
 *   EVAL_MODEL=claude-haiku-4-5 npm run eval:motion:live
 * Guarded on ANTHROPIC_API_KEY: with none it prints a skip and exits 0 (never breaks CI).
 *
 * Outputs: prints a table, writes each scene to .live-output/<slug>.txt for the human RUBRIC
 * rating, and writes live-result.json with the structural-floor pass-rate.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from 'dotenv'

config({ path: '.env' })
config({ path: '.env.local' })

const MODEL = process.env.EVAL_MODEL || 'claude-sonnet-4-6'
const REQUEST_TIMEOUT_MS = 240_000

const PROMPTS = [
  {
    slug: 'solana-speed',
    prompt:
      'Explain how Solana achieves fast transactions in one key idea. Premium motion-graphics explainer scene, ~8s.',
  },
  {
    slug: 'ai-water-hook',
    prompt: 'Hook scene for a video about the hidden water cost of AI video generation. Make the cost feel real.',
  },
  {
    slug: 'hash-function',
    prompt:
      'Intuitive explainer scene: what a hash function does (same input → same fixed output, tiny change → totally different).',
  },
]

const OUT_DIR = join(__dirname, '.live-output')

// Mirror generate.ts's react parse: the prompt asks for JSON {sceneCode, styles}; models
// sometimes fence it or return raw JSX. Extract sceneCode, falling back to the raw text.
function extractSceneCode(text: string): string {
  const stripped = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(stripped)
    if (parsed && typeof parsed.sceneCode === 'string') return parsed.sceneCode
  } catch {
    // not JSON — treat as raw sceneCode
  }
  return text
}

async function main() {
  const { REACT_SYSTEM_PROMPT } = await import('../../src/lib/generation/prompts')
  const { getAnthropicClient } = await import('../../src/lib/agents/providers')
  const { scanForSlop } = await import('../../src/lib/generation/slop-scan')
  const { scanForFlow } = await import('../../src/lib/generation/flow-scan')

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[live-eval] SKIP — no ANTHROPIC_API_KEY configured (.env). Not a failure.')
    process.exit(0)
  }

  const client = getAnthropicClient()
  const system = REACT_SYSTEM_PROMPT(['#f0ece0', '#e84545', '#4595e8', '#45e87a'], 'Inter', '#000000', 8, '', true)
  mkdirSync(OUT_DIR, { recursive: true })
  const rows: Array<{ slug: string; slop: number; flow: string[]; floorOk: boolean; len: number; err?: string }> = []

  for (const { slug, prompt } of PROMPTS) {
    process.stdout.write(`[live-eval] generating "${slug}" via ${MODEL}… `)
    try {
      const stream = client.messages.stream(
        {
          model: MODEL,
          max_tokens: 8192,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }],
        },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      const msg = await stream.finalMessage()
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
      const code = extractSceneCode(text)
      writeFileSync(join(OUT_DIR, `${slug}.txt`), code, 'utf8')
      const slop = scanForSlop(code)
      const flow = scanForFlow(code).warnings
      const floorOk = slop.length === 0 && flow.length === 0
      rows.push({ slug, slop: slop.length, flow, floorOk, len: code.length })
      console.log(floorOk ? 'FLOOR-OK' : 'FLAGGED')
    } catch (e) {
      const err = (e as Error).message
      rows.push({ slug, slop: 0, flow: [], floorOk: false, len: 0, err })
      console.log(`ERROR: ${err}`)
    }
  }

  const cleared = rows.filter((r) => r.floorOk).length
  const rate = rows.length ? Math.round((cleared / rows.length) * 100) : 0
  console.log('\n=== LIVE STRUCTURAL-FLOOR RESULTS (NOT a quality grade) ===')
  for (const r of rows) {
    const detail = r.err
      ? `error: ${r.err}`
      : `${r.len}b · slop:${r.slop} · flow-gaps:${r.flow.length}${r.flow.length ? ' (' + r.flow.map((w) => w.split(':')[1].trim().split(/[ ,—]/).slice(0, 4).join(' ')).join('; ') + ')' : ''}`
    console.log(`  ${r.floorOk ? 'FLOOR-OK' : 'FLAGGED '} ${r.slug.padEnd(16)} ${detail}`)
  }
  console.log(`\nLIVE structural-floor pass-rate: ${cleared}/${rows.length} (${rate}%) — a floor, NOT a quality score.`)
  console.log(`Scenes written to ${OUT_DIR}/ — the actual good/bad call is yours via RUBRIC.md.\n`)

  writeFileSync(
    join(__dirname, 'live-result.json'),
    JSON.stringify({ ts: new Date().toISOString(), model: MODEL, structuralFloorRate: rate, rows }, null, 2),
    'utf8',
  )
}

main().catch((e) => {
  console.error('[live-eval] fatal:', e)
  process.exit(1)
})
