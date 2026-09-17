import { app } from 'electron'
import type { IpcMain } from 'electron'
import path from 'node:path'
import { isClaudeCodeAvailable, getClaudeCodeVersion } from '../../lib/agents/claude-code-provider'
import { isCodexCliAvailable, getCodexCliVersion } from '../../lib/agents/codex-cli-provider'
import { spawn } from 'node:child_process'

/**
 * Category: agents
 *
 * Settings-panel helpers for "BYO CLI" integrations. When a desktop user
 * enables the Claude Code or Codex CLI routing, we need to tell them whether
 * the CLI is installed before they try to send a message and watch it fail.
 *
 * The provider modules already expose `isXAvailable()` + `getXVersion()` —
 * this IPC just wraps them and resolves the binary path so the UI can show
 * "Claude Code: detected at /opt/homebrew/bin/claude (v1.8.0)" instead of a
 * bare thumbs-up icon.
 */

/** Resolve the path of an executable on the user's PATH. Best-effort — we
 *  only use it for UX copy, never to spawn. */
function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('which', [cmd], { stdio: 'pipe', timeout: 3000 })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => {
      output += d.toString()
    })
    proc.on('close', (code) => resolve(code === 0 ? output.trim() : null))
    proc.on('error', () => resolve(null))
  })
}

interface CliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

async function detectClaudeCode(): Promise<CliStatus> {
  const installed = await isClaudeCodeAvailable()
  if (!installed) return { installed: false, version: null, path: null }
  const [version, path] = await Promise.all([getClaudeCodeVersion(), which('claude')])
  return { installed: true, version, path }
}

async function detectCodexCli(): Promise<CliStatus> {
  const installed = await isCodexCliAvailable()
  if (!installed) return { installed: false, version: null, path: null }
  const [version, path] = await Promise.all([getCodexCliVersion(), which('codex')])
  return { installed: true, version, path }
}

/** Absolute path to the dep-free stdio MCP connector. In packaged builds it
 *  ships via electron-builder `extraResources` to `process.resourcesPath/
 *  scripts/mcp/` — OUTSIDE app.asar, so an external `node` (Claude Code / Codex /
 *  Cursor) can actually exec the file and its sibling `mcp-select.cjs`
 *  require. An asar-internal path (`app.getAppPath()`) is not executable by an
 *  outside process, which is why this resolves to the unpacked resources dir.
 *  In dev it's the repo's scripts dir under cwd. */
function resolveConnectorPath(): string {
  const root = app.isPackaged ? process.resourcesPath : process.cwd()
  return path.join(root, 'scripts', 'mcp', 'mcp-connect.js')
}

const MCP_SERVER_NAME = 'dreambyte'

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:agents.detectCli', async () => {
    // Run both detections in parallel — each is capped at 5s by the
    // provider's spawn timeout so the whole call bounds at ~5s even when
    // both binaries are missing.
    const [claudeCode, codex] = await Promise.all([detectClaudeCode(), detectCodexCli()])
    return { claudeCode, codex }
  })

  // One-click MCP install info. Our MCP transport is a Unix-socket stdio
  // connector (scripts/mcp/mcp-connect.js), NOT HTTP — so every client uses the
  // same `node <connector>` command form. We return ready-made CLI commands
  // and a JSON snippet the Settings → Agents cards copy to the clipboard.
  ipcMain.handle('dreambyte:agents.mcpInstallInfo', async () => {
    const connectorPath = resolveConnectorPath()
    const jsonSnippet = JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: 'node',
            args: [connectorPath],
          },
        },
      },
      null,
      2,
    )
    return {
      serverName: MCP_SERVER_NAME,
      connectorPath,
      // Single-quote the path so a space in the install location (e.g. an app
      // dragged into "/Applications/My Apps/") doesn't tokenize the command.
      // macOS paths won't contain a single quote in practice. The JSON snippet
      // is already shell-safe — it's an argv array, not a shell string.
      claudeCodeCommand: `claude mcp add ${MCP_SERVER_NAME} -- node '${connectorPath}'`,
      codexCommand: `codex mcp add ${MCP_SERVER_NAME} -- node '${connectorPath}'`,
      jsonSnippet,
    }
  })
}
