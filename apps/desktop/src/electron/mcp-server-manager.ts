/**
 * Manages the persistent MCP server daemon for Terminal Claude Code.
 *
 * The app owns the mcp-server process lifetime. Claude Code connects via a
 * Unix socket using the tiny connector at scripts/mcp/mcp-connect.js — no npx,
 * no tsx, no startup race condition.
 *
 * Multi-instance: each app instance binds its OWN socket at
 * ~/.dreambyte/instances/<id>/mcp.sock (id = hash of userData path + repo
 * path — see instance-registry.instanceIdFor), so concurrent worktree
 * instances never fight over one path. The legacy singleton
 * ~/.dreambyte/mcp.sock is maintained as a SYMLINK to the newest instance's
 * socket (old connectors keep working, with the old last-writer-wins
 * semantics they always had). Cleanup is ownership-checked AND succession-
 * aware: an instance only touches the legacy symlink if it points at ITS
 * socket, and on quit it repoints the symlink at a surviving instance
 * instead of leaving old connectors with nothing — quitting one instance
 * must never sever another's terminal MCP.
 *
 * Platform note: Unix sockets + symlinks — macOS/Linux only. The desktop app
 * does not currently target Windows; a win32 port needs named pipes
 * (\\.\pipe\...) and a junction/registry alternative for the legacy path.
 */
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { app } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('electron.mcp-server-manager')

/** Legacy singleton socket — now a symlink to the newest instance's socket. */
const MCP_SOCKET_PATH = path.join(os.homedir(), '.dreambyte', 'mcp.sock')

/** Respawn backoff: fast-failing daemons (exit within FAST_FAIL_MS) double the
 *  delay up to the cap; a daemon that stayed up resets it. Prevents the 0.5Hz
 *  forever-loop when the failure is persistent (deleted socket dir, EACCES). */
const RESPAWN_BASE_MS = 2000
const RESPAWN_MAX_MS = 60_000
const FAST_FAIL_MS = 5000

let mcpProcess: ChildProcess | null = null
let stopping = false
let quitHandlerRegistered = false
let ownSocketPath: string | null = null
let respawnDelayMs = RESPAWN_BASE_MS

/** Repoint the legacy symlink at the given socket (atomic: tmp + rename). Best-effort. */
function repointLegacySymlink(target: string): void {
  try {
    const tmp = MCP_SOCKET_PATH + '.tmp-' + process.pid
    try {
      fs.unlinkSync(tmp)
    } catch {}
    fs.symlinkSync(target, tmp)
    fs.renameSync(tmp, MCP_SOCKET_PATH)
  } catch (err) {
    // A plain socket file from an old build may sit at the legacy path. Replace it.
    // (unlink+symlink is non-atomic, but this branch only runs against old-build
    // leftovers — concurrent NEW instances all take the atomic rename path above.)
    try {
      fs.unlinkSync(MCP_SOCKET_PATH)
      fs.symlinkSync(target, MCP_SOCKET_PATH)
    } catch {
      log.warn('could not maintain legacy mcp.sock symlink', { error: err })
    }
  }
}

/** Best-effort sync scan for another live instance's socket (succession target
 *  for the legacy symlink on quit). Inline & synchronous because before-quit
 *  handlers can't await. Mirrors instance-registry liveness (pid + socket). */
function findSurvivorSocket(): string | null {
  try {
    const instancesBase = path.join(os.homedir(), '.dreambyte', 'instances')
    for (const id of fs.readdirSync(instancesBase)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(instancesBase, id, 'instance.json'), 'utf8')) as {
          pid?: number
          socketPath?: string
        }
        if (!m.socketPath || m.socketPath === ownSocketPath) continue
        if (!Number.isInteger(m.pid) || (m.pid as number) <= 0) continue
        process.kill(m.pid as number, 0) // throws if dead
        fs.statSync(m.socketPath) // throws if socket gone
        return m.socketPath
      } catch {
        continue
      }
    }
  } catch {}
  return null
}

