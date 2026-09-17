/**
 * Runtime injection point for how the Claude Code / Codex CLI providers
 * should spawn `scripts/mcp/mcp-server.ts` and reach its backing data layer.
 *
 * The providers run in `src/lib/agents/` and cannot import `electron` directly
 * without breaking the web build. The Electron main process populates this
 * module at startup; both the packaged desktop and the `npm run dev`
 * harness wire in the appropriate strategy.
 *
 * Desktop (packaged):
 *   - `launch` points at `process.execPath` (Electron) with
 *     `ELECTRON_RUN_AS_NODE=1` so it runs the compiled `dist-electron/
 *     mcp-server.cjs` in Node mode, no `tsx` / `npx` dependency.
 *   - `startBridge` opens a 127.0.0.1 ephemeral-port HTTP server tied to
 *     the CLI subprocess lifetime (see `src/electron/mcp-bridge.ts`). Its URL
 *     is injected as `DREAMBYTE_BASE_URL` for the MCP child so the adapter's
 *     fetches resolve against our in-process data layer.
 *
 * Unset (tests / no Electron):
 *   - Providers fall back to `npx tsx scripts/mcp/mcp-server.ts` against
 *     `NEXT_PUBLIC_BASE_URL` when set, otherwise run chat-only (no MCP tools).
 */

export interface McpLaunchCommand {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpBridgeHandle {
  /** Origin the MCP server should fetch against, e.g. `http://127.0.0.1:53914`. */
  url: string
  /** Shared secret the MCP subprocess sends as `Authorization: Bearer <token>`.
   *  Providers forward via the subprocess env (`DREAMBYTE_BRIDGE_TOKEN`) so only
   *  the MCP child we launched can mutate the user's project data, not any
   *  other local process that happens to find the port. */
  token: string
  /** Shut down the bridge. Caller invokes when the CLI subprocess exits. */
  close: () => Promise<void>
}

export interface McpHostConfig {
  /**
   * How the CLI should spawn `scripts/mcp/mcp-server.ts`. Written into the
   * `mcpServers.dreambyte.command` / `args` of the MCP config JSON.
   */
  launch: McpLaunchCommand
  /**
   * Optional per-invocation HTTP bridge. If present, each provider call
   * starts a fresh bridge, passes its URL via the subprocess env, and
   * closes it when the CLI exits.
   */
  startBridge?: () => Promise<McpBridgeHandle>
}

let _hostConfig: McpHostConfig | null = null

export function setMcpHostConfig(cfg: McpHostConfig | null): void {
  _hostConfig = cfg
}

export function getMcpHostConfig(): McpHostConfig | null {
  return _hostConfig
}
