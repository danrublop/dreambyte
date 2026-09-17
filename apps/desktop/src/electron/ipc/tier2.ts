import type { IpcMain } from 'electron'
import { dialog, shell } from 'electron'
import path from 'node:path'
import { db } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'
import { readProjectSceneBlob } from '@/lib/db/project-scene-storage'
import {
  exportProjectToTier2,
  assertSafeTier2Root,
  Tier2DisabledError,
  Tier2PathError,
} from '@/lib/storage/tier2-export'
import {
  importProjectFromTier2,
  Tier2ImportError,
} from '@/lib/storage/tier2-import'
import type { Scene } from '@/lib/types/scene'
import type { Project } from '@/lib/types/project'
import { assertValidUuid, IpcValidationError, IpcNotFoundError } from './_helpers'
import { getUserScenesDir } from '../paths'
import { createLogger } from '../../lib/logger'

const log = createLogger('electron.ipc.tier2')

/**
 * Category: tier2 (Tier 2 file mirror)
 *
 * Channel naming: `dreambyte:tier2.<method>` per the central convention.
 */

async function pickFolder(): Promise<{ canceled: boolean; tier2Path: string | null }> {
  const res = await dialog.showOpenDialog({
    title: 'Choose a folder to export this project to',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || res.filePaths.length === 0) {
    return { canceled: true, tier2Path: null }
  }
  return { canceled: false, tier2Path: res.filePaths[0] }
}

async function setPath(args: { projectId: string; tier2Path: string | null }): Promise<{ ok: true; tier2Path: string | null }> {
  assertValidUuid(args.projectId, 'projectId')

  let stored: string | null = null
  if (args.tier2Path != null) {
    if (typeof args.tier2Path !== 'string' || args.tier2Path.length === 0) {
      throw new IpcValidationError('tier2Path must be a non-empty string or null')
    }
    try {
      stored = await assertSafeTier2Root(args.tier2Path)
    } catch (err) {
      if (err instanceof Tier2PathError) throw new IpcValidationError(err.message)
      throw err
    }
  }

  const updated = await db
    .update(projects)
    .set({ tier2Path: stored, updatedAt: new Date() })
    .where(eq(projects.id, args.projectId))
    .returning({ id: projects.id })

  if (updated.length === 0) {
    throw new IpcNotFoundError(`Project ${args.projectId} not found`)
  }
  return { ok: true, tier2Path: stored }
}

async function loadProjectAndScenes(
  projectId: string,
): Promise<{ project: Project; scenes: Scene[] }> {
  const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!row) throw new IpcNotFoundError(`Project ${projectId} not found`)

  // Prefer table-backed scenes; fall back to blob if migration not done yet.
  let scenes: Scene[] = []
  const fromTables = await readProjectScenesFromTables(projectId).catch(() => null)
  if (fromTables && fromTables.scenes.length > 0) {
    scenes = fromTables.scenes
  } else {
    const blob = readProjectSceneBlob(row.description ?? null)
    scenes = (blob.scenes as Scene[]) ?? []
  }

  // Reshape to the renderer-side Project type (timestamps as ISO strings).
  const project: Project = {
    id: row.id,
    name: row.name,
    outputMode: (row.outputMode ?? 'mp4') as Project['outputMode'],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt as unknown as number).toISOString(),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt as unknown as number).toISOString(),
    mp4Settings: row.mp4Settings as Project['mp4Settings'],
    interactiveSettings: row.interactiveSettings as Project['interactiveSettings'],
    sceneGraph:
      (fromTables?.sceneGraph as Project['sceneGraph']) ??
      readProjectSceneBlob(row.description ?? null).sceneGraph ??
      { nodes: [], edges: [], startSceneId: '' },
    apiPermissions: row.apiPermissions as unknown as Project['apiPermissions'],
    audioSettings: row.audioSettings as Project['audioSettings'],
    audioProviderEnabled: row.audioProviderEnabled as Project['audioProviderEnabled'],
    mediaGenEnabled: row.mediaGenEnabled as Project['mediaGenEnabled'],
    watermark: row.watermark as Project['watermark'],
    brandKit: row.brandKit as Project['brandKit'],
    timeline: readProjectSceneBlob(row.description ?? null).timeline ?? null,
    tier2Path: row.tier2Path ?? null,
  }
  return { project, scenes }
}

async function exportNow(args: { projectId: string }): Promise<{
  ok: true
  filesWritten: number
  rootRealPath: string
}> {
  assertValidUuid(args.projectId, 'projectId')
  const { project, scenes } = await loadProjectAndScenes(args.projectId)
  if (!project.tier2Path) {
    throw new IpcValidationError('Project has no tier2Path set; call setPath first')
  }
  try {
    const result = await exportProjectToTier2({
      project,
      scenes,
      tier2Path: project.tier2Path,
      publicScenesDir: getUserScenesDir(),
    })
    log.info('tier2 export ok', {
      extra: { projectId: args.projectId, filesWritten: result.filesWritten, root: result.rootRealPath },
    })
    return result
  } catch (err) {
    if (err instanceof Tier2DisabledError) {
      throw new IpcValidationError(err.message)
    }
    if (err instanceof Tier2PathError) {
      throw new IpcValidationError(err.message)
    }
    log.error('tier2 export failed', { error: err, extra: { projectId: args.projectId } })
    throw err
  }
}

async function importNow(args: { projectId: string }): Promise<{
  ok: true
  project: Project
  scenes: Scene[]
  warnings: string[]
  rootRealPath: string
}> {
  assertValidUuid(args.projectId, 'projectId')
  const row = await db.query.projects.findFirst({ where: eq(projects.id, args.projectId) })
  if (!row) throw new IpcNotFoundError(`Project ${args.projectId} not found`)
  if (!row.tier2Path) {
    throw new IpcValidationError('Project has no tier2Path set; call setPath first')
  }
  try {
    const result = await importProjectFromTier2({ tier2Path: row.tier2Path })
    log.info('tier2 import ok', {
      extra: {
        projectId: args.projectId,
        sceneCount: result.scenes.length,
        warningCount: result.warnings.length,
        root: result.rootRealPath,
      },
    })
    return result
  } catch (err) {
    if (err instanceof Tier2DisabledError) throw new IpcValidationError(err.message)
    if (err instanceof Tier2ImportError) throw new IpcValidationError(err.message)
    if (err instanceof Tier2PathError) throw new IpcValidationError(err.message)
    log.error('tier2 import failed', { error: err, extra: { projectId: args.projectId } })
    throw err
  }
}

async function revealInFinder(args: { projectId: string }): Promise<{ ok: boolean }> {
  assertValidUuid(args.projectId, 'projectId')
  const row = await db.query.projects.findFirst({ where: eq(projects.id, args.projectId) })
  if (!row?.tier2Path) return { ok: false }
  const real = path.resolve(row.tier2Path)
  shell.showItemInFolder(path.join(real, 'project.json'))
  return { ok: true }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:tier2.pickFolder', () => pickFolder())
  ipcMain.handle('dreambyte:tier2.setPath', (_e, args) => setPath(args))
  ipcMain.handle('dreambyte:tier2.export', (_e, args) => exportNow(args))
  ipcMain.handle('dreambyte:tier2.import', (_e, args) => importNow(args))
  ipcMain.handle('dreambyte:tier2.revealInFinder', (_e, args) => revealInFinder(args))
}
