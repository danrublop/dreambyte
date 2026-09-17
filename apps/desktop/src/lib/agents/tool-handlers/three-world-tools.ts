import fs from 'fs/promises'
import path from 'path'
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, type ToolResult } from './_shared'

/**
 * Resolve the origin used when handing model / asset URLs back to the agent.
 * `DREAMBYTE_APP_URL_BASE` is set by `src/electron/main.ts` for both packaged and
 * dev:desktop flows; we no longer fall back to `localhost:3000` since there
 * is no HTTP server in any supported desktop flow.
 */
function assetBaseUrl(): string {
  const override = process.env.DREAMBYTE_APP_URL_BASE
  if (override) return override.endsWith('/') ? override.slice(0, -1) : override
  return process.env.NEXT_PUBLIC_BASE_URL || 'dreambyte://app'
}

type CatalogueModel = {
  id: string
  name: string
  category: string
  file: string
  tags: string[]
  description: string
  scale: number
}
type ModelCatalogue = { models: CatalogueModel[]; categories: Record<string, unknown> }
let _modelCatalogue: ModelCatalogue | null = null

async function getModelCatalogue(): Promise<ModelCatalogue> {
  if (_modelCatalogue) return _modelCatalogue
  const cataloguePath = path.join(process.cwd(), 'public/models/library/index.json')
  const raw = await fs.readFile(cataloguePath, 'utf-8')
  _modelCatalogue = JSON.parse(raw) as ModelCatalogue
  return _modelCatalogue
}

// search_3d_models / search_lottie are internal ops: tool-executor routes
// find_media(kind:'3d' | 'lottie') here. They have no schema of their own.

// ── Handler Factory ──────────────────────────────────────────────────────────

export function createThreeWorldToolHandler(deps: {
  regenerateHTML: (world: WorldStateMutable, sceneId: string, logger?: AgentLogger) => Promise<{ htmlWritten: boolean }>
}) {
  return async function handleThreeWorldTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    switch (toolName) {
      // ── search_3d_models ─────────────────────────────────────────────────
      case 'search_3d_models': {
        try {
          const catalogue = await getModelCatalogue()
          const query = ((args.query as string) || '').toLowerCase()
          const categoryFilter = args.category as string | undefined

          const results = catalogue.models.filter(
            (m: { id: string; name: string; tags: string[]; description: string; category: string }) => {
              if (categoryFilter && m.category !== categoryFilter) return false
              const searchable = `${m.id} ${m.name} ${m.tags.join(' ')} ${m.description}`.toLowerCase()
              return query.split(/\s+/).every((word: string) => searchable.includes(word))
            },
          )

          if (results.length === 0) {
            return ok(
              null,
              `No 3D models found for "${args.query}". Available categories: ${Object.keys(catalogue.categories).join(', ')}`,
            )
          }

          const baseUrl = assetBaseUrl()
          const formatted = results.map(
            (m: {
              id: string
              name: string
              category: string
              file: string
              tags: string[]
              description: string
              scale: number
            }) => ({
              id: m.id,
              name: m.name,
              category: m.category,
              url: `${baseUrl}/models/library/${m.file}`,
              tags: m.tags,
              description: m.description,
              scale: m.scale,
            }),
          )

          return ok(null, `Found ${results.length} model(s) matching "${args.query}"`, formatted)
        } catch {
          return ok(null, 'Model library not available — index.json not found')
        }
      }

      // ── search_lottie ────────────────────────────────────────────────────
      case 'search_lottie': {
        const { query, category, limit } = args as { query: string; category?: string; limit?: number }
        try {
          const { searchLottie } = await import('@/lib/services/lottie')
          const data = await searchLottie({
            query,
            category: (category as Parameters<typeof searchLottie>[0]['category']) ?? null,
            limit: limit ?? 5,
          })
          // Add usage hints to each result
          const resultsWithHints = data.results.map((r) => ({
            ...r,
            usageHint: {
              motionScene: `DreambyteMotion.lottieSync('#lottie-wrap', { src: '${r.url}', tl: window.__tl, delay: 0.3 })`,
              reactScene: `<LottieLayer data="${r.url}" />`,
            },
          }))
          return { success: true, affectedSceneId: null, data: { ...data, results: resultsWithHints } }
        } catch (e) {
          return {
            success: false,
            error: `Lottie search error: ${String(e)}`,
          }
        }
      }

      // ── world_scene ──────────────────────────────────────────────────────
      // One tool, one `op`. op:'create' builds the world (what create_world_scene
      // did); every other op is a targeted edit of an existing one (what
      // update_world_scene did). The single-item ops read objects[0] / panels[0]
      // rather than re-declaring the descriptor shapes in the schema.
      // world_scene DELETED (zero calls across 1,051 recorded tool calls; 4,781b of schema).

      default:
        return err(`Unknown three/world tool: ${toolName}`)
    }
  }
}
