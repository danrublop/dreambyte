# Dreambyte — notes for coding agents

[`CLAUDE.md`](CLAUDE.md) is the full codebase reference (stack, key directories, how the agent runs,
how scenes are written, scene globals, style system). It applies to every coding agent, not only
Claude Code — read it first. This file covers only how an external agent (Codex, Cursor, Claude Code,
or any MCP client) drives the running app.

## MCP access

- `.mcp.json` in `apps/desktop/` (start your agent there) runs `node scripts/mcp/mcp-connect.js`, which forwards stdio to the MCP
  server the desktop app manages (`scripts/mcp/mcp-server.ts`). Each running app registers under
  `~/.dreambyte/instances/<id>/`, and the connector picks the instance for this checkout.
- The MCP server calls back into the app through `src/electron/mcp-bridge.ts`, a `127.0.0.1` HTTP bridge
  with a per-launch bearer token. It is an internal transport, not a public API.
- **The app must be running.** If a tool returns "Dreambyte is not running", stop and tell the user
  to open the app and wait for it to load. Do not retry.
- For a saved `*.dreambyte` export folder without the app, use the read-only Tier 2 server:
  `npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte`.

The `/dreambyte` skill ([`.claude/skills/dreambyte/SKILL.md`](.claude/skills/dreambyte/SKILL.md),
mirrored in `.agents/skills/dreambyte/`) has the goal → tool table, the scene output contract, and
the interactive-video workflow.

## Anti-patterns

- **No REST API.** There is no `localhost:3000` server and no `/api/*` route. Use the MCP tools.
- **Don't hand-edit scene HTML.** It is regenerated from the project on the next tool call; change the
  scene code with `write_scene_code` / `patch_layer_code` instead.
- **Don't hardcode scene IDs.** Get them from the world state, `inspect`, or tool results.
- **Verify.** Call `verify_scene` after `write_scene_code`, `add_layer`, or `regenerate_layer`.
- **Don't call `select_project` every turn.** The active project persists.
- **Don't hardcode 1920/1080.** Use the injected `WIDTH` and `HEIGHT` globals.
- **Run scene mutations on one project sequentially**, not in parallel — they share the project blob.
