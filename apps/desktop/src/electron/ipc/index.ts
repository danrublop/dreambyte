import type { IpcMain } from 'electron'
import * as settings from './settings'
import * as branches from './branches'
import * as fork from './fork'
import * as conversations from './conversations'
import * as usage from './usage'
import * as generationLog from './generation-log'
import * as permissions from './permissions'
import * as rules from './rules'
import * as skills from './skills'
import * as projects from './projects'
import * as workspaces from './workspaces'
import * as publish from './publish'
import * as scene from './scene'
import * as media from './media'
import * as audio from './audio'
import * as generate from './generate'
import * as characters from './characters'
import * as agent from './agent'
import * as agents from './agents'
import * as tier2 from './tier2'
import * as actionLog from './action-log'
import * as git from './git'
import * as exportTier3 from './export-tier3'
import * as exportFcpxml from './export-fcpxml'
// NOTE: ./caption-burn is intentionally NOT registered here — its handler is
// a write-authorization-gated primitive, registered inside main.ts setupIpc where the
// private isWriteAuthorized allowlist closure lives (see caption-burn.ts).
import * as sceneErrors from './scene-errors'
import * as undoStacks from './undo-stacks'
import { registerDubRuntime } from '../dub-runtime'

/**
 * Central IPC registration. Each category module exports
 * `register(ipcMain)` and adds its own `ipcMain.handle()` entries.
 * Called once from `src/electron/main.ts` inside `app.whenReady()` after
 * the `dreambyte://` protocol handler is registered.
 *
 * Channel naming convention: `dreambyte:<category>.<method>` (dot-separated).
 * Stays under a single top-level prefix so renderer-side code is guarded
 * by one global trust boundary.
 */
export function registerAllIpc(ipcMain: IpcMain): void {
  settings.register(ipcMain)
  branches.register(ipcMain)
  fork.register(ipcMain)
  conversations.register(ipcMain)
  usage.register(ipcMain)
  generationLog.register(ipcMain)
  permissions.register(ipcMain)
  rules.register(ipcMain)
  skills.register(ipcMain)
  projects.register(ipcMain)
  workspaces.register(ipcMain)
  publish.register(ipcMain)
  scene.register(ipcMain)
  media.register(ipcMain)
  audio.register(ipcMain)
  generate.register(ipcMain)
  characters.register(ipcMain)
  agent.register(ipcMain)
  agents.register(ipcMain)
  tier2.register(ipcMain)
  actionLog.register(ipcMain)
  git.register(ipcMain)
  exportTier3.register(ipcMain)
  exportFcpxml.register(ipcMain)
  sceneErrors.register(ipcMain)
  undoStacks.register(ipcMain)
  // Tier 3 dubbing: compose + register the dub runtime (ffmpeg + Whisper + TTS + relip) so the
  // dub_video agent tool activates (isDubRuntimeReady() → true). Not an IPC, but this is the central
  // main-process startup wiring.
  registerDubRuntime()
}
