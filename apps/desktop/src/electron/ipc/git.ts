import type { IpcMain } from 'electron'
import { db } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import {
  gitInit,
  gitStatus,
  gitAdd,
  gitCommit,
  gitLog,
  gitBranchCreate,
  gitBranchList,
  gitCurrentBranch,
  gitCheckout,
  gitDiffNameStatus,
  type CommitInfo,
  type DiffEntry,
  type StatusEntry,
} from '@/lib/git/repo'
import {
  gitRemoteAdd,
  gitRemoteList,
  gitRemoteGetUrl,
  gitPush,
  gitPull,
  type RemoteEntry,
} from '@/lib/git/remote'
import { GitRunError } from '@/lib/git/git-runner'
import { markPendingActionsWithCommit, listActionsByCommitShas } from '@/lib/db/queries/action-log'
import {
  setToken as setRemoteToken,
  hasToken as hasRemoteTokenFn,
  clearToken as clearRemoteToken,
  loadDecryptedToken,
} from '../git-credentials'
import { assertValidUuid, IpcValidationError, IpcNotFoundError } from './_helpers'
import { createLogger } from '../../lib/logger'

const log = createLogger('electron.ipc.git')

/**
 * Category: git
 *
 * Channel naming: `dreambyte:git.<method>`. Every handler resolves the
 * project's tier2Path (the Tier 2 mirror is the git repo); if no path
 * is set the handler throws `IpcValidationError` so the renderer can
 * surface a "configure project folder first" message.
 *
 * Errors from `runGit` come up as `GitRunError`; we map those to
 * `IpcValidationError` with the stderr included so the UI gets the
 * human message without a stack trace blob.
 */

async function loadTier2Path(projectId: string): Promise<string> {
  assertValidUuid(projectId, 'projectId')
  const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!row) throw new IpcNotFoundError(`Project ${projectId} not found`)
  if (!row.tier2Path) {
    throw new IpcValidationError('Project has no tier2Path set; configure a folder first')
  }
  return row.tier2Path
}

function wrapGitError<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof GitRunError) {
      log.warn(`git ${op} failed`, { extra: { exitCode: err.exitCode, stderr: err.stderr } })
      throw new IpcValidationError(`git ${op} failed: ${err.stderr.trim() || err.message}`)
    }
    throw err
  })
}

async function initProject(args: { projectId: string }): Promise<{ ok: true; tier2Path: string }> {
  const cwd = await loadTier2Path(args.projectId)
  await wrapGitError('init', () => gitInit({ cwd }))
  return { ok: true, tier2Path: cwd }
}

async function status(args: { projectId: string }): Promise<{ entries: StatusEntry[] }> {
  const cwd = await loadTier2Path(args.projectId)
  const entries = await wrapGitError('status', () => gitStatus({ cwd }))
  return { entries }
}

async function commit(args: {
  projectId: string
  message: string
  addAll?: boolean
  allowEmpty?: boolean
}): Promise<{ sha: string; actionsBound: number }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.message !== 'string' || args.message.trim() === '') {
    throw new IpcValidationError('message must be a non-empty string')
  }
  if (args.addAll !== false) {
    await wrapGitError('add', () => gitAdd(['.'], { cwd }))
  }
  const sha = await wrapGitError('commit', () => gitCommit(args.message, { cwd, allowEmpty: args.allowEmpty }))
  // Stamp every still-pending action_log row with this commit
  // SHA so the diff viewer can fetch the actions that landed in this
  // commit. Failures here MUST NOT undo the commit — the commit is real;
  // we just lose the action↔commit link.
  let actionsBound = 0
  try {
    actionsBound = await markPendingActionsWithCommit(args.projectId, sha)
  } catch (err) {
    log.warn('markPendingActionsWithCommit failed', { error: err })
  }
  return { sha, actionsBound }
}

async function logCommits(args: { projectId: string; maxCount?: number; ref?: string }): Promise<{ commits: CommitInfo[] }> {
  const cwd = await loadTier2Path(args.projectId)
  const commits = await wrapGitError('log', () => gitLog({ cwd, maxCount: args.maxCount, ref: args.ref }))
  return { commits }
}

