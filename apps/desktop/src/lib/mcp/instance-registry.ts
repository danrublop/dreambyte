/**
 * Per-instance MCP discovery registry.
 *
 * The worktree-per-agent workflow runs MULTIPLE app instances concurrently
 * (one per worktree, each with its own `--user-data-dir` and DB). The old
 * discovery surface was three machine-wide singletons — `~/.dreambyte/mcp.sock`,
 * `~/.dreambyte/bridge.json`, and the daemon's env-frozen bridge URL — all
 * last-writer-wins: launching a second instance silently stole the terminal
 * MCP from the first, and QUITTING either instance deleted the other's socket
 * and bridge file. Agent work then landed in the wrong window/DB.
 *
 * This module gives every instance its own directory under
 * `~/.dreambyte/instances/<id>/` (id = hash of userData path + repo/worktree
 * path, stable across restarts of the same instance, distinct per worktree
 * even when worktrees share the default userData — see instanceIdFor):
 *
 *   instances/<id>/instance.json   — manifest: pid, repoPath, socket, bridge url+token
 *   instances/<id>/mcp.sock        — that instance's MCP daemon socket
 *
 * Consumers select an instance with `selectInstance()`:
 *   1. explicit pin (DREAMBYTE_INSTANCE_ID) —
 *   2. repoPath match against the caller's cwd (each terminal drives the app
 *      launched from ITS worktree — the actual multi-agent contract) —
 *   3. the only live instance —
 *   4. newest startedAt (ambiguous; callers should log the alternatives).
 *
 * `scripts/mcp/mcp-select.cjs` mirrors this selection for the dep-free stdio
 * connector; `instance-registry.test.ts` (parity describe-block) pins the two implementations
 * to the same answers.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import crypto from 'node:crypto'
import { homedir } from 'node:os'

export interface InstanceManifest {
  v: 1
  instanceId: string
  pid: number
  /** The instance's Electron userData path (identity source). */
  userDataPath: string
  /** Repo/worktree path the app was launched from (app.getAppPath(), NOT
   *  pre-resolved — selectInstance realpaths both sides at compare time);
   *  null when packaged. */
  repoPath: string | null
  /** Absolute path to this instance's MCP daemon Unix socket. */
  socketPath: string
  /** Terminal bridge origin, e.g. http://127.0.0.1:53914 */
  url: string
  /** Bearer token for the bridge. File is 0600 — same trust model as bridge.json. */
  token: string
  startedAt: number
}

/** Base dir injectable for tests (param > DREAMBYTE_INSTANCES_BASE env > ~/.dreambyte). */
export function instancesDir(base?: string): string {
  return nodePath.join(
    base ?? process.env.DREAMBYTE_INSTANCES_BASE ?? nodePath.join(homedir(), '.dreambyte'),
    'instances',
  )
}

/**
 * Stable short id for an instance, derived from its userData path AND the
 * repo/worktree it was launched from. The repoPath component is load-bearing:
 * the dev scripts (`npm run dev:desktop`) launch bare `electron .` with no
 * `--user-data-dir`, so two worktree instances SHARE the default userData —
 * keyed on userData alone they'd collapse to one instanceId (same socket,
 * same manifest) and the second instance would steal the first's terminal
 * MCP, the exact footgun this registry exists to kill (/review C1).
 *
 * 12 hex chars = 48 bits. Inputs are OS/dev-assigned paths, not adversarial,
 * so birthday-collision risk (~16M instances) is irrelevant; a collision
 * costs availability (shared dir), never auth.
 */
export function instanceIdFor(userDataPath: string, repoPath?: string | null): string {
  return crypto
    .createHash('sha256')
    .update(`${userDataPath}\n${repoPath ?? ''}`)
    .digest('hex')
    .slice(0, 12)
}

export function instanceDir(instanceId: string, base?: string): string {
  return nodePath.join(instancesDir(base), instanceId)
}

export function instanceSocketPath(instanceId: string, base?: string): string {
  return nodePath.join(instanceDir(instanceId, base), 'mcp.sock')
}

export function instanceManifestPath(instanceId: string, base?: string): string {
  return nodePath.join(instanceDir(instanceId, base), 'instance.json')
}

export async function writeInstanceManifest(manifest: InstanceManifest, base?: string): Promise<void> {
  const dir = instanceDir(manifest.instanceId, base)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = instanceManifestPath(manifest.instanceId, base)
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(manifest), { mode: 0o600, encoding: 'utf8' })
  await fsp.rename(tmp, file)
}

