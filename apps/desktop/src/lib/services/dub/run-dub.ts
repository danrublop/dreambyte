// Dub runtime seam. dubVideo() needs heavy deps that live in different places: ffmpeg
// (extractAudio/assembleAudio) and Whisper (transcribe) are Electron-MAIN only; translate/synthesize/
// relip are node-side. The desktop runtime composes the full DubVideoDeps and registers it here at
// startup via setDubRuntime(); the agent tool calls runDubJob() which uses it. Keeping the wiring
// behind this seam means the tool + handler are unit-testable now and the main-process ffmpeg/Whisper
// implementation can land + be verified separately (it can only be exercised with the app running).

import { dubVideo, DubError, type DubVideoDeps, type DubVideoInput, type DubVideoResult } from './dub-video'

let _runtime: DubVideoDeps | null = null

/** Called once by the Electron main process at startup with the composed real deps (ffmpeg + Whisper
 *  + translate-over-adapter + TTS + fal relip). */
export function setDubRuntime(deps: DubVideoDeps): void {
  _runtime = deps
}

/** Test-only: clear the registered runtime. */
export function __resetDubRuntimeForTesting(): void {
  _runtime = null
}

/** True when the dub runtime is wired — gate the dub_video tool on this so the agent isn't offered a
 *  tool it can't execute. */
export function isDubRuntimeReady(): boolean {
  return _runtime !== null
}

/** Run a dub job through the registered runtime. Fail-loud with a clear message when the runtime
 *  isn't wired (a non-desktop build, or before the main-process deps land). */
export async function runDubJob(input: DubVideoInput): Promise<DubVideoResult> {
  if (!_runtime) {
    throw new DubError('Video dubbing requires the desktop runtime (ffmpeg + Whisper) — not wired in this build yet.')
  }
  return dubVideo(input, _runtime)
}
