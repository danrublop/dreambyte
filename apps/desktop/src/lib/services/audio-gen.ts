/**
 * Gated audio generation.
 *
 * The in-app Generate composer routes Voice / SFX / Music sends through here. Each wrapper:
 *   1. resolves the provider's `apiName` via the audio-model directory,
 *   2. gates spend with the SHARED `gateMediaSpend` (same gate as image/video) — UNLESS the
 *      provider is free (`apiName === null`: browser web-speech / puter), in which case the
 *      gate is skipped entirely,
 *   3. calls the underlying audio service, and
 *   4. on success, commits an estimated cost to the spend ledger via `logSpend` (paid providers
 *      only) so the session/monthly caps actually accumulate for audio.
 *
 * The bare `tts.synthesize` IPC has no gate of its own.
 * The renderer IPC now routes through `generateNarrationGated`, so in-app TTS is gated like
 * image/video. The agent path calls the bare services + gates in its own tool handler — it does
 * not go through here. NOTE: avatar prerender (src/lib/audio/avatar-prerender.ts) ALSO calls the
 * `tts.synthesize` IPC, so it flows through this gate too — but it passes no projectId, so the
 * gate is a no-op for it (gateMediaSpend returns null without a projectId) and it gets a normal
 * TTSResult. If avatar prerender ever starts passing a projectId, it must handle the `{ error }`
 * (gate-denied) branch.
 *
 * 'deny' (cap exceeded / api disabled) returns `{ error }`; 'ask' proceeds (interactive in-app
 * approval is the same documented follow-up as image/video — see media-gate.ts).
 */

import type { TTSResult, SFXInput } from './audio'
import { audioModel, ttsApiNameFor } from '@/lib/audio/audio-models'
import type { APIName } from '@/lib/types/permissions'
import type { TTSProvider } from '@/lib/types'
import type { MediaPermissionNeeded } from './media-gate'

/** Gate outcome surfaced to callers: deny → { error }; ask → { permissionNeeded }; proceed → null. */
type GateBlock = { error: string } | { permissionNeeded: MediaPermissionNeeded } | null

export interface NarrationGenInput {
  projectId?: string
  text: string
  sceneId: string
  provider?: string
  voiceId?: string
  instructions?: string
  /** Re-dispatch flag set after the user approves the always-ask modal. */
  approvedAsk?: boolean
}

export interface SfxGenInput {
  projectId?: string
  prompt: string
  provider?: string
  duration?: number
  /** Re-dispatch flag set after the user approves the always-ask modal. */
  approvedAsk?: boolean
}

export interface MusicGenInputGated {
  projectId?: string
  prompt: string
  provider?: string
  duration?: number
  /** Custom MusicGen sidecar URL from Settings (audioSettings.musicgenUrl). Applied to
   *  process.env.MUSICGEN_URL before routing so the local provider hits the right host;
   *  unset → the provider's localhost:8090 default. */
  musicgenUrl?: string
  /** Re-dispatch flag set after the user approves the always-ask modal. */
  approvedAsk?: boolean
}

async function gate(
  projectId: string | undefined,
  apiName: APIName | null,
  prompt: string,
  model?: string,
  approvedAsk?: boolean,
): Promise<GateBlock> {
  // Free provider (apiName === null) → nothing to charge, skip the gate.
  if (!apiName) return null
  const { gateMediaSpend } = await import('./media-gate')
  const g = await gateMediaSpend(projectId, apiName, { prompt, model }, { surfaceAsk: true, approvedAsk })
  if (g && 'denied' in g) return { error: g.reason }
  if (g && 'ask' in g) return { permissionNeeded: g.permissionNeeded }
  return null
}

async function commitSpend(
  projectId: string | undefined,
  apiName: APIName | null,
  prompt: string,
  label: string,
): Promise<void> {
  if (!apiName || !projectId) return
  const { logSpend } = await import('@/lib/db')
  const { estimateApiCostUsd } = await import('@/lib/permissions')
  const cost = estimateApiCostUsd(apiName, { prompt })
  if (cost > 0 && Number.isFinite(cost)) {
    await logSpend(projectId, apiName, cost, label)
  }
}

/** Gated TTS. Returns the TTSResult on success, `{ error }` when denied, or `{ permissionNeeded }`
 *  when the project policy requires interactive approval (always-ask). */
