import type { IpcMain } from 'electron'
import {
  searchSFX,
  listVoices,
  AudioValidationError,
} from '@/lib/services/audio'
import {
  generateNarrationGated,
  generateSfxGated,
  generateMusicGated,
  type NarrationGenInput,
  type SfxGenInput,
  type MusicGenInputGated,
} from '@/lib/services/audio-gen'
import { IpcValidationError } from './_helpers'

/**
 * Category: tts / sfx / music
 *
 * Thin IPC wrappers around the audio services in `src/lib/services/audio.ts`.
 * The same service functions power the HTTP routes (thin Next wrappers)
 * and the agent tool handlers in `src/lib/agents/tool-handlers/audio-tools.ts`
 * (direct calls — no fetch).
 *
 * AudioValidationError bubbles up as an IpcValidationError so the
 * renderer can distinguish input errors from server failures the
 * same way it did over HTTP 400 vs 500.
 */

function rethrowValidation<T extends (...a: never[]) => unknown>(fn: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (err instanceof AudioValidationError) throw new IpcValidationError(err.message)
      throw err
    }
  }) as T
}

export function register(ipcMain: IpcMain): void {
  // TTS now routes through the gated wrapper (spend gate + ledger). The bare synthesizeTTS is
  // still used directly by the agent path + avatar prerender; this IPC is the in-app user path.
  ipcMain.handle(
    'dreambyte:tts.synthesize',
    rethrowValidation((_e, args: NarrationGenInput) => generateNarrationGated(args)),
  )
  ipcMain.handle(
    'dreambyte:sfx.search',
    rethrowValidation((_e, args: Parameters<typeof searchSFX>[0]) => searchSFX(args)),
  )
  // Prompt -> generate a sound effect (gated). Distinct from sfx.search (library lookup).
  ipcMain.handle(
    'dreambyte:sfx.generate',
    rethrowValidation((_e, args: SfxGenInput) => generateSfxGated(args)),
  )
  // Prompt -> generate background music (gated).
  ipcMain.handle(
    'dreambyte:music.generate',
    rethrowValidation((_e, args: MusicGenInputGated) => generateMusicGated(args)),
  )
  ipcMain.handle(
    'dreambyte:tts.listVoices',
    rethrowValidation((_e, provider: Parameters<typeof listVoices>[0]) => listVoices(provider)),
  )
  // Tier 3 Cast: record biometric voice-clone consent for (project, destination). Invoked when the
  // user approves the in-chat consent card; the resumed clone_voice run then finds this consent and
  // proceeds. Stamps consentAt server-side (never trust a client timestamp).
  ipcMain.handle(
    'dreambyte:tts.recordVoiceConsent',
    rethrowValidation(async (_e, args: { projectId: string; destination: string; version: string }) => {
      const { recordProjectVoiceConsent } = await import('@/lib/db/queries/cloned-voices')
      await recordProjectVoiceConsent({
        projectId: args.projectId,
        destination: args.destination,
        version: args.version,
        consentAt: new Date(),
      })
      return { ok: true }
    }),
  )
}
