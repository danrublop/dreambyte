import type { IpcMain } from 'electron'
import fsSync from 'node:fs'

import { getProjectDataDir } from '../paths'
import { appendActionRow } from '@/lib/db/queries/action-log'
import { walPath } from '@/lib/actions/wal'
import type { Action } from '@/lib/actions'
import { recordDispatchedAction } from '@/lib/actions/snapshot-orchestrator'
import { assertValidUuid, IpcValidationError } from './_helpers'
import { createLogger } from '@/lib/logger'

const log = createLogger('ipc/actionLog')

/**
 * Action layer IPC bridge.
 *
 * The renderer dispatches actions through `src/lib/store/action-dispatch.ts`,
 * which applies them to Zustand synchronously. Persistence — WAL append +
 * DB row — happens here, fire-and-forget from the renderer's POV. Locked
 * decisions #5 + #6: WAL is sync to disk before the row lands in
 * action_log; both are projections of the same `Action` payload.
 *
 * Channels:
 *   dreambyte:actionLog.append  — durable record of one action
 */

interface AppendArgs {
  projectId: string
  branchId?: string | null
  action: Action
}

// M1 — closed set of legitimate sources. Locking this at the IPC boundary
// stops a compromised renderer or a hostile Tier-2 git import from
// spoofing attribution ("forged by user", "synthesized by migration").
const VALID_SOURCES = new Set(['user', 'agent', 'replay', 'migration'])

// M1 — defense-in-depth: any field that later becomes a media src (clip
// sourceId, layer asset url) must NOT use script-executing schemes. The
// dreambyte:// protocol handler already path-contains, but if a future code
// path bypasses the handler it still can't load javascript:.
function rejectDangerousScheme(value: unknown, where: string): void {
  if (typeof value !== 'string') return
  if (/^\s*(javascript|data|file|vbscript):/i.test(value)) {
    throw new IpcValidationError(`${where} uses disallowed scheme`)
  }
}

function ensureValidAction(a: Action): void {
  if (!a || typeof a !== 'object') throw new IpcValidationError('action must be an object')
  if (typeof a.id !== 'string' || a.id.length === 0) {
    throw new IpcValidationError('action.id required')
  }
  if (typeof a.type !== 'string' || a.type.length === 0) {
    throw new IpcValidationError('action.type required')
  }
  if (typeof a.timestamp !== 'number' || !Number.isFinite(a.timestamp)) {
    throw new IpcValidationError('action.timestamp must be a finite number')
  }
  if (typeof a.source !== 'string' || !VALID_SOURCES.has(a.source)) {
    throw new IpcValidationError(`action.source must be one of ${[...VALID_SOURCES].join(',')}`)
  }

  // Per-type scheme guards on any field that becomes a media src downstream.
  // Coverage: clip.sourceId (video/audio clips on timeline), audioLayer.src
  // and its TTS/music sub-tracks (played back as <audio src>),
  // and AILayer.publicUrl-like fields (rendered into scene HTML).
  const params = (a.params ?? {}) as unknown as Record<string, unknown>
  if (a.type === 'clip/add') {
    const clip = params.clip as Record<string, unknown> | undefined
    rejectDangerousScheme(clip?.sourceId, 'action.params.clip.sourceId')
  } else if (a.type === 'audio/setLayer') {
    const patch = params.patch as Record<string, unknown> | undefined
    if (patch) {
      rejectDangerousScheme(patch.src, 'action.params.patch.src')
      const tts = patch.tts as Record<string, unknown> | null | undefined
      if (tts) rejectDangerousScheme(tts.src, 'action.params.patch.tts.src')
      const music = patch.music as Record<string, unknown> | null | undefined
      if (music) rejectDangerousScheme(music.src, 'action.params.patch.music.src')
      const sfx = patch.sfx as Array<Record<string, unknown>> | undefined
      if (Array.isArray(sfx)) {
        sfx.forEach((s, i) => rejectDangerousScheme(s?.src, `action.params.patch.sfx[${i}].src`))
      }
    }
  } else if (a.type === 'layer/add') {
    const layer = params.layer as Record<string, unknown> | undefined
    if (layer) {
      // AILayer union (Avatar/Veo3/Image/Sticker) — check common src-like fields.
      rejectDangerousScheme(layer.src, 'action.params.layer.src')
      rejectDangerousScheme(layer.publicUrl, 'action.params.layer.publicUrl')
      rejectDangerousScheme(layer.videoUrl, 'action.params.layer.videoUrl')
    }
  }
}

async function append(args: AppendArgs): Promise<{ success: true; written: { wal: boolean; db: boolean } }> {
  assertValidUuid(args.projectId, 'projectId')
  ensureValidAction(args.action)

  const projectDir = getProjectDataDir(args.projectId)
  let walOk = false
  try {
    fsSync.mkdirSync(projectDir, { recursive: true })
    fsSync.appendFileSync(walPath({ projectDir }), JSON.stringify(args.action) + '\n', { encoding: 'utf-8' })
    walOk = true
  } catch (err) {
    log.error('WAL append failed; continuing to DB write so we don\'t silently lose the action', {
      extra: { projectId: args.projectId, actionId: args.action.id },
      error: err,
    })
  }

  let dbOk = false
  try {
    await appendActionRow(args.projectId, args.action, args.branchId ?? null)
    dbOk = true
  } catch (err) {
    log.error('action_log append failed', {
      extra: { projectId: args.projectId, actionId: args.action.id },
      error: err,
    })
  }

  if (dbOk) {
    recordDispatchedAction({
      projectId: args.projectId,
      branchId: args.branchId ?? null,
      actionId: args.action.id,
    })
  }

  return { success: true, written: { wal: walOk, db: dbOk } }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:actionLog.append', (_e, args: AppendArgs) => append(args))
}