export async function generateNarrationGated(
  input: NarrationGenInput,
): Promise<TTSResult | { error: string } | { permissionNeeded: MediaPermissionNeeded }> {
  // Resolve the EFFECTIVE provider BEFORE gating. A missing/'auto' provider must not be treated as
  // free: synthesizeTTS would resolve it via getBestTTSProvider, which can pick a PAID provider, so
  // gating on the unresolved (null) apiName would bypass the cap + ledger. Resolve here, gate +
  // synthesize on the SAME provider so the metered and billed providers can't drift.
  let provider = input.provider as TTSProvider | undefined
  if (!provider) {
    const { getBestTTSProvider } = await import('@/lib/audio/router')
    provider = getBestTTSProvider(null)
  }
  const apiName = ttsApiNameFor(provider)
  const block = await gate(input.projectId, apiName, input.text, provider, input.approvedAsk)
  if (block) return block

  const { synthesizeTTS } = await import('./audio')
  const result = await synthesizeTTS({
    text: input.text,
    sceneId: input.sceneId,
    voiceId: input.voiceId,
    provider,
    instructions: input.instructions,
  })
  await commitSpend(input.projectId, apiName, input.text, `${provider}: ${input.text.slice(0, 80)}`)
  return result
}

/** Gated SFX generation. Returns the SFX result, `{ error }`, or `{ permissionNeeded }`. */
export async function generateSfxGated(
  input: SfxGenInput,
): Promise<{ sfx: Record<string, unknown> } | { error: string } | { permissionNeeded: MediaPermissionNeeded }> {
  const providerId = input.provider ?? 'elevenlabs-sfx'
  const desc = audioModel(providerId)
  const apiName = desc?.apiName ?? null
  const block = await gate(input.projectId, apiName, input.prompt, providerId, input.approvedAsk)
  if (block) return block

  const { searchSFX } = await import('./audio')
  const args: SFXInput = { prompt: input.prompt, provider: providerId as SFXInput['provider'], limit: 1 }
  if (input.duration != null) args.duration = input.duration
  const data = await searchSFX(args)
  const result = data.results?.[0] as Record<string, unknown> | undefined
  if (!result) return { error: `No sound effect generated for: ${input.prompt}` }
  await commitSpend(input.projectId, apiName, input.prompt, `${providerId}: ${input.prompt.slice(0, 80)}`)
  return { sfx: result }
}

/** Gated music generation. Returns the music result, `{ error }`, or `{ permissionNeeded }`. */
export async function generateMusicGated(
  input: MusicGenInputGated,
): Promise<{ music: Record<string, unknown> } | { error: string } | { permissionNeeded: MediaPermissionNeeded }> {
  const providerId = input.provider ?? 'stable-audio'
  const desc = audioModel(providerId)
  const apiName = desc?.apiName ?? null
  const block = await gate(input.projectId, apiName, input.prompt, providerId, input.approvedAsk)
  if (block) return block

  // Custom sidecar URL from Settings → env, so the local provider hits the right host.
  if (input.musicgenUrl && input.musicgenUrl.trim()) process.env.MUSICGEN_URL = input.musicgenUrl.trim()

  // Local Composer: not a generate-provider — it's the template sequencer. Map the
  // free-text prompt to compose() params and render it directly ($0, no gate).
  if (providerId === 'native-sequencer') {
    const [{ composeMusicToFile }, { parseMusicPrompt }, { getAudioDir, audioUrlFor }, { computeCacheHash }, { join }] =
      await Promise.all([
        import('@/lib/audio/composer'),
        import('@/lib/audio/parse-music-prompt'),
        import('@/lib/audio/paths'),
        import('@/lib/apis/cache-hash'),
        import('node:path'),
      ])
    const params = parseMusicPrompt(input.prompt)
    if (typeof input.duration === 'number' && input.duration > 0) params.sceneDurationSec = input.duration
    const hash = computeCacheHash({ kind: 'composeMusicUi', ...params })
    const fileName = `music-composer-${hash}.wav`
    try {
      const r = await composeMusicToFile(params, {
        absPath: join(getAudioDir(), fileName),
        publicUrl: audioUrlFor(fileName),
      })
      return {
        music: {
          audioUrl: r.audioUrl,
          name: input.prompt.slice(0, 60),
          provider: 'native-sequencer',
          duration: r.durationSec,
        },
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Composer failed' }
    }
  }

  const { generateMusic } = await import('./audio')
  const data = await generateMusic({
    prompt: input.prompt,
    provider: providerId as Parameters<typeof generateMusic>[0]['provider'],
    duration: input.duration,
  })
  const result = data.result as Record<string, unknown> | undefined
  if (!result) return { error: `No music generated for: ${input.prompt}` }
  await commitSpend(input.projectId, apiName, input.prompt, `${providerId}: ${input.prompt.slice(0, 80)}`)
  return { music: result }
}