async function branchList(args: { projectId: string }): Promise<{ branches: string[]; current: string | null }> {
  const cwd = await loadTier2Path(args.projectId)
  const branches = await wrapGitError('branch --list', () => gitBranchList({ cwd }))
  const current = await wrapGitError('branch --current', () => gitCurrentBranch({ cwd }))
  return { branches, current }
}

async function branchCreate(args: { projectId: string; name: string; checkout?: boolean }): Promise<{ ok: true; branch: string }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.name !== 'string' || args.name.trim() === '') {
    throw new IpcValidationError('name must be a non-empty string')
  }
  await wrapGitError('branch', () => gitBranchCreate(args.name, { cwd }))
  if (args.checkout) {
    await wrapGitError('checkout', () => gitCheckout(args.name, { cwd }))
  }
  return { ok: true, branch: args.name }
}

async function checkout(args: { projectId: string; branch: string; create?: boolean }): Promise<{ ok: true; branch: string }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.branch !== 'string' || args.branch.trim() === '') {
    throw new IpcValidationError('branch must be a non-empty string')
  }
  await wrapGitError('checkout', () => gitCheckout(args.branch, { cwd, create: args.create }))
  return { ok: true, branch: args.branch }
}

async function diff(args: { projectId: string; from: string; to: string }): Promise<{ entries: DiffEntry[] }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.from !== 'string' || typeof args.to !== 'string') {
    throw new IpcValidationError('from / to must be strings (refs or SHAs)')
  }
  const entries = await wrapGitError('diff', () => gitDiffNameStatus(args.from, args.to, { cwd }))
  return { entries }
}

/**
 * Resolve the list of commits in `from..to` (exclusive of `from`,
 * inclusive of `to`), then return the actions stamped with those SHAs.
 * Pass `includeUncommitted:true` to also pick up actions written since
 * the latest commit. This is what the diff viewer asks for when
 * rendering the deeper action diff.
 */
async function listActionsForRange(args: {
  projectId: string
  from: string
  to: string
  includeUncommitted?: boolean
}): Promise<{ actions: Array<Record<string, unknown>>; commitShas: string[] }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.from !== 'string' || typeof args.to !== 'string') {
    throw new IpcValidationError('from / to must be strings (refs or SHAs)')
  }
  // `git log from..to` enumerates the commits reachable from `to` but
  // NOT from `from` — the canonical "what changed between these" walk.
  const { runGit } = await import('@/lib/git/git-runner')
  const range = `${args.from}..${args.to}`
  const log = await wrapGitError(`log ${range}`, () =>
    runGit(['log', '--format=%H', range], { cwd }),
  )
  const commitShas = log.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  const shas: Array<string | null> = [...commitShas]
  if (args.includeUncommitted) shas.push(null)
  const actions = await listActionsByCommitShas(args.projectId, shas)
  return { actions: actions as unknown as Array<Record<string, unknown>>, commitShas }
}

// ── P5-remote-ipc-agent: remote management + push/pull ────────────────────

async function remoteAdd(args: { projectId: string; name: string; url: string }): Promise<{ ok: true }> {
  const cwd = await loadTier2Path(args.projectId)
  if (typeof args.name !== 'string' || args.name.trim() === '')
    throw new IpcValidationError('name must be a non-empty string')
  if (typeof args.url !== 'string' || args.url.trim() === '')
    throw new IpcValidationError('url must be a non-empty string')
  await wrapGitError('remote add', () => gitRemoteAdd(args.name, args.url, { cwd }))
  return { ok: true }
}

async function remoteList(args: { projectId: string }): Promise<{ remotes: RemoteEntry[] }> {
  const cwd = await loadTier2Path(args.projectId)
  const remotes = await wrapGitError('remote -v', () => gitRemoteList({ cwd }))
  return { remotes }
}

