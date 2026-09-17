import type { ToolResult } from '@/lib/agents/types'
import type { RunExportClientAction } from '@/lib/agents/client-action'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { getExportJob } from '@/lib/agents/export-jobs'
import { scanScenePlanForRedundancy } from '@/lib/agents/cross-scene-continuity'
import { deriveStoryboard, type StoryboardBeat } from '@/lib/agents/storyboard'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.planning-export')

export const PLANNING_EXPORT_TOOL_NAMES = [
  'plan_scenes',
  // `export` is the MODEL-facing name; the export_mp4 case below is its mp4 path and
  // get_export_status is reached as get_status(kind:'export') — both routed in
  // tool-executor, so neither needs a registry entry of its own.
  'export',
  // publish_interactive is GONE. It lost its schema, so executeTool's gate
  // answered "Unknown tool" before dispatch could ever reach the honest refusal
  // below — a refusal nobody could trigger. Re-add it (schema + handler) only
  // when the publish client-action round-trip actually lands.
] as const

interface PlannedScene {
  id?: string
  name: string
  purpose: string
  /** Not in the tool schema — every scene is react and the handler hardcodes it. Kept
   *  optional so a legacy/echoed plan that still sends one doesn't fail the cast. */
  sceneType?: string
  duration: number
  transition?: string
  narrationDraft?: string
  visualElements?: string | string[]
  /** The committed visual form (chart|imagery|diagram|3d|stat|text) — routes the renderer
   *  and drives the build-time chart/imagery acceptance check. Required in the schema;
   *  defaulted to 'text' here defensively so a malformed call can't crash the plan. */
  visualForm?: 'chart' | 'imagery' | 'diagram' | '3d' | 'stat' | 'text'
  /** Optional author-provided shot list; when absent plan_scenes derives one. */
  storyboard?: StoryboardBeat[]
  audioNotes?: string
  chartSpec?: Record<string, unknown>
  mediaLayers?: string
  cameraMovement?: string
  // Explicit continuity (optional; positional fallback when absent).
  handoffToNext?: { type?: string; note?: string }
  carriedElements?: string[]
}

/**
 * Plan-time VISUAL coverage gate — ADAPTIVE, not rigid. A script art-directed as
 * styled text on every scene is a failure ONLY when the video actually wants imagery.
 * So the imagery nudge is gated on the (now-honest, see extract-project-brief.ts)
 * project brief: it fires only when the brief says imagery is wanted AND the brief is
 * confident enough to trust. No brief / a deliberately-minimal brief / a low-confidence
 * sparse brief → NO imagery nudge (an intentionally text-only piece is a valid choice,
 * not a defect). The chart nudge stays data-driven (numbers with no chart) and gentle.
 * Nudges only — never blocks. Pure + exported for planning-export-tools.test.ts.
 */
export function assessVisualCoverage(
  scenes: PlannedScene[],
  brief?: import('@/lib/types/project').ProjectBrief | null,
): string[] {
  const warnings: string[] = []
  const n = scenes.length
  if (n === 0) return warnings
  const hasChart = (s: PlannedScene) =>
    !!s.chartSpec && (!!(s.chartSpec as any).type || !!(s.chartSpec as any).dataDescription)
  const withMedia = scenes.filter((s) => !!s.mediaLayers && s.mediaLayers.trim().length > 0).length
  const withChart = scenes.filter(hasChart).length

  // Imagery is WANTED only when the brief says so and we trust the brief. A minimal/
  // text-only intent (extractor now honors it → mediaStrategy all-false), a missing
  // brief, or a low-confidence sparse guess all mean "don't push imagery".
  const ms = brief?.mediaStrategy
  const imageryWanted =
    !!brief && !!ms && (ms.stock || ms.generate || ms.research || ms.userAssets) && (brief.confidence ?? 1) >= 0.5

  // The text-poster case — but only nudge when imagery was actually wanted for this video.
  if (imageryWanted && n >= 3 && withMedia === 0 && withChart === 0) {
    warnings.push(
      `This plan grounds no scene in imagery (mediaLayers empty) or a chart, and its brief wants real imagery — consider giving real-subject beats a photo/clip (mediaLayers) and number beats a chart, so it doesn't read as a flat text slideshow. If a minimal text-only look is intended, ignore this.`,
    )
  }

  // Per-beat: quantitative narration/visuals but no chart. Data-driven, brief-agnostic, gentle.
  const numTokens = (s: PlannedScene): number => {
    const ve = Array.isArray(s.visualElements) ? s.visualElements.join(' ') : s.visualElements || ''
    const text = `${s.narrationDraft || ''} ${ve}`
    return (text.match(/\d+(?:[.,]\d+)?%?/g) || []).length
  }
  const dataBeats = scenes.filter((s) => !hasChart(s) && numTokens(s) >= 3).map((s) => s.name)
  if (dataBeats.length > 0) {
    warnings.push(
      `${dataBeats.length} number-heavy beat(s) have no chart: ${dataBeats.slice(0, 4).join(', ')}${dataBeats.length > 4 ? '…' : ''}. Numbers usually read better as a chart than styled text — consider chartSpec (skip if the beat is intentionally not quantitative).`,
    )
  }
  return warnings
}

