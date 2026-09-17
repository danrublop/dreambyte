import type { IpcMain } from 'electron'
import {
  generateCanvas,
  generateMotion,
  generateThree,
  generateReact,
  generateLottie,
  generateD3,
  generateImageAsset,
  generateSvg,
  enhancePrompt,
  summarizeScene,
  editSvg,
  pollHeygenStatus,
  pollVideoStatus,
  startHeygenAvatar,
  startVideo,
  GenerationValidationError,
} from '@/lib/services/generation'
import { generateLipsyncAsset } from '@/lib/services/lipsync'
import { IpcValidationError } from './_helpers'

/**
 * Category: generate
 *
 * Thin IPC wrappers around the generation services: one method per scene
 * type plus image / video / avatar / lipsync generation, status pollers, and
 * prompt enhance / summarize / SVG edit helpers.
 */

/** Strip long tokens + cap length so an
 *  accidental API-key leak or stack-trace noise doesn't reach the renderer. */
function sanitize(message: string): string {
  return message.replace(/[a-zA-Z0-9_\-]{20,}/g, '[REDACTED]').slice(0, 200)
}

function wrap<T extends (input: never) => unknown>(fn: T) {
  return async (_e: unknown, args: Parameters<T>[0]) => {
    try {
      return await fn(args)
    } catch (err) {
      if (err instanceof GenerationValidationError) throw new IpcValidationError(err.message)
      // Scrub before rethrowing — same defense the HTTP routes apply. Without
      // this, provider SDK errors propagate raw to the renderer console.
      // Note: attached properties (e.g. `LottieParseError.usage`) don't
      // survive IPC — Electron only transports `error.message`. Callers
      // that need partial usage data on failure use the HTTP path.
      if (err instanceof Error) throw new Error(sanitize(err.message))
      throw err
    }
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:generate.canvas', wrap(generateCanvas))
  ipcMain.handle('dreambyte:generate.motion', wrap(generateMotion))
  ipcMain.handle('dreambyte:generate.three', wrap(generateThree))
  ipcMain.handle('dreambyte:generate.react', wrap(generateReact))
  ipcMain.handle('dreambyte:generate.lottie', wrap(generateLottie))
  ipcMain.handle('dreambyte:generate.d3', wrap(generateD3))
  // Force skipPermissionGate:false at the IPC boundary — the renderer must NEVER bypass the
  // project-row spend gate. Only the in-process agent tool handler (which runs its own permission
  // UX) is allowed to set that flag, and it does not go through these IPC channels.
  // `approvedAsk` (from ...args) IS allowed through: it only satisfies an always-ask prompt the
  // user accepted in the modal and can never turn a 'deny' (cap/disabled) into a proceed.
  ipcMain.handle(
    'dreambyte:generate.image',
    wrap((args: Parameters<typeof generateImageAsset>[0]) =>
      generateImageAsset({ ...args, skipPermissionGate: false }),
    ),
  )
  ipcMain.handle('dreambyte:generate.avatar', wrap(startHeygenAvatar))
  ipcMain.handle(
    'dreambyte:generate.video',
    wrap((args: Parameters<typeof startVideo>[0]) => startVideo({ ...args, skipPermissionGate: false })),
  )
  // Lipsync (face + narration → talking video). The service gates falAvatar + TTS internally.
  ipcMain.handle(
    'dreambyte:generate.lipsync',
    wrap((args: Parameters<typeof generateLipsyncAsset>[0]) => generateLipsyncAsset(args)),
  )
  // Status pollers — same `wrap()` pattern. `pollHeygenStatus` takes a
  // single `videoId` string rather than an options object, which the
  // wrapper handles fine since `Parameters<T>[0]` is the concrete type.
  ipcMain.handle('dreambyte:generate.pollHeygen', wrap(pollHeygenStatus))
  ipcMain.handle('dreambyte:generate.pollVideo', wrap(pollVideoStatus))
  ipcMain.handle('dreambyte:generate.svg', wrap(generateSvg))
  ipcMain.handle('dreambyte:generate.enhancePrompt', wrap(enhancePrompt))
  ipcMain.handle('dreambyte:generate.summarize', wrap(summarizeScene))
  ipcMain.handle('dreambyte:generate.editSvg', wrap(editSvg))
}
