import type { IpcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { resolveScenesDir } from '@/lib/scene-html-paths'
import { db } from '@/lib/db'
import * as schema from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { readProjectSceneBlob } from '@/lib/db/project-scene-storage'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'
import { verifyAndStampScene, type SceneVerifyOutcome } from '@/lib/services/scene-verifier'
import { clearSceneErrors } from '@/lib/agents/scene-error-buffer'
import { withWriterGate, BranchWriterBlockedError } from '@/lib/db/queries/branch-locks'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError, IpcNotFoundError } from './_helpers'

/**
 * Category: scene
 *
 * Renderer-facing scene HTML I/O: write/read a scene's HTML file and fetch a
 * scene row. Agent/MCP scene creation and edits go through the agent tools.
 */

// ── Filesystem roots ────────────────────────────────────────────────────────
// resolveScenesDir() imported from src/lib/scene-html-paths. DREAMBYTE_SCENES_DIR is
// stamped by main.ts at startup before any handler runs.

const SCENE_ID_RE = /^[a-zA-Z0-9_-]+$/
// Scene rows use UUID ids; only attempt a branch lookup for UUID-shaped ids so
// synthetic/template ids skip the DB round-trip (and the writer gate) cleanly.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const MAX_HTML_BYTES = 5 * 1024 * 1024 // match the old route's limit

type WriteHtmlResult = {
  success: true
  path: string
  verifyStatus: SceneVerifyOutcome['status']
  verifyError: SceneVerifyOutcome['error']
}

type WriteHtmlArgs = { id: string; html: string }

async function writeHtml(args: WriteHtmlArgs): Promise<WriteHtmlResult> {
  if (!SCENE_ID_RE.test(args.id)) {
    throw new IpcValidationError('invalid scene id')
  }
  if (typeof args.html !== 'string') {
    throw new IpcValidationError('html must be a string')
  }
  if (args.html.length > MAX_HTML_BYTES) {
    throw new IpcValidationError('HTML body exceeds 5MB limit')
  }

  const scenesDir = resolveScenesDir()
  await fs.mkdir(scenesDir, { recursive: true })
  const destPath = path.resolve(path.join(scenesDir, `${args.id}.html`))
  // Defense in depth against a hand-crafted id matching SCENE_ID_RE but
  // resolving outside the scenes directory (shouldn't be possible given
  // the charset, but `..` passes the regex if someone widens it).
  if (!destPath.startsWith(scenesDir + path.sep)) {
    throw new IpcValidationError('Invalid scene id (path escape)')
  }

  // Resolve the scene's branch/project so the disk write — the agent's
  // syncScenesFromAgent HTML loop and user layer commits both land here — can be
  // gated behind a concurrent fork/restore/delete on that branch. The agent
  // persists scene ROWS before the renderer writes HTML, so by the time we get
  // here the row (and its branchId) exists. A row we can't resolve (brand-new
  // scene, or non-UUID synthetic id) writes ungated: there's no fork/restore
  // target keyed to an unknown branch to race.
  let branchId: string | null = null
  let projectId: string | null = null
  if (UUID_RE.test(args.id)) {
    const [row] = await db
      .select({ branchId: schema.scenes.branchId, projectId: schema.scenes.projectId })
      .from(schema.scenes)
      .where(eq(schema.scenes.id, args.id))
      .limit(1)
    branchId = row?.branchId ?? null
    projectId = row?.projectId ?? null
  }

  const doWrite = async (): Promise<WriteHtmlResult> => {
    await fs.writeFile(destPath, args.html, 'utf-8')
    // New HTML invalidates the scene's playback-error history — stale
    // errors from the previous code must not haunt verify reports; the next
    // load reports fresh ones if the new code is still broken.
    clearSceneErrors(args.id)
    const outcome = await verifyAndStampScene(args.id)
    return {
      success: true as const,
      path: `/scenes/${args.id}.html`,
      verifyStatus: outcome.status,
      verifyError: outcome.error,
    }
  }

  try {
    if (branchId && projectId) {
      return await withWriterGate({ branchId, projectId }, doWrite)
    }
    return await doWrite()
  } catch (err) {
    if (err instanceof BranchWriterBlockedError) throw new IpcValidationError(err.message)
    throw err
  }
}

type GetArgs = { projectId: string; sceneId: string }

async function get(args: GetArgs) {
  assertValidUuid(args.projectId, 'projectId')
  assertValidUuid(args.sceneId, 'sceneId')
  await loadProjectOrThrow(args.projectId)

  const [project] = await db
    .select({ description: schema.projects.description })
    .from(schema.projects)
    .where(eq(schema.projects.id, args.projectId))
    .limit(1)
  if (!project) throw new IpcNotFoundError(`Project ${args.projectId} not found`)

  const tableBacked = await readProjectScenesFromTables(args.projectId)
  const scenes = tableBacked?.scenes ?? readProjectSceneBlob(project.description).scenes

  const scene = (scenes as Array<{ id: string }>).find((s) => s.id === args.sceneId)
  if (!scene) {
    throw new IpcNotFoundError(`Scene ${args.sceneId} not found`)
  }
  return { scene }
}

/**
 * Read a scene's on-disk HTML for the self-heal check. Returns
 * `{ exists, html }`. `html` is null when the file is missing. The renderer
 * byte-compares this against freshly-generated HTML to decide whether to
 * regenerate — so the staleness decision uses the SAME generateSceneHTML output
 * the save path produces, with no separate "version" field to drift.
 */
type ReadHtmlArgs = { id: string }
async function readHtml(args: ReadHtmlArgs): Promise<{ exists: boolean; html: string | null }> {
  if (!SCENE_ID_RE.test(args.id)) {
    throw new IpcValidationError('invalid scene id')
  }
  const scenesDir = resolveScenesDir()
  const destPath = path.resolve(path.join(scenesDir, `${args.id}.html`))
  if (!destPath.startsWith(scenesDir + path.sep)) {
    throw new IpcValidationError('Invalid scene id (path escape)')
  }
  try {
    const html = await fs.readFile(destPath, 'utf-8')
    return { exists: true, html }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, html: null }
    throw err
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:scene.writeHtml', (_e, args: WriteHtmlArgs) => writeHtml(args))
  ipcMain.handle('dreambyte:scene.get', (_e, args: GetArgs) => get(args))
  ipcMain.handle('dreambyte:scene.readHtml', (_e, args: ReadHtmlArgs) => readHtml(args))
}
