#!/usr/bin/env node
/**
 * Dreambyte MCP connector for Claude Code.
 *
 * Bridges Claude Code's stdio MCP protocol to the persistent mcp-server
 * daemon managed by the Dreambyte Electron app (via Unix socket).
 *
 * Multi-instance aware: with one app per worktree (the worktree-per-agent
 * workflow), each instance registers under ~/.dreambyte/instances/<id>/.
 * The connector picks the instance whose repoPath matches THIS terminal's
 * cwd, so every terminal drives the app launched from its own worktree.
 * Selection precedence (scripts/mcp/mcp-select.cjs): DREAMBYTE_INSTANCE_ID pin
 * → cwd match → only-live → newest (warns on ambiguity). Falls back to the
 * legacy singleton ~/.dreambyte/mcp.sock when no instance registry exists
 * (older app builds).
 *
 * Starts in ~30ms — no TypeScript, no transpilation.
 * Listed in .mcp.json as the MCP server command.
 */
const net = require('net')
const path = require('path')
const os = require('os')
const { selectInstance } = require('./mcp-select.cjs')

const LEGACY_SOCKET = path.join(os.homedir(), '.dreambyte', 'mcp.sock')

// Token the daemon requires as the first line on the socket (`AUTH <token>\n`).
// Same per-launch bearer token the HTTP bridge uses; it already rides in the
// instance manifest we read to find the socket, so there is nothing new to
// distribute. Empty when falling back to the legacy singleton socket — an old
// app build has no token either, so it accepts the connection unauthenticated.
let socketAuthToken = ''

function resolveSocketPath() {
  const { manifest, reason, alternatives } = selectInstance({
    envId: process.env.DREAMBYTE_INSTANCE_ID,
    cwd: process.cwd(),
  })
  if (manifest) {
    socketAuthToken = manifest.token || ''
    if (reason === 'newest' && alternatives.length > 0) {
      process.stderr.write(
        `[mcp-connect] ${1 + alternatives.length} Dreambyte instances running and none matches this ` +
          `terminal's directory — using the newest (${manifest.repoPath || manifest.userDataPath}). ` +
          `Pin one with DREAMBYTE_INSTANCE_ID=<id>: ` +
          [manifest, ...alternatives].map((m) => `${m.instanceId}=${m.repoPath || m.userDataPath}`).join(', ') +
          '\n',
      )
    } else {
      process.stderr.write(
        `[mcp-connect] instance ${manifest.instanceId} via ${reason} (${manifest.repoPath || manifest.userDataPath})\n`,
      )
    }
    return manifest.socketPath
  }
  return LEGACY_SOCKET
}

const socketPath = resolveSocketPath()

// Retry on ENOENT: the mcp-server daemon may still be starting up when the
// connector runs. Retry a few times before giving up so there's no startup
// race between Electron spawning the daemon and Claude Code opening a session.
const MAX_RETRIES = 5
const RETRY_DELAY_MS = 600

function connect(attempt) {
  const socket = net.connect(socketPath)
  let connected = false

  socket.on('connect', () => {
    connected = true
    // Suppress EPIPE after connection — emitted when the server closes mid-stream.
    socket.on('error', () => {})
    // Authenticate first: the daemon reads exactly one `AUTH <token>\n` line and
    // drops the connection before serving any tool if it doesn't match. Written
    // before stdin is piped so it can never interleave with JSON-RPC traffic.
    if (socketAuthToken) socket.write(`AUTH ${socketAuthToken}\n`)
    socket.pipe(process.stdout)
    process.stdin.pipe(socket)
    process.stdin.on('end', () => socket.destroy())
  })

  socket.on('error', (err) => {
    if (err.code === 'ENOENT' && attempt < MAX_RETRIES) {
      setTimeout(() => connect(attempt + 1), RETRY_DELAY_MS)
      return
    }
    process.stderr.write(`[mcp-connect] Could not connect to Dreambyte: ${err.message}\n`)
    process.stderr.write('[mcp-connect] Make sure the Dreambyte app is running.\n')
    process.exit(1)
  })

  // Exit 0 only for a session that actually connected — a close that fires
  // without 'connect' (and without an 'error' to classify it) must not signal
  // success to the MCP client (/review L3).
  socket.on('close', () => process.exit(connected ? 0 : 1))
}

// Clean exit on SIGTERM so the mcp-server detects the close promptly
// and frees the transport for the next session.
process.on('SIGTERM', () => process.exit(0))

connect(0)
