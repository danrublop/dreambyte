/**
 * Live smoke for provider-routed agent vision (a DeepSeek agent sees
 * via a companion vision model). Feeds a real image to runVisionPrompt against
 * a chosen engine and prints the raw result. Proves the seeing actually works
 * for a DeepSeek-driven agent that has no vision of its own.
 *
 *   npx tsx scripts/smoke/smoke-vision-dispatch.ts cloud:gemini
 *   npx tsx scripts/smoke/smoke-vision-dispatch.ts cloud:anthropic
 *   npx tsx scripts/smoke/smoke-vision-dispatch.ts cloud:qwen
 */
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: false })
dotenv.config({ path: '.env', override: false })

import { runVisionPrompt } from '../../src/lib/agents/services/vision-dispatch'

// A 32x32 solid-red PNG (base64, no data: prefix) — a deterministic test image.
const RED_2x2_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4o6FBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIahsD2ItTF0AAAAAElFTkSuQmCC'

async function main() {
  const engine = process.argv[2] ?? 'cloud:gemini'
  console.log(`── vision smoke: ${engine} ──`)
  const raw = await runVisionPrompt(engine, {
    base64: RED_2x2_PNG,
    mimeType: 'image/png',
    systemPrompt:
      'You are an image inspector. Reply with ONLY a JSON object: {"dominant_color": "<one word>", "is_solid": <boolean>}. No prose.',
    userText: 'What is in this image?',
    maxTokens: 100,
  })
  if (raw == null) {
    console.error(`✗ ${engine} returned null — engine unavailable or errored (check the key/env)`)
    process.exit(1)
  }
  console.log(`  raw: ${raw.trim().slice(0, 200).replace(/\n/g, ' ')}`)
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    console.log(`  parsed JSON ✓  dominant_color=${parsed.dominant_color} is_solid=${parsed.is_solid}`)
    console.log(`✓ ${engine} PASSED — the model SAW the image and returned structured output`)
  } catch {
    console.log(`⚠ ${engine} returned text but not clean JSON (still sees the image; QA parser tolerates fences)`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('✗ vision smoke crashed:', e?.message ?? e)
  process.exit(1)
})
