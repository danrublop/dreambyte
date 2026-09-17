/**
 * Live smoke for the agent provider path.
 *
 * Drives a REAL provider through the exact production pipeline — adapter →
 * consumeAdapterStream → history reconstruction → toCanonicalMessages replay —
 * with a multi-turn tool loop. For DeepSeek this exercises the
 * reasoning_content replay live: turn 2 succeeding (no 400) IS the validation.
 *
 * Usage:
 *   npx tsx scripts/smoke/smoke-provider-parity.ts claude
 *   npx tsx scripts/smoke/smoke-provider-parity.ts deepseek-flash
 *   npx tsx scripts/smoke/smoke-provider-parity.ts deepseek-pro
 *   npx tsx scripts/smoke/smoke-provider-parity.ts deepseek-flash-nothink   (kill switch)
 *
 * Keys come from .env / .env.local (parsed below — tsx doesn't auto-load them).
 * Costs: a few cents per run.
 */

// ── env loading (tsx doesn't read .env) — same pattern as scripts/db/migrate.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: false })
dotenv.config({ path: '.env', override: false })

import { getAdapter } from '../../src/lib/agents/providers/index'
import { consumeAdapterStream } from '../../src/lib/agents/adapter-stream-consumer'
import { toCanonicalMessages } from '../../src/lib/agents/canonical-messages'
import type { ClaudeToolDefinition } from '../../src/lib/agents/types'

const VARIANTS: Record<string, { provider: 'anthropic' | 'deepseek'; model: string; thinking?: 'enabled' | 'disabled' }> = {
  claude: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'deepseek-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
  'deepseek-pro': { provider: 'deepseek', model: 'deepseek-v4-pro' },
  'deepseek-flash-nothink': { provider: 'deepseek', model: 'deepseek-v4-flash', thinking: 'disabled' },
}

const TOOLS: ClaudeToolDefinition[] = [
  {
    name: 'get_brand_color',
    description: 'Returns the brand color hex for a named product surface.',
    input_schema: {
      type: 'object',
      properties: { surface: { type: 'string', description: 'e.g. "primary", "accent"' } },
      required: ['surface'],
    },
  },
  {
    name: 'get_video_duration',
    description: 'Returns the target duration in seconds for the current video project.',
    input_schema: { type: 'object', properties: {} },
  },
]

async function main() {
  const variantName = process.argv[2] ?? 'claude'
  const v = VARIANTS[variantName]
  if (!v) {
    console.error(`Unknown variant "${variantName}". One of: ${Object.keys(VARIANTS).join(', ')}`)
    process.exit(1)
  }
  const keyVar = v.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY'
  if (!process.env[keyVar]) {
    console.error(`✗ ${keyVar} not set (checked env, .env, .env.local)`)
    process.exit(2)
  }
  const adapter = getAdapter(v.provider)
  if (!adapter) {
    console.error(`✗ no adapter registered for ${v.provider}`)
    process.exit(2)
  }

  console.log(`── smoke: ${variantName} (${v.model}) ──`)

  // Anthropic-format history, exactly like the runner keeps it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history: Array<{ role: 'user' | 'assistant'; content: any }> = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Use get_brand_color for the "primary" surface, then get_video_duration, then tell me both values in one short sentence. Call the tools one at a time.',
        },
      ],
    },
  ]

  const providerOverrides =
    v.provider === 'deepseek' ? { thinking: { type: v.thinking ?? 'enabled' } } : undefined

  let toolTurns = 0
  let thinkingChars = 0
  for (let turnNo = 1; turnNo <= 6; turnNo++) {
    const turn = await consumeAdapterStream(
      adapter,
      {
        model: v.model,
        systemPrompt: 'You are a terse assistant. Use the provided tools when asked.',
        messages: toCanonicalMessages(history as never),
        tools: TOOLS,
        maxTokens: 2048,
        ...(providerOverrides ? { providerOverrides } : {}),
      },
      () => {},
    )
    if (turn.error) {
      console.error(`✗ turn ${turnNo} FAILED: ${turn.error.message}`)
      process.exit(1)
    }
    thinkingChars += turn.thinking.length
    history.push({ role: 'assistant', content: turn.assistantContent })

    if (turn.stopReason === 'tool_use' && turn.toolUseBlocks.length > 0) {
      toolTurns++
      const results = turn.toolUseBlocks.map((t) => ({
        type: 'tool_result',
        tool_use_id: t.id,
        content: t.name === 'get_brand_color' ? '#FF5733' : '42',
      }))
      console.log(
        `  turn ${turnNo}: tool_use → ${turn.toolUseBlocks.map((t) => t.name).join(', ')}` +
          (turn.thinking ? ` (thinking: ${turn.thinking.length} chars)` : ''),
      )
      history.push({ role: 'user', content: results })
      continue
    }

    console.log(`  turn ${turnNo}: final answer: ${turn.text.slice(0, 120).replace(/\n/g, ' ')}`)
    const ok = turn.text.includes('FF5733') && /42/.test(turn.text)
    console.log(`  tool turns: ${toolTurns}, thinking chars: ${thinkingChars}`)
    if (toolTurns < 1) {
      console.error('✗ model never called a tool — tool loop NOT validated')
      process.exit(1)
    }
    if (!ok) {
      console.error('✗ final answer missing tool results — replay/context suspect')
      process.exit(1)
    }
    console.log(`✓ ${variantName} PASSED (${toolTurns} tool turn(s) survived — replay validated live)`)
    process.exit(0)
  }
  console.error('✗ never reached a final answer in 6 turns')
  process.exit(1)
}

main().catch((e) => {
  console.error('✗ smoke crashed:', e?.message ?? e)
  process.exit(1)
})
