/**
 * BYOK keyring for the packaged desktop app.
 *
 * Stores provider API keys encrypted via Electron `safeStorage` (OS keychain on
 * macOS / DPAPI on Windows / kwallet / gnome-keyring / basic-text on Linux) and
 * hydrates them into `process.env` on boot and on every write. Without this the
 * renderer has no way to push user-entered keys down to the main-process agent
 * runner (which reads `process.env.ANTHROPIC_API_KEY` etc. at client-init).
 *
 * File layout, at `<userData>/dreambyte-keys.json`:
 *   {
 *     "ANTHROPIC_API_KEY": "<safeStorage-encrypted base64 of the plaintext key>",
 *     "OPENAI_API_KEY":    "<…>",
 *     ...
 *   }
 *
 * `dreambyte.env` (plaintext dotenv, loaded by `src/electron/main.ts::loadEnvFiles`)
 * remains supported as an opt-in power-user path — operators can drop a file
 * in and skip the UI entirely. Values from `dreambyte-keys.json` override, so the
 * UI always wins if both are set.
 */

import path from 'path'
import fs from 'fs'
import { app, safeStorage } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('electron.provider-keys')

/** Providers the Settings UI can write keys for. */
export type ProviderKeyId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'fal'
  | 'heygen'
  | 'elevenlabs'
  | 'runway'
  | 'freesound'
  | 'pixabay'
  | 'google-tts'
  | 'gemini'
  | 'local'
  // Phase 2.5 cheap OpenAI-compat vision providers
  | 'dashscope'
  | 'moonshot'
  | 'deepseek'
  // Deep-research search backends (base URLs / keys, not model providers)
  | 'searxng'
  | 'tavily'

/**
 * Canonical env-var name for each provider.
 *
 * Keep in sync with `src/components/settings/ModelsAndApiPanel.tsx::ENV_VAR_NAMES`
 * and every `process.env.*` read in `src/lib/agents/runner.ts`,
 * `src/lib/audio/providers/*`, `src/lib/media/**`. Adding a provider here is cheap;
 * missing one means the UI can save a key that never reaches the agent.
 */
export const PROVIDER_ENV_VARS: Record<ProviderKeyId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_KEY',
  gemini: 'GEMINI_API_KEY',
  fal: 'FAL_KEY',
  heygen: 'HEYGEN_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  runway: 'RUNWAY_API_KEY',
  freesound: 'FREESOUND_API_KEY',
  pixabay: 'PIXABAY_API_KEY',
  'google-tts': 'GOOGLE_TTS_API_KEY',
  // `local` is a base URL, not an API key. Handled separately via baseUrl field.
  local: 'OLLAMA_ENDPOINT',
  // Phase 2.5 cheap vision providers (OpenAI-compat). Env vars match
  // OPENAI_COMPAT_VISION_PROVIDERS[*].keyEnv in openai-compat-vision.ts.
  dashscope: 'DASHSCOPE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  // Deep-research search backends. searxng is a base URL (like `local`);
  // tavily is an API key. Both feed runWebSearch (src/lib/research/router.ts).
  searxng: 'SEARXNG_URL',
  tavily: 'TAVILY_API_KEY',
}

type KeyFile = Record<string, string>

function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'dreambyte-keys.json')
}

function readKeyFile(): KeyFile {
  const p = keyFilePath()
  if (!fs.existsSync(p)) return {}
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as KeyFile
  } catch (e) {
    log.warn('failed to read key file; starting empty', {
      extra: { path: p, message: (e as Error).message },
    })
    return {}
  }
}

function writeKeyFile(data: KeyFile): void {
  const p = keyFilePath()
  const tmp = `${p}.tmp`
  const payload = JSON.stringify(data, null, 2)
  fs.writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, p)
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // safeStorage falls back to a plaintext-ish store on Linux without
    // gnome-keyring/kwallet. Warn loudly so the user knows the risk but keep
    // going — a BYOK key that hits the agent is still more useful than a
    // broken Settings tab.
    log.warn('safeStorage encryption not available — storing keys obfuscated only')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(cipher: string): string | null {
  try {
    const buf = Buffer.from(cipher, 'base64')
    return safeStorage.decryptString(buf)
  } catch (e) {
    log.warn('failed to decrypt provider key (keychain may have been reset)', {
      extra: { message: (e as Error).message },
    })
    return null
  }
}

/**
 * Read every stored key, decrypt, and push into `process.env`. Called once
 * from `src/electron/main.ts` right after `loadEnvFiles()` so the agent runner's
 * lazy clients see the user-supplied keys on first access.
 *
 * Keys already present in `process.env` (from `dreambyte.env` or the system
 * environment) are preserved — the dotenv `override: false` semantics. To
 * let the UI override, we write to env unconditionally; dotenv's own entries
 * were already consumed before this runs.
 */
export function hydrateEnvFromKeyring(): void {
  const data = readKeyFile()
  for (const [envVar, cipher] of Object.entries(data)) {
    if (!cipher || typeof cipher !== 'string') continue
    const plain = decrypt(cipher)
    if (plain === null) continue
    process.env[envVar] = plain
  }
}

/** Set or clear a provider key. Empty string / null deletes the entry. */
export function setProviderKey(provider: ProviderKeyId, value: string | null): void {
  const envVar = PROVIDER_ENV_VARS[provider]
  if (!envVar) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  const data = readKeyFile()
  if (!value || value.trim().length === 0) {
    delete data[envVar]
    delete process.env[envVar]
  } else {
    data[envVar] = encrypt(value.trim())
    process.env[envVar] = value.trim()
  }
  writeKeyFile(data)
}

/**
 * Status snapshot for the Settings UI. Never returns the plaintext — only
 * whether a key is present and a masked preview so the user can confirm
 * which key is saved without the renderer ever holding the decrypted value.
 */
export interface ProviderKeyStatus {
  provider: ProviderKeyId
  envVar: string
  hasKey: boolean
  maskedPreview: string | null
}

export function listProviderKeyStatus(): ProviderKeyStatus[] {
  const data = readKeyFile()
  return (Object.keys(PROVIDER_ENV_VARS) as ProviderKeyId[]).map((provider) => {
    const envVar = PROVIDER_ENV_VARS[provider]
    const cipher = data[envVar]
    let maskedPreview: string | null = null
    let hasKey = false
    if (cipher) {
      const plain = decrypt(cipher)
      if (plain) {
        hasKey = true
        // sk-…abcd — leading prefix (up to 3 chars) + last 4. Never the middle.
        const lead = plain.slice(0, Math.min(3, Math.max(0, plain.length - 4)))
        const tail = plain.slice(-4)
        maskedPreview = `${lead}${'•'.repeat(Math.max(0, Math.min(12, plain.length - lead.length - tail.length)))}${tail}`
      }
    }
    // Also expose keys that arrived via dreambyte.env / system env even if the
    // keyring is empty, so the UI shows "configured" for power users who
    // skipped the settings flow.
    if (!hasKey && process.env[envVar]) {
      hasKey = true
      const plain = process.env[envVar] as string
      const lead = plain.slice(0, Math.min(3, Math.max(0, plain.length - 4)))
      const tail = plain.slice(-4)
      maskedPreview = `${lead}${'•'.repeat(Math.max(0, Math.min(12, plain.length - lead.length - tail.length)))}${tail}`
    }
    return { provider, envVar, hasKey, maskedPreview }
  })
}