export function createPlanningExportToolHandler() {
  return async function handlePlanningExportTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'plan_scenes': {
        const { title, approach, scenes, totalDuration, styleNotes, featureFlags } = args as {
          title: string
          approach?: string
          scenes: PlannedScene[]
          totalDuration: number
          styleNotes?: string
          featureFlags?: Record<string, boolean>
        }

        // ── Re-plan drift guard: carry stable ids forward ────────────────────
        // A scene's `id` is the stable handle the orchestrator pins a built scene
        // to (the pre-created shell's id derives from it). But when the agent
        // RE-plans, it resends fresh scenes with no `id`, so a naive
        // `id || randomUUID()` mints a brand-new id every time — the built scene
        // then can't be re-found by id, and matchScenePlanToScenes falls back to
        // name/position matching that drifts (renamed → duplicate shell; reordered
        // → wrong-scene edit). Reconcile each incoming scene to the PRIOR plan and
        // reuse its id when they clearly correspond (explicit id echo → exact name
        // → position among still-unclaimed prior scenes). A renamed-but-
        // corresponding scene thus keeps its id and its already-built content;
        // only a genuinely new scene mints a fresh id.
        const priorScenes = (world.scenePlan?.scenes ?? []) as Array<{ id?: string; name?: string }>
        const claimedPriorIds = new Set<string>()
        const carryForwardId = (incoming: PlannedScene, index: number): string => {
          if (incoming.id) return incoming.id // explicit echo — trust it
          const nm = incoming.name?.toLowerCase() ?? ''
          const byName = priorScenes.find(
            (p) => p.id && !claimedPriorIds.has(p.id) && (p.name?.toLowerCase() ?? '') === nm,
          )
          if (byName?.id) {
            claimedPriorIds.add(byName.id)
            return byName.id
          }
          const byIndex = priorScenes[index]
          if (byIndex?.id && !claimedPriorIds.has(byIndex.id)) {
            claimedPriorIds.add(byIndex.id)
            return byIndex.id
          }
          return crypto.randomUUID()
        }

        const storyboardWarnings: string[] = []
        const adjustedScenes = scenes.map((s, i) => {
          let duration = s.duration
          if (s.narrationDraft) {
            const wordCount = s.narrationDraft.split(/\s+/).filter(Boolean).length
            const narrationFloor = Math.round(wordCount / 2.5 + 3)
            // Take the larger of the agent's deliberate duration and the narration floor:
            // extend for dense VO, never shrink a duration the agent set on purpose. Note
            // the [6,30] clamp below still caps the result — so a very dense narration
            // (floor > 30s) or a user-asked <6s/>30s scene is bounded to the per-scene
            // range (a pacing guardrail; the router promises exactness only WITHIN it).
            duration = Math.max(duration || 0, narrationFloor)
          }
          duration = Math.max(6, Math.min(30, duration))
          // Storyboard as a REQUIRED artifact (Lane 1 — quality by construction):
          // always attach a shot list, deriving one from the narration when the
          // agent didn't author explicit beats, so no scene reaches a builder
          // without stations for the camera to travel. See src/lib/agents/storyboard.ts.
          // Author-provided beats are kept in full; a DERIVED split that hits the cap
          // surfaces a warning (never silent) instead of dropping beats. (③.6)
          const storyboard = deriveStoryboard(
            {
              storyboard: s.storyboard,
              narrationDraft: s.narrationDraft,
              visualElements: s.visualElements,
              purpose: s.purpose,
              name: s.name,
            },
            (msg) => storyboardWarnings.push(`Scene "${s.name ?? i + 1}": ${msg}`),
          )
          return {
            ...s,
            id: carryForwardId(s, i),
            // Every scene is react now — normalize any stray/legacy value so a
            // bad sceneType can't propagate into the plan or scene-builders.
            sceneType: 'react',
            // visualForm is schema-required, but default defensively so a malformed
            // call (or a legacy plan) can't crash the build — 'text' is the safe floor.
            visualForm: s.visualForm ?? 'text',
            duration,
            storyboard,
          }
        })

        const adjustedTotal = adjustedScenes.reduce((sum, s) => sum + s.duration, 0)

        // Plan-time REDUNDANCY gate: catch duplicate/near-identical
        // beats the moment the plan is made — BEFORE the agent builds two of the
        // same scene (a top original failure mode). High-precision soft guidance;
        // never blocks. (Scene-type diversity nudges were dropped — every scene
        // is 'react' now; variety is a FLOW/bridge concern checked elsewhere.)
        const redundancy = scanScenePlanForRedundancy(adjustedScenes)
        const warningList: string[] = redundancy.warnings.length > 0 ? [...redundancy.warnings] : []
        if (storyboardWarnings.length > 0) warningList.push(...storyboardWarnings)
        // Visual-coverage gate (adaptive): nudge imagery only when the brief wants it.
        warningList.push(...assessVisualCoverage(adjustedScenes, world.projectBrief))

        // Surface a re-plan that changes the scene SET after a prior plan existed,
        // so the agent/user knows which built work is kept vs orphaned. Not a block.
        if (priorScenes.length > 0) {
          const priorIds = new Set(priorScenes.map((p) => p.id).filter(Boolean))
          const kept = adjustedScenes.filter((s) => priorIds.has(s.id)).length
          const added = adjustedScenes.length - kept
          const dropped = priorScenes.length - kept
          if (added > 0 || dropped > 0) {
            warningList.push(
              `Re-planned over an existing ${priorScenes.length}-scene plan: ${kept} scene(s) keep their built content, ${added} new, ${dropped} dropped. ` +
                `Scenes matched by name/position keep their work; a dropped scene's built content stays until you delete_scene it.`,
            )
          }
        }
        const warnings: string[] | undefined = warningList.length > 0 ? warningList : undefined

        const scenePlan = {
          title,
          approach,
          scenes: adjustedScenes,
          totalDuration: adjustedTotal,
          styleNotes,
          featureFlags,
        }

        ;(world as any).scenePlan = scenePlan

        // Return a CONFIRMATION, not the plan. This used to echo the entire
        // `scenePlan` — ~9.6kB / 2.4k tokens for six beats — straight back to the
        // model that had just authored it, and tool results live in conversation
        // history, so that echo was re-sent on every subsequent turn of the run.
        // Keep only what the model cannot re-derive from its own call:
        //   • the minted scene `id`s (needed to echo on a re-plan so built work survives)
        //   • the duration the handler ACTUALLY stored (narration floor + 6–30s clamp)
        //   • the storyboard beat count (derived here, never authored)
        //   • warnings (redundancy / coverage / re-plan diffs)
        // The plan itself lives in world.scenePlan and is re-injected into the
        // system prompt (## Scene plan), so nothing downstream reads it from here.
        // A string[] — an array of OBJECTS is collapsed to "[N items]" by the
        // runner's tool-result summarizer, which would eat the ids.
        const sceneLines = adjustedScenes.map((s, i) => {
          const authored = scenes[i]?.duration
          const dur =
            authored != null && authored !== s.duration ? `${s.duration}s (was ${authored}s)` : `${s.duration}s`
          const beats = Array.isArray(s.storyboard) ? `, ${s.storyboard.length} beats` : ''
          return `[${i + 1}] ${s.id} · "${s.name}" · ${s.visualForm} · ${dur}${beats}`
        })

        return {
          success: true,
          affectedSceneId: null,
          changes: [],
          data: {
            message:
              `ScenePlan "${title}" stored — ${adjustedScenes.length} scenes, ${adjustedTotal}s total. ` +
              `Build from this plan (it is in your system prompt); use these ids when re-planning.`,
            scenes: sceneLines,
            totalDuration: adjustedTotal,
            ...(warnings ? { warnings } : {}),
          },
        }
      }

      case 'export': {
        const {
          format = 'mp4',
          scope = 'project',
          sceneId,
          resolution,
          fps,
          profile,
          burnCaptions,
          outputName,
        } = args as {
          format?: 'mp4' | 'fcpxml' | 'embed'
          scope?: 'project' | 'scene'
          sceneId?: string
          resolution?: '720p' | '1080p' | '4k'
          fps?: number
          profile?: 'fast' | 'quality'
          burnCaptions?: boolean
          outputName?: string
        }
        if (format !== 'mp4' && format !== 'fcpxml' && format !== 'embed') {
          return {
            success: false,
            affectedSceneId: null,
            error: `export: unknown format "${String(format)}" — expected mp4, fcpxml or embed.`,
          }
        }
        // scope is an MP4 concept. FCPXML is a whole-timeline interchange and an embed
        // is a whole-project player; refusing beats silently exporting the wrong thing.
        if (scope === 'scene' && format !== 'mp4') {
          return {
            success: false,
            affectedSceneId: null,
            error: `export: scope:'scene' only applies to format:'mp4'. ${format} is whole-project.`,
          }
        }
        if (scope === 'scene' && !sceneId) {
          return { success: false, affectedSceneId: null, error: "export: scope:'scene' requires sceneId." }
        }
        if (scope === 'scene' && !world.scenes.some((s) => s.id === sceneId)) {
          return { success: false, affectedSceneId: null, error: `export: scene ${sceneId} not found.` }
        }
        // Export-timing guard: an AI video clip generates async (2-10 min) and fills the
        // layer in the background. Exporting BEFORE it finishes bakes a black frame where
        // the clip should be. Refuse (honestly) while any video job is still active so the
        // agent waits instead of shipping a broken render. Best-effort: no projectId (some
        // headless/test worlds) → skip the check rather than block.
        // Only a PIXEL render bakes a half-generated clip into a black frame; an FCPXML
        // interchange references the source file and an embed publishes scene HTML, so
        // the wait only applies to mp4.
        if (format === 'mp4' && world.projectId) {
          try {
            const { listActiveMediaGenerations } = await import('@/lib/db/queries/media-generations')
            const pendingVideos = (await listActiveMediaGenerations(world.projectId)).filter((g) => g.kind === 'video')
            if (pendingVideos.length > 0) {
              return {
                success: false,
                affectedSceneId: null,
                error:
                  `${pendingVideos.length} AI video clip(s) are still generating (2-10 min each). Exporting now would ` +
                  `render them as black frames. Wait for them to finish — get_status(kind:'export') is NOT the check; ` +
                  `re-try export once the clips land (the timeline updates on its own), or remove the pending video ` +
                  `layer(s) if you want to export without them.`,
              }
            }
          } catch (e) {
            // Non-fatal: if the lifecycle table can't be read, don't block a legitimate export.
            log.warn('export pending-video check failed (non-fatal); proceeding with export', { error: e })
          }
        }
        // clientAction triggers the renderer round-trip (export_request -> the renderer
        // fulfils it -> exportResponse). ONE transport for all three formats: the
        // renderer branches on `format`, calling exportVideo / electronAPI.exportFcpxml /
        // publish.run — every one of which already existed and was reachable only from
        // the UI. Typed as the RunExportClientAction contract (export item 10).
        const data: RunExportClientAction = {
          clientAction: 'run_export',
          exportSettings: {
            format,
            resolution: resolution ?? '1080p',
            fps: fps ?? 30,
            ...(profile ? { profile } : {}),
            ...(burnCaptions != null ? { burnCaptions } : {}),
            ...(outputName ? { outputName } : {}),
            ...(scope === 'scene' && sceneId ? { sceneId } : {}),
          },
        }
        const what =
          format === 'fcpxml'
            ? 'Writing FCPXML interchange'
            : format === 'embed'
              ? 'Publishing interactive embed'
              : scope === 'scene'
                ? `Rendering MP4 of scene ${sceneId}`
                : 'Rendering MP4 export'
        return {
          success: true,
          affectedSceneId: null,
          changes: [{ type: 'project_updated', description: what }],
          data,
        }
      }

      case 'get_export_status': {
        const { jobId } = args as { jobId?: string }
        // jobId is REQUIRED. A jobId-less
        // "latest" lookup could resolve to the wrong export when two paths
        // (in-app + MCP) share the global registry — e.g. a re-entrancy-
        // rejected newcomer that immediately errors. The agent always has the
        // jobId from `export`'s result; make it carry it.
        if (!jobId || typeof jobId !== 'string') {
          return {
            success: false,
            affectedSceneId: null,
            error: "get_status(kind:'export') requires a jobId (returned by `export`). Poll with that exact jobId.",
          }
        }
        const job = getExportJob(jobId)
        if (!job) {
          // Honest "no such job" — covers an unknown id AND the empty registry
          // after a main-process restart (the map is in-memory only).
          return {
            success: true,
            affectedSceneId: null,
            changes: [{ type: 'project_updated', description: `No export job found for ${jobId}` }],
            data: { status: 'none', jobId },
          }
        }
        // job.progress is the renderer's PER-SCENE progress (resets 0->100 each
        // scene). Report a monotonic OVERALL percentage so a polling agent
        // doesn't see it jump backwards (e.g. 73% -> 5% -> 80%) across scenes.
        const totalScenes = job.totalScenes && job.totalScenes > 0 ? job.totalScenes : 1
        // Bound currentScene to [1, totalScenes] so a stale/corrupt update can't
        // push the overall percentage past the last scene.
        const currentScene = Math.min(totalScenes, job.currentScene && job.currentScene > 0 ? job.currentScene : 1)
        const sceneProgress = Math.max(0, Math.min(100, job.progress ?? 0))
        // Cap rendering at 99 — reserve 100 for the terminal 'complete' status so
        // a polling agent doesn't see 100% and stop polling while the last scene
        // is still encoding.
        const overallProgress =
          job.status === 'complete'
            ? 100
            : Math.min(99, Math.max(0, Math.round(((currentScene - 1 + sceneProgress / 100) / totalScenes) * 100)))
        // 11b: lead with the failing scene when the error was scene-scoped so
        // the agent can re-generate exactly that scene.
        const errorSceneTag =
          job.status === 'error' && job.errorSceneIndex != null
            ? ` (failed at scene ${job.errorSceneIndex}/${job.totalScenes ?? '?'}${job.errorSceneId ? `, sceneId ${job.errorSceneId}` : ''})`
            : ''
        const description =
          job.status === 'complete'
            ? `Export complete: ${job.outputPath}`
            : job.status === 'error'
              ? `Export failed${errorSceneTag}: ${job.error}`
              : `Export rendering: scene ${currentScene}/${job.totalScenes ?? '?'}, ${overallProgress}% overall`
        return {
          // Honest failure: a render that errored must NOT report success, or an
          // agent keying on result.success tells the user the MP4 rendered when it failed.
          success: job.status !== 'error',
          affectedSceneId: null,
          changes: [{ type: 'project_updated', description }],
          // Override `progress` with the overall percentage (the tool contract
          // promises a 0-100 progress); keep the raw per-scene value as
          // sceneProgress. Also return the bounded currentScene so structured
          // readers never see currentScene > totalScenes.
          data: { ...job, currentScene, progress: overallProgress, sceneProgress },
        }
      }

      default:
        return { success: false, error: `Unknown planning/export tool: ${toolName}` }
    }
  }
}