/** Remove this instance's directory (manifest + socket). Never throws. */
export async function removeInstanceDir(instanceId: string, base?: string): Promise<void> {
  try {
    await fsp.rm(instanceDir(instanceId, base), { recursive: true, force: true })
  } catch {
    // Already gone — fine.
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Selectable = pid alive AND the instance's socket file present. The pid check
 * alone is defeated by PID REUSE (a crashed instance's pid reassigned to an
 * unrelated process makes its stale manifest look live); the socket file is
 * the second witness — quit unlinks it, the next same-instance boot recreates
 * it. Residual risk (crash leaves the socket AND the pid gets reused) is
 * accepted: same-user only, self-heals on the next app boot's dead-dir sweep,
 * and a deep fix (pid start-time binding) is disproportionate (/review H2).
 *
 * NOTE: alive-pid-but-no-socket is NOT sweepable — that's a BOOTING instance
 * (manifest written before the daemon binds). Only dead pids are swept.
 */
function hasLiveSocket(m: InstanceManifest): boolean {
  try {
    fs.statSync(m.socketPath)
    return true
  } catch {
    return false
  }
}

function isLoopback(url: string): boolean {
  try {
    return new URL(url).hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function parseManifest(raw: string, base?: string): InstanceManifest | null {
  try {
    const data = JSON.parse(raw) as InstanceManifest
    if (
      data.v !== 1 ||
      typeof data.instanceId !== 'string' ||
      typeof data.socketPath !== 'string' ||
      typeof data.url !== 'string' ||
      typeof data.token !== 'string' ||
      !isLoopback(data.url)
    ) {
      return null
    }
    // Containment guard — the connector dials socketPath verbatim, so it gets
    // the same skepticism as url's loopback check: a poisoned manifest must
    // not redirect the Unix-socket connection outside the registry.
    const baseDir = nodePath.resolve(instancesDir(base))
    if (!nodePath.resolve(data.socketPath).startsWith(baseDir + nodePath.sep)) return null
    return data
  } catch {
    return null
  }
}

/** All manifests whose writer is still LIVE (pid alive + socket present — see
 *  hasLiveSocket for the pid-reuse rationale). Dead instances' dirs are swept
 *  opportunistically (a crash skips the quit cleanup). */
export async function listLiveInstances(base?: string): Promise<InstanceManifest[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(instancesDir(base))
  } catch {
    return []
  }
  const live: InstanceManifest[] = []
  for (const id of entries) {
    let raw: string
    try {
      raw = await fsp.readFile(instanceManifestPath(id, base), 'utf8')
    } catch {
      continue
    }
    const manifest = parseManifest(raw, base)
    if (!manifest) continue
    if (!isPidAlive(manifest.pid)) {
      // Crash leftovers — sweep so selection never has to wade through them.
      void removeInstanceDir(id, base)
      continue
    }
    // Alive but no socket yet = BOOTING (or pid-reuse zombie) — skip without
    // sweeping; the manifest belongs to a process that may be mid-startup.
    if (!hasLiveSocket(manifest)) continue
    live.push(manifest)
  }
  return live
}

export interface SelectOptions {
  /** Explicit pin — DREAMBYTE_INSTANCE_ID. Wins outright when alive. */
  envId?: string | null
  /** Caller's working directory (the terminal's worktree). */
  cwd?: string | null
  base?: string
}

export interface SelectResult {
  manifest: InstanceManifest | null
  /** Why this one: 'pin' | 'cwd' | 'only' | 'newest' | 'none'. */
  reason: 'pin' | 'cwd' | 'only' | 'newest' | 'none'
  /** Live alternatives NOT chosen (for caller logging on ambiguity). */
  alternatives: InstanceManifest[]
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Selection precedence: pin → cwd repoPath match → only-live → newest. */
export async function selectInstance(opts: SelectOptions = {}): Promise<SelectResult> {
  const live = await listLiveInstances(opts.base)
  if (live.length === 0) return { manifest: null, reason: 'none', alternatives: [] }

  if (opts.envId) {
    const pinned = live.find((m) => m.instanceId === opts.envId)
    if (pinned) return { manifest: pinned, reason: 'pin', alternatives: live.filter((m) => m !== pinned) }
  }

  if (opts.cwd) {
    const cwdReal = safeRealpath(opts.cwd)
    // Containment, not equality: terminals routinely run from a SUBDIRECTORY
    // of the worktree, which must still bind to that worktree's instance —
    // exact-match silently fell through to 'newest' (wrong window/DB). When
    // nested repoPaths both contain the cwd, the deepest (most specific) wins.
    let match: InstanceManifest | null = null
    let matchLen = -1
    for (const m of live) {
      if (!m.repoPath) continue
      const repoReal = safeRealpath(m.repoPath)
      if ((cwdReal === repoReal || cwdReal.startsWith(repoReal + nodePath.sep)) && repoReal.length > matchLen) {
        match = m
        matchLen = repoReal.length
      }
    }
    if (match) {
      const found = match
      return { manifest: found, reason: 'cwd', alternatives: live.filter((m) => m !== found) }
    }
  }

  if (live.length === 1) return { manifest: live[0], reason: 'only', alternatives: [] }

  const newest = [...live].sort((a, b) => b.startedAt - a.startedAt)[0]
  return { manifest: newest, reason: 'newest', alternatives: live.filter((m) => m !== newest) }
}
