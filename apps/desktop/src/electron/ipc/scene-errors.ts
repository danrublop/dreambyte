/**
 * Scene playback error reporting IPC.
 *
 * The in-scene error beacon (src/lib/agents/error-capture-shared.ts) posts
 * runtime errors to the preview host (renderer); the host forwards them here.
 * The ring buffer lives in the MAIN process because the agent runs in main —
 * verify_scene reports and the runner's context refresh read it in-process,
 * no IPC round-trip on the read side.
 *
 * Validation: the payload crosses the renderer→main trust boundary — shape
 * is re-checked here (a compromised/buggy renderer must not poison the
 * buffer with non-string garbage that later lands in agent prompts).
 */

import type { IpcMain } from 'electron'
import { recordSceneError } from '../../lib/agents/scene-error-buffer'
import type { SceneRuntimeError } from '../../lib/agents/error-capture-shared'

// Same charset as the writer in ./scene.ts (incl. underscore) — a scene id the
// writer accepts must not have its error reports silently dropped here.
const SCENE_ID_RE = /^[a-zA-Z0-9_-]+$/
const KINDS = new Set(['syntax', 'runtime', 'rejection', 'jsx'])
const MAX_MESSAGE_CHARS = 500

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:sceneErrors.report', (_event, payload: { sceneId?: unknown; error?: unknown }) => {
    const sceneId = typeof payload?.sceneId === 'string' ? payload.sceneId : ''
    if (!SCENE_ID_RE.test(sceneId)) return { ok: false }
    const raw = (payload?.error ?? {}) as Partial<SceneRuntimeError>
    if (typeof raw.message !== 'string' || raw.message.length === 0) return { ok: false }
    const error: SceneRuntimeError = {
      kind: KINDS.has(raw.kind as string) ? (raw.kind as SceneRuntimeError['kind']) : 'runtime',
      message: raw.message.slice(0, MAX_MESSAGE_CHARS),
      line: typeof raw.line === 'number' ? raw.line : undefined,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 200) : undefined,
      at: typeof raw.at === 'number' ? raw.at : Date.now(),
    }
    recordSceneError(sceneId, error)
    return { ok: true }
  })
}
