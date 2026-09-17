/**
 * Validates that expected environment variables are present before `next dev`
 * or `next build`. Run via `npm run dev` wrapper or CI step.
 *
 * Intent:
 * - Surface misconfiguration immediately instead of letting the first API call
 *   fail cryptically.
 * - Treat keys as optional-but-warned unless marked REQUIRED.
 *
 * Exit codes:
 *   0 — all required present
 *   1 — one or more required missing (also when run with --strict and any warning hits)
 */

// Mirror Next.js env loading order so `predev`/`prebuild` hooks see the same
// values `next` will see. Without this the script runs before Next auto-loads
// `.env.local`, so required keys look missing even when they're set.
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import path from 'node:path'

for (const name of ['.env.local', '.env']) {
  const abs = path.resolve(process.cwd(), name)
  if (existsSync(abs)) loadDotenv({ path: abs, override: false })
}

type EnvCheck = {
  key: string
  required: boolean
  purpose: string
  link?: string
}

const CHECKS: EnvCheck[] = [
  {
    key: 'DATABASE_URL',
    required: true,
    purpose: 'SQLite URL for web-only renderer dev, e.g. file:./dev.db (the desktop app sets its own).',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    required: false,
    purpose: 'Claude API access for in-app agent (director + scene orchestration).',
    link: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'FAL_KEY',
    required: false,
    purpose: 'FAL image generation (Flux, SDXL, LoRA).',
    link: 'https://fal.ai/dashboard/keys',
  },
  {
    key: 'HEYGEN_API_KEY',
    required: false,
    purpose: 'HeyGen avatar video generation.',
    link: 'https://app.heygen.com/settings/api',
  },
  {
    key: 'GOOGLE_AI_KEY',
    required: false,
    purpose: 'Gemini / Veo3 access.',
    link: 'https://aistudio.google.com/app/apikey',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    required: false,
    purpose: 'ElevenLabs TTS (narration + voice cloning).',
    link: 'https://elevenlabs.io/app/settings/api-keys',
  },
]

const strict = process.argv.includes('--strict')
const missing: EnvCheck[] = []
const warnings: EnvCheck[] = []

// Renderer-only static export (BUILD_MODE=desktop) doesn't need DATABASE_URL —
// the bundle is pure client JS, and the runtime DB connection is provisioned
// later by the user via in-app onboarding. Skipping the check here lets the
// Electron build run on a clean machine without a Postgres instance.
const skipDbCheck = process.env.SKIP_DB_ENV_CHECK === '1' || process.env.BUILD_MODE === 'desktop'

for (const c of CHECKS) {
  if (skipDbCheck && c.key === 'DATABASE_URL') continue
  const val = process.env[c.key]
  if (!val || val.trim() === '') {
    if (c.required) missing.push(c)
    else warnings.push(c)
  }
}

function formatRow(c: EnvCheck, tag: string): string {
  const link = c.link ? `\n    → ${c.link}` : ''
  return `  [${tag}] ${c.key}\n    ${c.purpose}${link}`
}

if (missing.length > 0) {
  console.error('\nEnvironment validation failed. Missing REQUIRED variables:\n')
  for (const c of missing) console.error(formatRow(c, 'MISSING'))
  console.error('\nCopy .env.example to .env.local and fill in values.\n')
}

if (warnings.length > 0) {
  console.warn('\nOptional keys not set (features using them will prompt the user at call time):\n')
  for (const c of warnings) console.warn(formatRow(c, 'warn'))
  console.warn('')
}

if (missing.length > 0 || (strict && warnings.length > 0)) {
  process.exit(1)
}

console.log('Environment check passed.')
