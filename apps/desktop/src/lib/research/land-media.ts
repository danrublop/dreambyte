import 'server-only'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { projectAssets } from '@/lib/db/schema'
import { createLogger } from '@/lib/logger'
import { harvestFromToolCalls } from './harvest'
import { sceneHasImagery } from '@/lib/agents/imagery-floor'
import type { ToolCallRecord } from '@/lib/agents/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { AgentLogger } from '@/lib/agents/logger'
import type { Scene } from '@/lib/types/scene'

const log = createLogger('research.land-media')

export interface LandResearchMediaResult {
  stagedCount: number
  placed: boolean
  /** How many staged research images were auto-placed into scenes (one per bare scene). */
  placedCount: number
  assetId?: string
  sceneId?: string
}

/**
 * Run-end backstop that makes research-found media actually LAND in the video.
 *
 *   B (stage-on-inline): the parent may research INLINE (find_stock_images /
 *     find_archival_footage without dispatching an Explore), so its media never
 *     reaches persistAndStageResearch. Harvest the parent's OWN tool calls and
 *     stage what it found. A dispatched Explore already staged its finds, and the
 *     parent's toolCalls don't hold the sub-agent's calls, so that path no-ops here.
 *
 *   C (auto-place): nothing auto-places staged media today — the agent must
 *     volunteer reuse_asset and often doesn't, shipping a CSS-only video about an
 *     image-rich subject. When imagery was wanted and no built scene has any,
 *     place the newest staged research IMAGE into a wanted scene via the existing
 *     reuse_asset tool (keyless stock/archival path; needs no image-gen key).
 *
 * Best-effort throughout — a failure here never breaks the run. Runs BEFORE the
 * imagery-floor warning, so a successful place makes that warning correctly go quiet.
 */
export async function landResearchMedia(opts: {
  world: WorldStateMutable
  toolCalls: ToolCallRecord[]
  builtScenes: Scene[]
  wantImagery: boolean
  preferredSceneId?: string
  logger?: AgentLogger
  /** Optional SSE emit so the "found photos but placed none" case is never silent. */
  emit?: (e: { type: 'token'; token: string }) => void
}): Promise<LandResearchMediaResult> {
  const out: LandResearchMediaResult = { stagedCount: 0, placed: false, placedCount: 0 }
  const projectId = opts.world.projectId
  if (!projectId) return out

  // B — stage media the parent found inline.
  try {
    const { media } = harvestFromToolCalls(opts.toolCalls)
    if (media.length > 0) {
      const { stageMediaFromToolCalls } = await import('./research-memory')
      const staged = await stageMediaFromToolCalls(projectId, opts.toolCalls)
      out.stagedCount = staged.length
    }
  } catch (e) {
    log.warn(`inline stage failed: ${(e as Error)?.message ?? e}`)
  }

  // C — auto-place staged research media into the video. The agent rarely volunteers
  // reuse_asset (0 of 119 calls in a real run), so photos stage into the library but never
  // reach the scenes ("got great photos, never added them"). Place one research image into
  // EACH bare scene, round-robin the staged pool, so an image-rich topic isn't shipped CSS-only.
  if (!opts.wantImagery) return out

  let pool: string[] = []
  try {
    const rows = await db
      .select({ id: projectAssets.id, type: projectAssets.type, tags: projectAssets.tags })
      .from(projectAssets)
      .where(eq(projectAssets.projectId, projectId))
      .orderBy(desc(projectAssets.createdAt))
      .limit(50)
    // reuse_asset places image/svg by id; videos need set_video_layer (more layout context),
    // so those stay agent-driven.
    pool = rows
      .filter((r) => (r.type === 'image' || r.type === 'svg') && (r.tags ?? []).includes('research'))
      .map((r) => r.id)
  } catch (e) {
    log.warn(`research asset lookup failed: ${(e as Error)?.message ?? e}`)
  }
  if (!pool.length) return out

  // Only scenes that DON'T already carry imagery — never double-stack a picture, and never
  // let ONE scene's existing image suppress placement in every OTHER bare scene (the old
  // whole-video `some(sceneHasImagery)` gate did exactly that → 0 of 5 placed).
  const bareScenes = opts.builtScenes.filter((s) => !sceneHasImagery(s))
  try {
    const { executeTool } = await import('@/lib/agents/tool-executor')
    for (let i = 0; i < bareScenes.length && pool.length; i++) {
      const assetId = pool[i % pool.length]
      const sceneId = bareScenes[i].id
      const r = await executeTool('reuse_asset', { assetId, sceneId }, opts.world, opts.logger)
      if (r.success) {
        out.placedCount++
        out.placed = true
        if (!out.assetId) {
          out.assetId = assetId
          out.sceneId = sceneId
        }
      } else {
        log.warn(`auto-place reuse_asset failed (scene ${sceneId}): ${r.error}`)
      }
    }
  } catch (e) {
    log.warn(`auto-place threw: ${(e as Error)?.message ?? e}`)
  }

  if (out.placedCount > 0) {
    log.info(`auto-placed ${out.placedCount} research image(s) across ${bareScenes.length} bare scene(s)`)
  } else {
    // Never silent — the "great photos, never added" case gets an honest note.
    log.warn(`found ${pool.length} research image(s) but placed none`)
    opts.emit?.({
      type: 'token',
      token: `\n\n⚠ Found ${pool.length} research image(s) but couldn't place them into any scene.`,
    })
  }
  return out
}