async function setRemoteTokenIpc(args: {
  projectId: string
  remoteName: string
  token: string
}): Promise<{ ok: true }> {
  if (typeof args.remoteName !== 'string' || args.remoteName.trim() === '')
    throw new IpcValidationError('remoteName must be a non-empty string')
  if (typeof args.token !== 'string' || args.token.length === 0)
    throw new IpcValidationError('token must be a non-empty string')
  try {
    await setRemoteToken({ projectId: args.projectId, remoteName: args.remoteName, token: args.token })
  } catch (err) {
    throw new IpcValidationError((err as Error).message)
  }
  return { ok: true }
}

async function hasRemoteTokenIpc(args: { projectId: string; remoteName: string }): Promise<{ has: boolean }> {
  return { has: await hasRemoteTokenFn(args.projectId, args.remoteName) }
}

async function clearRemoteTokenIpc(args: { projectId: string; remoteName: string }): Promise<{ ok: true }> {
  await clearRemoteToken(args.projectId, args.remoteName)
  return { ok: true }
}

async function pushRemote(args: {
  projectId: string
  remote: string
  ref: string
}): Promise<{ ok: true }> {
  const cwd = await loadTier2Path(args.projectId)
  const remoteUrl = await wrapGitError('remote get-url', () => gitRemoteGetUrl(args.remote, { cwd }))
  if (!remoteUrl) throw new IpcValidationError(`Remote ${args.remote} not configured`)
  let token: string | null = null
  try {
    token = await loadDecryptedToken(args.projectId, args.remote)
  } catch (err) {
    // safeStorage unavailable / unconfigured — fall back to unauthenticated.
    log.warn('loadDecryptedToken failed; pushing unauthenticated', { error: err })
  }
  await wrapGitError('push', () =>
    gitPush(args.remote, args.ref, {
      cwd,
      authToken: token ?? undefined,
      remoteUrl,
    }),
  )
  return { ok: true }
}

async function pullRemote(args: {
  projectId: string
  remote: string
  ref: string
}): Promise<{ ok: true }> {
  const cwd = await loadTier2Path(args.projectId)
  const remoteUrl = await wrapGitError('remote get-url', () => gitRemoteGetUrl(args.remote, { cwd }))
  if (!remoteUrl) throw new IpcValidationError(`Remote ${args.remote} not configured`)
  let token: string | null = null
  try {
    token = await loadDecryptedToken(args.projectId, args.remote)
  } catch (err) {
    log.warn('loadDecryptedToken failed; pulling unauthenticated', { error: err })
  }
  await wrapGitError('pull', () =>
    gitPull(args.remote, args.ref, {
      cwd,
      authToken: token ?? undefined,
      remoteUrl,
    }),
  )
  return { ok: true }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:git.init', (_e, args) => initProject(args))
  ipcMain.handle('dreambyte:git.status', (_e, args) => status(args))
  ipcMain.handle('dreambyte:git.commit', (_e, args) => commit(args))
  ipcMain.handle('dreambyte:git.log', (_e, args) => logCommits(args))
  ipcMain.handle('dreambyte:git.branchList', (_e, args) => branchList(args))
  ipcMain.handle('dreambyte:git.branchCreate', (_e, args) => branchCreate(args))
  ipcMain.handle('dreambyte:git.checkout', (_e, args) => checkout(args))
  ipcMain.handle('dreambyte:git.diff', (_e, args) => diff(args))
  ipcMain.handle('dreambyte:git.listActionsForRange', (_e, args) => listActionsForRange(args))
  ipcMain.handle('dreambyte:git.remoteAdd', (_e, args) => remoteAdd(args))
  ipcMain.handle('dreambyte:git.remoteList', (_e, args) => remoteList(args))
  ipcMain.handle('dreambyte:git.setRemoteToken', (_e, args) => setRemoteTokenIpc(args))
  ipcMain.handle('dreambyte:git.hasRemoteToken', (_e, args) => hasRemoteTokenIpc(args))
  ipcMain.handle('dreambyte:git.clearRemoteToken', (_e, args) => clearRemoteTokenIpc(args))
  ipcMain.handle('dreambyte:git.push', (_e, args) => pushRemote(args))
  ipcMain.handle('dreambyte:git.pull', (_e, args) => pullRemote(args))
}
