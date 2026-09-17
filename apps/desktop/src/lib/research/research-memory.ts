import 'server-only'
import { createLogger } from '@/lib/logger'
import { embedText } from './embed'
import { findRelevantNotes, insertResearchNote } from '@/lib/db/queries/research-notes'
import { harvestFromToolCalls, selectCitedMedia, dedupeSources, type HarvestedSource } from './harvest'
import { ingestDirect } from '@/lib/services/ingest'
import type { ToolCallRecord } from '@/lib/agents/types'

/**
 * Research memory orchestrator (server-only). Two entry points bracket a research
 * sub-agent run:
 *   buildPriorResearchPreamble  — before dispatch: semantic-reuse prior notes.
 *   persistAndStageResearch     — after the brief: stage cited media, persist the note.
 * Kept out of subagent-dispatch's static imports (dynamic-imported there) so the
 * unit tests for dispatch never pull `server-only` / the embedder / the db.
 */

const log = createLogger('research.memory')
const MAX_STAGED = 6
const PRIOR_TOP_K_BRIEF_CHARS = 1500

/**
 * Render this project's persisted research as a grounding block for the SCENE-BUILDING
 * sub-agents (director + fan-out), which run with `history: []` and therefore never see
 * the parent's research tool-results. The most-recent note's brief already carries the
 * facts AND a "Staged assets" block (asset ids), so one block grounds the build in real
 * names/dates/events + places real media. Empty when the project has no research yet.
 */
export async function renderResearchGrounding(projectId: string | undefined): Promise<string> {
  if (!projectId) return ''
  try {
    // null embedding → findRelevantNotes degrades to most-recent fresh notes (rankNotes),
    // which is exactly "this project's research so far" for grounding.
    const notes = await findRelevantNotes(projectId, null, Date.now())
    const brief = (notes[0]?.brief ?? '').slice(0, 3000).trim()
    if (!brief) return ''
    return (
      `\n\n## Researched facts — GROUND every scene in these\n` +
      `Build from the real names / dates / events below; do NOT invent or rely on training memory. ` +
      `Staged research images are auto-placed into bare scenes for you; staged VIDEOS are not — place those with set_video_layer(assetId).\n\n` +
      brief
    )
  } catch (e) {
    log.warn(`renderResearchGrounding failed: ${(e as Error)?.message ?? e}`)
    return ''
  }
}

export async function buildPriorResearchPreamble(
  projectId: string,
  task: string,
): Promise<{ preamble: string; taskEmbedding: number[] | null }> {
  const taskEmbedding = await embedText(task)
  const prior = await findRelevantNotes(projectId, taskEmbedding, Date.now())
  if (!prior.length) return { preamble: '', taskEmbedding }
  const body = prior.map((n) => `### ${n.topic}\n${n.brief.slice(0, PRIOR_TOP_K_BRIEF_CHARS)}`).join('\n\n')
  const preamble =
    `\n\n## Prior research (from earlier runs on this project — EXTEND or reuse it, ` +
    `do NOT redo the same searches from scratch)\n${body}`
  return { preamble, taskEmbedding }
}

interface StagedAsset {
  id: string
  name: string
  sourceUrl?: string
  type: 'image' | 'video'
}

const STAGE_FLOOR = 3

/** Stage the media found in a run's tool calls with NO brief to cite from — used
 *  for the inline-research path (parent researched without dispatching an Explore).
 *  Falls back to the top harvested media via STAGE_FLOOR. */
export async function stageMediaFromToolCalls(projectId: string, toolCalls: ToolCallRecord[]): Promise<StagedAsset[]> {
  return stageMedia(projectId, '', toolCalls)
}

async function stageMedia(projectId: string, briefText: string, toolCalls: ToolCallRecord[]): Promise<StagedAsset[]> {
  const { media } = harvestFromToolCalls(toolCalls)
  const cited = selectCitedMedia(media, briefText, MAX_STAGED)
  // Robust to a stub/truncated brief: the model cited too few (e.g. it hit its
  // tool-call cap and never wrote a Media section), so top up with the top
  // harvested media so found images still LAND. A good brief (cited ≥ floor)
  // keeps the model's picks untouched — cited relevance > harvest order.
  const picks =
    cited.length >= STAGE_FLOOR
      ? cited
      : [...cited, ...media.filter((m) => !cited.includes(m))].slice(0, Math.max(STAGE_FLOOR, cited.length))
  const staged: StagedAsset[] = []
  for (const hit of picks) {
    try {
      const { asset } = await ingestDirect({
        url: hit.directUrl,
        projectId,
        name: hit.title,
        tags: ['research', hit.type],
      })
      staged.push({ id: asset.id, name: asset.name, sourceUrl: hit.sourceUrl, type: hit.type })
    } catch (e) {
      // Best-effort: a 404 / non-media / SSRF-rejected URL is skipped, run continues.
      log.warn(`stageMedia skipped ${hit.directUrl}: ${(e as Error)?.message ?? e}`)
    }
  }
  return staged
}

function stagedAssetsBlock(staged: StagedAsset[]): string {
  if (!staged.length) return ''
  const line = (s: StagedAsset) => `- \`${s.id}\` — ${s.name}${s.sourceUrl ? ` (source: ${s.sourceUrl})` : ''}`
  const images = staged.filter((s) => s.type === 'image')
  const videos = staged.filter((s) => s.type === 'video')
  // Images are auto-placed into bare scenes by landResearchMedia (internal reuse_asset
  // by id — the agent has no by-id place tool: place_image needs a url + geometry). A
  // stock/archival VIDEO stays agent-driven: set_video_layer(assetId) with layout context.
  const parts = ['\n\n## Staged assets (downloaded into the project library)']
  if (images.length)
    parts.push('Images — already auto-placed into bare scenes; reference these facts:\n' + images.map(line).join('\n'))
  if (videos.length) parts.push('Videos — place with set_video_layer(assetId):\n' + videos.map(line).join('\n'))
  return parts.join('\n')
}

/**
 * Stage the media the brief cited, APPEND a "Staged assets" block (never mutate the
 * model's text), and persist the note (best-effort). Sources are the UNION of the
 * harvested web_search results (DeepSeek/Kimi/local path) and the native citations
 * (frontier Inherit path) — the two are complementary, draining one misses the other.
 * Returns the brief with the appended block.
 */
export async function persistAndStageResearch(opts: {
  projectId: string
  task: string
  brief: string
  toolCalls: ToolCallRecord[]
  nativeSources: HarvestedSource[]
  taskEmbedding: number[] | null
}): Promise<string> {
  const { projectId, task, brief, toolCalls, nativeSources, taskEmbedding } = opts
  const { sources } = harvestFromToolCalls(toolCalls)
  const allSources = dedupeSources([...sources, ...nativeSources])
  const staged = await stageMedia(projectId, brief, toolCalls)
  const finalBrief = brief + stagedAssetsBlock(staged)
  // Only persist a note we can actually reuse. A null embedding (embedder still
  // downloading / unavailable) would be stored with embedModel=null and is then
  // PERMANENTLY ineligible for semantic reuse (rankNotes filters it out) even after
  // the embedder recovers — a poison row. Skip it; the media still staged above.
  if (taskEmbedding) {
    await insertResearchNote({
      projectId,
      topic: task,
      brief: finalBrief,
      sources: allSources,
      assetIds: staged.map((s) => s.id),
      embedding: taskEmbedding,
    })
  } else {
    log.warn('research note not persisted: embedder unavailable — note would be unreusable')
  }
  return finalBrief
}