/**
 * On quit: if the legacy symlink points at OUR socket, hand it to a surviving
 * instance (so old connectors keep working) or remove it when we're the last.
 * Never touches a symlink that points elsewhere — that's another instance's.
 * The readlink→act window is a same-user microsecond TOCTOU, accepted.
 */
function cleanupLegacySymlinkIfOurs(): void {
  if (!ownSocketPath) return
  try {
    const target = fs.readlinkSync(MCP_SOCKET_PATH)
    if (target !== ownSocketPath) return
    const survivor = findSurvivorSocket()
    if (survivor) repointLegacySymlink(survivor)
    else fs.unlinkSync(MCP_SOCKET_PATH)
  } catch {
    // Not a symlink (old build's plain socket) or already gone — leave it.
  }
}

export async function startMcpServerProcess(
  mcpServerPath: string,
  bridgeUrl: string,
  bridgeToken: string,
  opts: { socketPath?: string; instanceId?: string } = {},
): Promise<void> {
  stopping = false
  const socketPath = opts.socketPath ?? MCP_SOCKET_PATH
  ownSocketPath = socketPath
  respawnDelayMs = RESPAWN_BASE_MS

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DREAMBYTE_STUDIO_URL: bridgeUrl,
    DREAMBYTE_BRIDGE_TOKEN: bridgeToken,
    DREAMBYTE_MCP_SOCKET: socketPath,
    // Lets the daemon re-discover ITS OWN instance manifest after an app
    // restart (the adapter's reconnect path), instead of the global file.
    ...(opts.instanceId ? { DREAMBYTE_INSTANCE_ID: opts.instanceId } : {}),
    // Keep asar filesystem patches active in packaged builds.
    ELECTRON_RUN_AS_NODE: '1',
  }

  function spawnServer() {
    if (stopping) return

    // Re-assert the socket dir + clear our stale socket on EVERY (re)spawn —
    // not just the first. If the instance dir was removed under us (sweep
    // race, cleaner), a once-only mkdir left every respawn failing on ENOENT
    // forever. Per-instance path — never another instance's.
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
    } catch {}
    try {
      fs.unlinkSync(socketPath)
    } catch {}

    const spawnedAt = Date.now()
    const child = spawn(process.execPath, [mcpServerPath], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    child.stderr?.on('data', (d: Buffer) => {
      log.info('[mcp-server] ' + d.toString().trimEnd())
    })

    child.on('exit', (code, signal) => {
      mcpProcess = null
      if (!stopping) {
        // Backoff on fast failures (persistent listen errors); reset after a
        // healthy run so a one-off crash still restarts promptly.
        const lifetime = Date.now() - spawnedAt
        respawnDelayMs = lifetime < FAST_FAIL_MS ? Math.min(respawnDelayMs * 2, RESPAWN_MAX_MS) : RESPAWN_BASE_MS
        log.warn('mcp-server exited unexpectedly, restarting', {
          extra: { code, signal, retryInMs: respawnDelayMs },
        })
        setTimeout(spawnServer, respawnDelayMs)
      }
    })

    mcpProcess = child
    log.info('mcp-server process started', { extra: { pid: child.pid, socket: socketPath } })
  }

  spawnServer()

  // Old connectors resolve the legacy path; keep it working (last-writer-wins,
  // as before — but now reversible and never silently destructive).
  if (socketPath !== MCP_SOCKET_PATH) repointLegacySymlink(socketPath)

  // Register exactly once. The telemetry handler on before-quit calls
  // event.preventDefault() + app.quit(), which fires before-quit a second time.
  // Guard with a module-level flag so we don't accumulate listeners on
  // repeated startMcpServerProcess calls and don't double-kill on the second fire.
  if (!quitHandlerRegistered) {
    quitHandlerRegistered = true
    app.on('before-quit', () => {
      if (stopping) return
      stopping = true
      mcpProcess?.kill()
      // Synchronous unlink so the file is gone before the process exits.
      // Electron does not await async before-quit handlers.
      try {
        if (ownSocketPath) fs.unlinkSync(ownSocketPath)
      } catch {}
      cleanupLegacySymlinkIfOurs()
    })
  }
}
