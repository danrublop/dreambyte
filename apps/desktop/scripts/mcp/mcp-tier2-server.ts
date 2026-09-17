#!/usr/bin/env npx tsx
/**
 * Dreambyte Tier 2 MCP Server
 *
 * Standalone stdio MCP server that exposes a single Dreambyte project's
 * Tier 2 folder (`.dreambyte/`) as a read-only filesystem. Designed for
 * external AI editors (Claude Code, Cursor, Codex) to drive a Dreambyte
 * project without the app running.
 *
 * Different from `scripts/mcp/mcp-server.ts` — that server drives the
 * running Electron app via HTTP. This one reads static files. They
 * complement each other: the in-app server is for live editing
 * while the user is in Dreambyte; this server is for browsing,
 * git-ing, and external-agent inspection of a `.dreambyte/` folder.
 *
 * Usage:
 *   npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte
 *   DREAMBYTE_TIER2_ROOT=/path/to/project.dreambyte npx tsx scripts/mcp/mcp-tier2-server.ts
 *
 * Configure as MCP server in Claude Code:
 *   claude mcp add dreambyte-tier2 -- npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte
 *
 * Path-containment guard (src/lib/agents/dreambyte-fs/path-guard.ts) is the
 * load-bearing security boundary. Every tool call resolves subpaths
 * through it before touching disk; symlinks, ../ traversal, absolute
 * paths, and null-byte truncation are all rejected.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  DreambyteFsError,
  listScenes,
  readProject,
  readScene,
  readSceneHtml,
  listAssets,
  PathEscapeError,
} from '../../src/lib/agents/dreambyte-fs/index.js'
import { assertSafeTier2Root } from '../../src/lib/storage/tier2-export.js'

const TOOL_DEFS = [
  {
    name: 'tier2_read_project',
    description: 'Return the parsed project.json from the bound Tier 2 folder.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tier2_list_scenes',
    description:
      'List scenes from project.json sceneOrder, returning one summary per scene with id/name/duration/sceneType. Skips scenes whose dreambyte.json is missing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tier2_read_scene',
    description: 'Return the parsed dreambyte.json for a single scene.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: {
          type: 'string',
          description: 'Scene id from tier2_list_scenes. Must be alphanumeric (with - or _ separators).',
        },
      },
      required: ['sceneId'],
    },
  },
  {
    name: 'tier2_read_scene_html',
    description:
      "Return the rendered scene HTML if it exists; null otherwise. The HTML is what's served when the scene plays in Dreambyte.",
    inputSchema: {
      type: 'object',
      properties: { sceneId: { type: 'string', description: 'Scene id' } },
      required: ['sceneId'],
    },
  },
  {
    name: 'tier2_list_assets',
    description: 'List files under assets/ with relative subpaths and byte sizes. Symlinks that escape scope are skipped.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

async function resolveScopeRoot(): Promise<string> {
  const fromArg = process.argv[2]
  const fromEnv = process.env.DREAMBYTE_TIER2_ROOT
  const raw = fromArg || fromEnv
  if (!raw) {
    process.stderr.write('dreambyte-tier2-mcp: scope root required. Pass as first arg or set DREAMBYTE_TIER2_ROOT.\n')
    process.exit(2)
  }
  try {
    return await assertSafeTier2Root(raw)
  } catch (err) {
    process.stderr.write(`dreambyte-tier2-mcp: ${(err as Error).message}\n`)
    process.exit(2)
  }
}

function buildServer(scopeRoot: string): Server {
  const server = new Server(
    { name: 'dreambyte-tier2', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `You are reading a Dreambyte project's Tier 2 file mirror at:
  ${scopeRoot}

This is a read-only view. The folder structure:
  project.json              project metadata + sceneOrder
  scenes/{id}.dreambyte.json    structured scene state per scene
  scenes/{id}.html          rendered scene HTML (may not always be present)
  assets/                   user-uploaded media

Start with tier2_read_project + tier2_list_scenes to orient. Drill into individual scenes via tier2_read_scene.`,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      switch (name) {
        case 'tier2_read_project':
          return jsonResult(await readProject(scopeRoot))
        case 'tier2_list_scenes':
          return jsonResult(await listScenes(scopeRoot))
        case 'tier2_read_scene':
          return jsonResult(await readScene(scopeRoot, String((args as { sceneId?: unknown })?.sceneId ?? '')))
        case 'tier2_read_scene_html': {
          const html = await readSceneHtml(scopeRoot, String((args as { sceneId?: unknown })?.sceneId ?? ''))
          return textResult(html ?? '(no rendered HTML)')
        }
        case 'tier2_list_assets':
          return jsonResult(await listAssets(scopeRoot))
        default:
          return errorResult(`Unknown tool: ${name}`)
      }
    } catch (err) {
      return errorResult(formatError(err))
    }
  })

  return server
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

function formatError(err: unknown): string {
  if (err instanceof DreambyteFsError) return `[${err.code}] ${err.message}`
  if (err instanceof PathEscapeError) return `[OUT_OF_SCOPE] ${err.message}`
  return (err as Error)?.message ?? String(err)
}

async function main(): Promise<void> {
  const scopeRoot = await resolveScopeRoot()
  const server = buildServer(scopeRoot)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`dreambyte-tier2-mcp: ready (root=${scopeRoot})\n`)
}

main().catch((err) => {
  process.stderr.write(`dreambyte-tier2-mcp: fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
