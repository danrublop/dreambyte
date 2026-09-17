/**
 * Director loop.
 *
 * The fan-out orchestrator this replaced built each scene in its OWN isolated,
 * deep-cloned world: scene N's builder never saw scenes 1…N-1's real code — only a
 * prose hand-off. That structural isolation was the root cause of "seamly" output:
 * every scene re-invented the visual language.
 *
 * The director loop inverts it. ONE scene-maker agent holds the WHOLE video in a single
 * context and builds every beat IN ORDER within that one conversation — so scene N SEES
 * scenes 1…N-1's actual code in its own history and can match palette / type scale /
 * motion / motifs so the cut reads as one film. Measurement (§4a: median ~7K tok/scene)
 * shows the common 3–10 scene case fits one context with large headroom, so no index or
 * delta protocol is needed here.
 *
 * It is the ONLY build path: takes OrchestratorOptions, returns SubAgentResult[]
 * (it replaced a blind per-scene fan-out).
 * All the load-bearing scaffolding — pinned-id scene shells,
 * project-style auto-load, the corrective pass, and the cross-scene consistency /
 * continuity scans — still lives in orchestrator.ts and is shared with the scoped
 * sub-agent fix path.
 */

import { randomUUID } from 'crypto'

import type { Scene } from '../types'
import { scanForFlow } from '../generation/flow-scan'
import { selectProjectStyle, buildStyleIntent } from '../skills/distill'
import type { SkillContent } from '../skills/types'
import type { AgentType, ScenePlan, SceneSpec } from './types'
import { runScopedSubAgent } from './subagent-dispatch'
import { scanCrossSceneContinuity } from './cross-scene-continuity'
import { collectSceneCode } from './tool-executor'
import { renderStoryboardBlock } from './storyboard'
import { getSceneTypeGuidance } from './prompts'
import { resolveProjectDimensions } from '../dimensions'
import { imageryFloorWarnings } from './imagery-floor'
import { hasRunnableImageProvider } from '../media/provider-registry'
import {
  type OrchestratorOptions,
  type SubAgentResult,
  ensureSceneShells,
  buildActiveToolsForSceneType,
  buildTaskPacket,
  evaluateAcceptance,
  overflowIssueFor,
  runScopedSceneFix,
  CORRECTIVE_MAX_PARALLEL,
  SUB_AGENT_TIMEOUT_MS,
  checkCrossSceneConsistency,
  buildSceneSelectionTrace,
  formatSelectionTrace,
  selectSkillsForScene,
} from './orchestrator'

// Per-scene budgets for the SINGLE director agent — it must build the whole video in
// one run, so its caps scale with scene count (the fan-out's per-scene caps of 15
// iterations / 50 tool calls are for one scene each). Floors keep a 1–2 scene build
// from being starved.
const DIRECTOR_ITERATIONS_PER_SCENE = 12
const DIRECTOR_TOOL_CALLS_PER_SCENE = 40
const DIRECTOR_MIN_ITERATIONS = 20
const DIRECTOR_MIN_TOOL_CALLS = 60
// One corrective pass over any scene the director left unverified/unmet.
const MAX_CORRECTIVE_PASSES = 1

/** Same content-detection the fan-out builder uses, plus reactCode (the product default
 *  renderer). "Has content" ≠ "verified" — verifyPassed below is the separate signal. */
function sceneHasContent(scene: Scene | undefined): boolean {
  if (!scene) return false
  const s = scene as Scene & { reactCode?: string; chartLayers?: unknown[] }
  return (
    !!s.reactCode ||
    !!scene.svgContent ||
    !!scene.canvasCode ||
    !!scene.sceneCode ||
    !!scene.lottieSource ||
    (scene.aiLayers?.length ?? 0) > 0 ||
    (scene.svgObjects?.length ?? 0) > 0 ||
    (s.chartLayers?.length ?? 0) > 0
  )
}

/**
 * The whole-video shot list handed to the director. Unlike the fan-out's per-scene
 * TaskPacket, this lists EVERY beat in order with its pinned scene id, so the one agent
 * knows the full film and which concrete id to write each beat into. The instruction is
 * the coherence lever: build in order, SEE prior scenes in context, MATCH their look.
 */
/**
 * The director builds every renderer type inside ONE context, so it needs the SAME
 * renderer craft the fan-out injects into each per-scene sub-agent — but as a single
 * DEDUPED union across all beats, not the per-beat renderer NAME the shot list already
 * carries. Two sources feed it, both keyed on committed plan state, no model in the loop:
 *
 *  1. the library skill guides `selectSkillsForScene` resolves (base renderer + bridges),
 *     mirroring assembleScenePrompt's framing so both build paths teach the same thing;
 *  2. the per-renderer `SCENE_TYPE_GUIDANCE` block — the 3D SDK index, the chart-tool
 *     rules, the Canvas2D drawing API. A fan-out builder gets that block from
 *     `buildSceneMakerPrompt(focusedSceneType)` (orchestrator passes `planned.sceneType`);
 *     the director, which is one agent for every type, never sets focusedSceneType, so it
 *     was the ONLY build path receiving none of it. A 3D beat saw "Renderer: three" and a
 *     legacy vanilla-JS skill, and guessed the rest of the SDK.
 *
 * `react` is skipped deliberately: SCENE_AUTHORING_CONTRACT already carries the React
 * contract into every builder's prompt, so injecting it again is pure duplication.
 *
 * ONE source per renderer, chosen by state: the fan-out gets the block through
 * focusedSceneType, the director gets it here, and neither ever gets it twice.
 * Returns '' when nothing applies (an all-react plan with no distilled style).
 * Exported for a unit check.
 */
export function renderDirectorSkillGuides(
  scenes: SceneSpec[],
  projectStyle: SkillContent | null,
  dims?: { width: number; height: number },
): string {
  const seen = new Set<string>()
  const blocks: string[] = []
  const renderers = new Set<string>()
  for (const planned of scenes) {
    const { guides, bridges, projectStyle: style } = selectSkillsForScene(planned, projectStyle)
    renderers.add(planned.sceneType)
    for (const b of bridges) renderers.add(b.metadata.sceneType)
    for (const g of guides) {
      if (seen.has(g.metadata.id)) continue
      seen.add(g.metadata.id)
      blocks.push(
        style && g.metadata.id === style.metadata.id
          ? `\n\n## Project style — ${g.metadata.name}\nThis distilled style was learned from a related project and applies to the WHOLE build. Honour its palette, fonts, and feel across every beat.\n\n${g.guide}`
          : `\n\n## Loaded skill — ${g.metadata.name}\nThis ${g.metadata.sceneType} skill is already loaded for you — follow it.\n\n${g.guide}`,
      )
    }
  }
  const guidance = getSceneTypeGuidance(dims)
  for (const type of [...renderers].sort()) {
    if (type === 'react' || !guidance[type]) continue
    blocks.push(`\n\n## Layer Generation Rules (${type})\n\n${guidance[type]}`)
  }
  return blocks.join('')
}

/**
 * Render the user's OWN provided assets into a prompt block so "use the assets you were
 * given" is actionable (empty string when none were provided → nothing injected). Pure.
 */
export function buildProvidedAssetsNote(world: import('./world-state').WorldStateMutable): string {
  const refs = world.referenceMedia ?? []
  const assets = world.projectAssets ?? []
  if (refs.length === 0 && assets.length === 0) return ''
  const lines: string[] = ['', "## The user's own assets — they provided these on purpose; use them"]
  if (refs.length > 0) {
    const names = refs.map((r) => (r as { name?: string; id: string }).name || r.id).slice(0, 8)
    lines.push(
      `- Reference media (${refs.length}): ${names.join(', ')}. Incorporate/match these rather than building around them.`,
    )
  }
  if (assets.length > 0) {
    lines.push(
      `- Media library has ${assets.length} asset(s) — find them with media_library(action:'query') and reuse (place_image with the returned url) before generating new imagery.`,
    )
  }
  return lines.join('\n')
}

export function buildDirectorPrompt(
  scenePlan: ScenePlan,
  sceneMap: Map<number, Scene>,
  projectStyleNote: string,
  loadedSkillsBlock = '',
  providedAssetsNote = '',
): string {
  const beats = scenePlan.scenes.map((planned, i) => {
    const id = sceneMap.get(i)?.id ?? planned.id ?? '(unassigned)'
    const parts: string[] = [
      `### Beat ${i + 1}/${scenePlan.scenes.length} — "${planned.name}"  (scene id: ${id})`,
      `- Purpose: ${planned.purpose}`,
      `- Renderer: ${planned.sceneType} · Build to fit ~${planned.duration}s — do NOT pad with long static holds (dead air); only extend to fit narration you add.${planned.transition ? ` · Transition in: ${planned.transition}` : ''}`,
    ]
    // Hard visual-form directive — the committed form (art-directed at plan time) tells
    // the builder EXACTLY what to make; a 'chart' beat built as styled text fails the
    // build-time acceptance check and gets rebuilt. This is what stops data/real-subject
    // beats from defaulting to text.
    const formDirective: Record<string, string> = {
      chart: `- VISUAL FORM = CHART: build a REAL chart (call chart / use the D3 bridge), NOT numbers styled as text. The data belongs in a chart.`,
      imagery: `- VISUAL FORM = IMAGERY: place a real or AI-generated photo/clip (generate_image / find_media + place_image / generate_veo3_video). Do NOT substitute CSS shapes for a real subject.`,
      diagram: `- VISUAL FORM = DIAGRAM: build a diagram (nodes/edges/flow via SVG or D3), not a paragraph.`,
      '3d': `- VISUAL FORM = 3D: build a spatial scene via <ThreeJSLayer>.`,
      stat: `- VISUAL FORM = STAT: one hero number, animated (count-up) with visual weight (ring/fill/bar) — not a bare figure floating in text.`,
      text: `- VISUAL FORM = TEXT: kinetic typography is the hero here (this beat is a quote/headline, not data or a real subject).`,
    }
    if (planned.visualForm && formDirective[planned.visualForm]) parts.push(formDirective[planned.visualForm])
    if (planned.visualElements) parts.push(`- Key visuals: ${planned.visualElements}`)
    // Surface the plan's OWN narration/audio/chart so the director transcribes them
    // rather than improvising (or forgetting) — the fan-out's buildTaskPacket did
    // this per scene; the director prompt did not, so narration was never authored
    // during the build (the "silent documentary" defect).
    if (planned.narrationDraft)
      parts.push(`- Narration — call add_narration with THIS exact text: "${planned.narrationDraft}"`)
    if (planned.audioNotes) parts.push(`- Audio cues: ${planned.audioNotes}`)
    if (planned.mediaLayers)
      parts.push(
        `- Media: ${planned.mediaLayers} — GENERATE it (generate_image / generate_veo3_video) or place a stock/library clip; do NOT fake photographic/rendered imagery with CSS.`,
      )
    if (planned.chartSpec)
      parts.push(`- Chart — call chart: ${planned.chartSpec.type} — ${planned.chartSpec.dataDescription}`)
    if (planned.cameraMovement)
      parts.push(
        `- Camera: ${planned.cameraMovement} — realize it EITHER in-code (interpolate a container translate + scale off the frame clock) OR by calling set_camera_motion for this scene. Either satisfies the motion requirement.`,
      )
    if (planned.carriedElements?.length)
      parts.push(`- Carry these motifs forward from the previous beat: ${planned.carriedElements.join(', ')}`)
    if (planned.handoffToNext)
      parts.push(
        `- Hand off to the next beat via ${planned.handoffToNext.type}${planned.handoffToNext.note ? ` — ${planned.handoffToNext.note}` : ''}.`,
      )
    const storyboard = renderStoryboardBlock(planned.storyboard)
    if (storyboard) parts.push(storyboard)
    return parts.join('\n')
  })

  return [
    `You are the DIRECTOR of ONE video: "${scenePlan.title}". You hold the ENTIRE video in this`,
    `single context and you will build every beat yourself, IN ORDER, so it reads as one`,
    `continuous film — not a pile of unrelated slides.`,
    ``,
    ...(scenePlan.approach?.trim()
      ? [`## The approach (the through-line to honor across every beat)`, scenePlan.approach.trim(), ``]
      : []),
    `There are ${scenePlan.scenes.length} beats. For EACH beat, in order:`,
    `  1. Write the scene with write_scene_code targeting that beat's exact scene id (listed below).`,
    `  2. Verify it with verify_scene before moving on.`,
    `  3. Then build the next beat.`,
    ``,
    `COHERENCE IS YOUR JOB. You can SEE every scene you have already built earlier in this`,
    `conversation — reuse its real palette, type scale, motion idioms, and recurring motifs so`,
    `each new beat continues the same visual language. Do NOT reset to a blank slate between`,
    `beats. Honor each beat's carried motifs and hand-off so the cuts feel connected. Re-read`,
    `this shot list as you go so the whole arc stays in view.`,
    ``,
    `Build ALL ${scenePlan.scenes.length} beats before you finish — every scene id below must end`,
    `with real, verified content.`,
    ``,
    `The plan is ALREADY DONE — it is the shot list below. Do NOT call write_plan, update_todos,`,
    `or plan_scenes; that planning pass is finished. Start building beat 1 immediately.`,
    ``,
    `EVERY beat must MOVE — a static held frame reads as a slideshow and is rejected. Give each`,
    `scene time-driven motion: interpolate a camera translate + scale off the frame clock, drive`,
    `element transforms from the clock, or call set_camera_motion. A camera move set via`,
    `set_camera_motion counts as motion even if the rest of the scene code is otherwise still.`,
    ``,
    `VARIETY WITHIN ONE LANGUAGE — this is the #1 complaint. Coherence means a shared palette,`,
    `type scale, and recurring motifs; it does NOT mean the same layout and the same camera move`,
    `on every beat. The failure to avoid: every scene is a headline the camera pans across`,
    `("static text, swipe right, more text"). Instead:`,
    `  • Give each beat a DISTINCT composition from its shot list — full-bleed photo/video, a`,
    `    chart/diagram, a split layout, a centered hero object, a tight close-up, a wide spatial`,
    `    shot. Don't default every beat to "big headline + label".`,
    `  • VARY the motion — a slow push, a whip-pan, a scale-up, a parallax reveal, a rack-focus,`,
    `    a hold-with-live-detail. Don't reuse one camera move down the whole video.`,
    `  • Build what the shot list calls for: when a beat names Media (imagery) or a chart, generate/`,
    `    place the image or clip and author the chart rather than substituting CSS text. When the`,
    `    plan is deliberately minimal/text-only, honor that — variety of TYPOGRAPHY and motion then`,
    `    carries it. Match the video to the plan and the prompt; don't force imagery onto a spare piece.`,
    providedAssetsNote,
    projectStyleNote,
    loadedSkillsBlock,
    ``,
    `## Shot list`,
    ...beats,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n')
}

export async function runDirectorLoop(opts: OrchestratorOptions): Promise<SubAgentResult[]> {
  const { scenePlan, parentWorld, parentOpts, emit, logger } = opts
  const totalScenes = scenePlan.scenes.length
  const results: SubAgentResult[] = []

  logger.log('director', `Starting director loop: ${totalScenes} scenes in ONE whole-video context`, {
    sceneNames: scenePlan.scenes.map((s) => s.name),
  })

  // Shared scaffolding — identical to the fan-out path so neither can diverge.
  const sceneMap = ensureSceneShells(scenePlan, parentWorld, logger)

  const projectStyle = selectProjectStyle(
    buildStyleIntent({
      title: scenePlan.title,
      styleNotes: scenePlan.styleNotes,
      scenes: scenePlan.scenes.map((s) => ({ name: s.name, purpose: s.purpose })),
    }),
  )
  if (projectStyle) {
    logger.log('director', `Auto-loaded distilled style "${projectStyle.metadata.id}" for this build`, {
      styleId: projectStyle.metadata.id,
    })
  }

  // Selection trace — same pre-build SSE block the fan-out emits, so the UI/inspector
  // sees which skill guides apply per scene regardless of build path.
  const selectionTrace = scenePlan.scenes.map((s) => buildSceneSelectionTrace(s, projectStyle))
  emit({ type: 'selection_trace', selectionTrace, message: formatSelectionTrace(selectionTrace) })

  // Announce every beat up front so the progress UI shows the full queue (the fan-out
  // emits sub_agent_start per scene; the director emits them all, then ONE build runs,
  // then a sub_agent_complete per scene from the merged results below).
  const subAgentIds = scenePlan.scenes.map(() => randomUUID().slice(0, 8))
  scenePlan.scenes.forEach((planned, i) => {
    emit({
      type: 'sub_agent_start',
      subAgentId: subAgentIds[i],
      subAgentSceneIndex: i,
      subAgentTotal: totalScenes,
      subAgentSceneName: planned.name,
    })
  })

  // Whole-video toolset: the single agent builds many renderer types, so offer the
  // UNION of each scene type's tool categories (the fan-out scopes each sub-agent to
  // one type). buildActiveToolsForSceneType returns categories the context-builder
  // expands into concrete tools.
  const toolCategories = new Set<string>()
  for (const s of scenePlan.scenes) {
    for (const cat of buildActiveToolsForSceneType(s.sceneType, parentOpts.activeTools, scenePlan.featureFlags)) {
      toolCategories.add(cat)
    }
  }

  // Scope: the director owns exactly the beats it was DISPATCHED to build — the pinned
  // ids in sceneMap — and nothing else.
  //
  // On a WHOLE-video build every scene in the world is a beat, so this list is empty and
  // executeTool's guard stays off: unchanged behaviour, and the director can still write
  // all of them. On a PARTIAL build — a 3-beat plan dispatched inside a 20-scene project
  // — the other 17 are foreign, and the guard now stops the director from rewriting or
  // deleting work it was never asked to touch. The delete case was the worse of the two:
  // delete_scene succeeded inside the sub-agent's CLONED world, the merge below writes
  // only the pinned beats back, so the scene reappeared in the parent world — an agent
  // reporting a deletion that never happened. It is now a clear tool error instead.
  //
  // Side effect, deliberate: with a non-empty scope the runner refuses review(scope:'cut') for
  // this agent (runner.ts — a scene-scoped builder doesn't review the whole cut). A
  // partial director isn't building the whole cut, so that is the correct verdict; the
  // whole-video path keeps its review because its scope stays empty.
  const dispatchedSceneIds = new Set([...sceneMap.values()].map((s) => s.id))
  const scopeForeignSceneIds = parentWorld.scenes.map((s) => s.id).filter((id) => !dispatchedSceneIds.has(id))

  // One agent, one budget: the whole run's remaining spend (NOT split per scene — there
  // is only one agent). The shared cost ledger stays the hard run-wide ceiling.
  const remainingBudgetUsd = opts.costLedger
    ? Math.max(0, opts.costLedger.capUsd - opts.costLedger.spentUsd)
    : opts.maxRunCostUsd != null && Number.isFinite(opts.maxRunCostUsd)
      ? Math.max(0, opts.maxRunCostUsd - (opts.parentCostUsd ?? 0))
      : undefined

  const projectStyleNote = projectStyle
    ? `\nProject style in effect: "${projectStyle.metadata.name}" — apply it consistently across every beat.`
    : ''
  // Inject the renderer/bridge/style skill guide BODIES (deduped union across beats) —
  // the same guides the fan-out sub-agents get, which the director prompt previously
  // dropped (it only named the renderer per beat). See renderDirectorSkillGuides.
  const loadedSkillsBlock = renderDirectorSkillGuides(
    scenePlan.scenes,
    projectStyle,
    resolveProjectDimensions(parentOpts.mp4Settings?.aspectRatio, parentOpts.mp4Settings?.resolution),
  )
  // Surface the user's OWN assets so "use the assets you were given" points at real state
  // (adaptivity: rich input → align + use it). Empty string when none were provided.
  const providedAssetsNote = buildProvidedAssetsNote(parentWorld)
  const prompt = buildDirectorPrompt(scenePlan, sceneMap, projectStyleNote, loadedSkillsBlock, providedAssetsNote)

  // Wall-clock backstop, the same discipline buildSceneWithTimeout gives every fan-out
  // builder. Without it the director ran on a bare runScopedSubAgent: one provider call
  // that never returns parks the WHOLE build inside a single `await` forever, where the
  // iteration and tool-call counters — the only other limiters — cannot advance to catch
  // it, and the cost ledger never moves because a stalled call bills nothing.
  //
  // The bound scales with beats rather than reusing SUB_AGENT_TIMEOUT_MS blind: that
  // constant budgets ONE scene, and the director builds all of them in one call, so a
  // flat 5 minutes would guillotine a healthy 6-beat build. Per beat it gets exactly what
  // a fan-out builder gets for its single scene, so the two paths allow the same
  // wall-clock per scene. Like the fan-out's, this is a BACKSTOP against a hang, not the
  // primary limiter (that is the iteration/tool caps and the ledger, which all return
  // normally when hit).
  const directorTimeoutMs = SUB_AGENT_TIMEOUT_MS * Math.max(1, totalScenes)
  const directorAbort = new AbortController()
  const timer = setTimeout(() => directorAbort.abort(), directorTimeoutMs)
  const onParentAbort = () => directorAbort.abort()
  parentOpts.abortSignal?.addEventListener('abort', onParentAbort, { once: true })
  let result: Awaited<ReturnType<typeof runScopedSubAgent>>
  try {
    result = await runScopedSubAgent({
      agentType: 'scene-maker' as AgentType,
      prompt,
      activeTools: Array.from(toolCategories),
      parentWorld,
      // Composed signal: the timeout fires it, and a parent abort still cascades.
      parentOpts: { ...parentOpts, abortSignal: directorAbort.signal },
      emit,
      logger,
      subAgentId: `director-${randomUUID().slice(0, 8)}`,
      label: `director: ${scenePlan.title}`,
      scopeForeignSceneIds,
      budgetUsd: remainingBudgetUsd,
      costLedger: opts.costLedger,
      maxIterations: Math.max(DIRECTOR_MIN_ITERATIONS, totalScenes * DIRECTOR_ITERATIONS_PER_SCENE),
      maxToolCalls: Math.max(DIRECTOR_MIN_TOOL_CALLS, totalScenes * DIRECTOR_TOOL_CALLS_PER_SCENE),
      selectedSceneId: null,
      sceneContext: 'all',
    })
  } finally {
    clearTimeout(timer)
    parentOpts.abortSignal?.removeEventListener('abort', onParentAbort)
  }

  // Merge the director's built scenes back into the parent world by pinned id, and
  // synthesize one SubAgentResult per beat (the runner + corrective pass consume this
  // shape). Abort guard mirrors the fan-out: don't land a scene if the parent cancelled.
  const parentAborted = !!parentOpts.abortSignal?.aborted
  // The director hit its wall-clock backstop (not a user cancel). The runner RETURNS a
  // partial world on an abort rather than throwing, so without this the half-built cut
  // would ship on whatever verify verdicts happened to exist — a stale pass captured
  // before the stall. Mirrors the fan-out's `timedOut` handling in buildSceneWithSubAgent.
  const directorTimedOut = !parentAborted && directorAbort.signal.aborted
  if (directorTimedOut) {
    logger.warn('director', `Director timed out after ${Math.round(directorTimeoutMs / 1000)}s — partial cut`)
    emit({
      type: 'token',
      token: `\n\n⚠ The director hit its ${Math.round(directorTimeoutMs / 60_000)} min time limit before finishing the video — landing what it built and attempting fixes.`,
    })
  }

  // Merge the director's TIMELINE back too. add_track/place_clip are deliberately left
  // available to sub-agents and the builder prompt points at them for timeline audio, but
  // this merge only ever carried `scenes` — so a director that followed that instruction
  // produced a SILENT MP4 and reported success. Present only when a timeline tool actually
  // ran (runAgent's carry-out gate), so an untouched clone can't clobber the parent's.
  if (!parentAborted && result.updatedTimeline) {
    parentWorld.timeline = result.updatedTimeline
    logger.log('director', 'Merged director timeline into parent world', {
      trackCount: result.updatedTimeline.tracks?.length ?? 0,
    })
  }

  scenePlan.scenes.forEach((planned, i) => {
    const pinnedId = sceneMap.get(i)?.id
    const built = result.updatedScenes.find((s) => s.id === pinnedId)

    if (!parentAborted && built && sceneHasContent(built)) {
      const worldIdx = parentWorld.scenes.findIndex((s) => s.id === built.id)
      if (worldIdx !== -1) parentWorld.scenes[worldIdx] = built
      else parentWorld.scenes.push(built)
      logger.log('director', `Merged scene "${planned.name}" into parent world`, { sceneId: built.id })
    }

    const success = sceneHasContent(built)

    // verify-as-contract: read the director's OWN last verify_scene verdict for this
    // scene id (the same signal the fan-out reads from its sub-agent).
    const verifyCalls = result.toolCalls.filter(
      (tc) => tc.toolName === 'verify_scene' && (tc.input as { sceneId?: string })?.sceneId === pinnedId,
    )
    const lastVerify = verifyCalls[verifyCalls.length - 1]
    const verifyPassed = lastVerify ? lastVerify.output?.success === true : undefined
    const verifyIssues = ((lastVerify?.output?.data as { issues?: string[] } | undefined)?.issues ?? []).filter(
      (x): x is string => typeof x === 'string',
    )

    // Machine-checked acceptance — objective, independent of what the director claimed.
    const unmetCriteria = built
      ? evaluateAcceptance(buildTaskPacket(planned).checks, built)
      : buildTaskPacket(planned).checks.map((c) => c.label)
    // Fold known text overflow (durable state, survives the fire-once advisory) so
    // a scene shipped with overflow gets a guaranteed corrective shot instead of
    // shipping the defect when the run hits its iteration cap.
    const overflowIssue = overflowIssueFor(parentWorld, built?.id)
    if (overflowIssue) unmetCriteria.push(overflowIssue)
    // A timed-out run's beats are unfinished by definition — force them unverified so the
    // corrective pass re-dispatches them instead of shipping a stale pass.
    if (directorTimedOut) unmetCriteria.push('director timed out before finishing the video')

    results.push({
      sceneIndex: i,
      sceneName: planned.name,
      success,
      sceneId: built?.id,
      // Usage is reported once for the whole director run (attributed to beat 0) so the
      // parent's aggregate stays exact without double-counting one run across N results.
      usage: i === 0 ? result.usage : { inputTokens: 0, outputTokens: 0, apiCalls: 0, costUsd: 0, totalDurationMs: 0 },
      toolCalls: i === 0 ? result.toolCalls : [],
      error: success ? undefined : 'Director produced no content for this scene',
      verifyPassed: directorTimedOut ? false : verifyPassed,
      verifyIssues,
      unmetCriteria,
    })

    emit({
      type: 'sub_agent_complete',
      subAgentId: subAgentIds[i],
      subAgentSceneIndex: i,
      subAgentTotal: totalScenes,
      subAgentSceneName: planned.name,
      subAgentSuccess: success,
    })
    if (success && built?.id) {
      emit({
        type: 'preview_update',
        sceneId: built.id,
        changes: [{ type: 'scene_updated', sceneId: built.id, description: `Director built "${planned.name}"` }],
      })
      emit({
        type: 'state_change',
        changes: [{ type: 'scene_updated', sceneId: built.id, description: `Director built "${planned.name}"` }],
      })
    }
  })

  // ── Composite verify ────────────────────────────────────────────
  // Watch the finished cut as ONE film: sample motion + transition-boundary frames
  // across the whole video and fold real cross-scene defects into the corrective pass
  // below. This is the temporal check the per-scene verify can't do (a jarring cut, a
  // motif that fails to carry). Honest-skip when no reviewer is wired (headless/tests)
  // — the director never treats "couldn't review" as a clean pass.
  if (!parentAborted && opts.reviewCut) {
    const reviewable = results.filter((r) => r.success && r.sceneId)
    if (reviewable.length >= 2) {
      try {
        const brief = await opts.reviewCut(
          reviewable.map((r) => {
            const scene = parentWorld.scenes.find((s) => s.id === r.sceneId)
            return {
              sceneId: r.sceneId!,
              name: r.sceneName,
              durationSec: scene?.duration ?? scenePlan.scenes[r.sceneIndex]?.duration ?? 2,
            }
          }),
        )
        if (!brief.reviewable) {
          emit({ type: 'token', token: `\n\n⚠ Composite verify skipped: ${brief.note ?? 'not reviewable'}` })
        } else {
          if (brief.summary) emit({ type: 'token', token: `\n\n🎬 Composite verify: ${brief.summary}` })
          // Fold high/medium scene-mapped findings into that scene's unmet criteria so
          // the corrective pass (below) fixes them; cut-wide findings surface as a token.
          for (const f of brief.findings) {
            const issue = `cut ${f.kind} (${f.severity}): ${f.detail}`
            const target = f.sceneId ? results.find((r) => r.sceneId === f.sceneId) : undefined
            if (target && (f.severity === 'high' || f.severity === 'medium')) {
              target.unmetCriteria = [...(target.unmetCriteria ?? []), issue]
            } else if (!f.sceneId) {
              emit({ type: 'token', token: `\n  - ${issue}` })
            }
          }
        }
      } catch (err) {
        emit({
          type: 'token',
          token: `\n\n⚠ Composite verify failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // ── Corrective pass ───────────────────────────────────────────────────────
  // The director self-verifies inline, but a scene it left unverified or that missed a
  // machine-checked acceptance criterion still gets ONE focused fix, through the
  // shared runScopedSceneFix primitive.
  // Correctives run in bounded parallel (CORRECTIVE_MAX_PARALLEL), unlike the build
  // itself, which is strictly sequential so each beat sees its predecessors' real
  // code. Correctives don't hand off to each other and each pins a
  // DISTINCT scene id, so they're independent — the atomic ledger reserve inside
  // runScopedSceneFix keeps concurrent dispatch from overshooting the cost cap. This
  // is ⑥'s speed lever: the review pass no longer serializes one 220s fix after another.
  let cumulativeCostUsd = result.usage.costUsd
  for (let pass = 0; pass < MAX_CORRECTIVE_PASSES; pass++) {
    if (parentOpts.abortSignal?.aborted) break

    const fixable = results
      .filter((r) => r.success && r.sceneId && (r.verifyPassed !== true || (r.unmetCriteria?.length ?? 0) > 0))
      .map((r) => ({
        r,
        planned: scenePlan.scenes[r.sceneIndex],
        scene: parentWorld.scenes.find((s) => s.id === r.sceneId),
      }))
      .filter(
        (x): x is { r: SubAgentResult; planned: (typeof scenePlan.scenes)[number]; scene: Scene } =>
          !!x.planned && !!x.scene,
      )

    let stop = false
    for (let i = 0; i < fixable.length && !stop; i += CORRECTIVE_MAX_PARALLEL) {
      if (parentOpts.abortSignal?.aborted) break
      const chunk = fixable.slice(i, i + CORRECTIVE_MAX_PARALLEL)
      const outcomes = await Promise.all(
        chunk.map(({ r, planned, scene }) =>
          runScopedSceneFix({
            sceneId: r.sceneId!,
            sceneIndex: r.sceneIndex,
            sceneName: r.sceneName,
            planned,
            existingScene: scene,
            priorIssues: [...(r.verifyIssues ?? []), ...(r.unmetCriteria ?? [])],
            parentWorld,
            parentOpts,
            featureFlags: scenePlan.featureFlags,
            emit,
            logger,
            costLedger: opts.costLedger,
            maxRunCostUsd: opts.maxRunCostUsd,
            parentCostUsd: opts.parentCostUsd,
            priorCumulativeCostUsd: cumulativeCostUsd,
            projectStyle,
            totalScenes,
          }).then((outcome) => ({ r, outcome })),
        ),
      )

      for (const { r, outcome } of outcomes) {
        // Once a fix is skipped over-cap the ledger is at its ceiling; stop dispatching
        // more chunks (remaining fixes would each self-skip cheaply anyway).
        if (outcome.skippedOverCap) stop = true
        cumulativeCostUsd += outcome.costUsd

        if (outcome.applied && outcome.fix) {
          r.verifyPassed = outcome.fix.verifyPassed
          r.verifyIssues = outcome.fix.verifyIssues
          r.unmetCriteria = outcome.fix.unmetCriteria
          r.toolCalls = [...r.toolCalls, ...outcome.fix.toolCalls]
          r.usage = {
            inputTokens: r.usage.inputTokens + outcome.fix.usage.inputTokens,
            outputTokens: r.usage.outputTokens + outcome.fix.usage.outputTokens,
            apiCalls: r.usage.apiCalls + outcome.fix.usage.apiCalls,
            costUsd: r.usage.costUsd + outcome.fix.usage.costUsd,
            totalDurationMs: r.usage.totalDurationMs + outcome.fix.usage.totalDurationMs,
          }
        }
      }
    }
  }

  // Honest surfacing: after the (bounded) corrective pass, some scenes may still
  // carry unmet criteria — the run can exhaust its iteration/round cap before
  // every fix lands (the "shipped 6/8 with known overflow, hit the cap, shipped
  // anyway" defect). Name those scenes and their residual issues instead of
  // letting them ship silently green.
  const residual = results
    .filter((r) => r.success && r.sceneId && (r.unmetCriteria?.length ?? 0) > 0)
    .map((r) => `  - "${r.sceneName}": ${(r.unmetCriteria ?? []).join('; ')}`)
  if (residual.length > 0) {
    emit({
      type: 'token',
      token: [
        `\n\n⚠ ${residual.length} scene(s) still have unresolved issues after the corrective pass (the run may have hit its limit before fixing them):`,
        ...residual,
      ].join('\n'),
    })
  }

  // ── Cross-scene consistency + continuity (SOFT signals, shared with fan-out) ──
  const consistencyIssues = checkCrossSceneConsistency(parentWorld.scenes, scenePlan, results)
  if (consistencyIssues.length > 0) {
    emit({
      type: 'token',
      token: [
        '\n\n⚠ Cross-scene consistency check:',
        ...consistencyIssues.map((issue) => `  - ${issue}`),
        'Consider fixing these in the polish phase.',
      ].join('\n'),
    })
  }

  const builtSceneIds = new Set(results.filter((r) => r.success && r.sceneId).map((r) => r.sceneId))
  const builtScenes = parentWorld.scenes.filter((s) => builtSceneIds.has(s.id))
  try {
    const continuity = scanCrossSceneContinuity(builtScenes, {
      hasMotion: (scene) =>
        scanForFlow(collectSceneCode(scene), { hasCameraMotionTrack: (scene.cameraMotion?.length ?? 0) > 0 })
          .hasCameraMove,
    })
    if (continuity.warnings.length > 0) {
      emit({
        type: 'token',
        token: ['\n\n⚠ Cross-scene continuity:', ...continuity.warnings.map((w) => `  - ${w}`)].join('\n'),
      })
    }
  } catch (err) {
    logger.warn('director', 'Cross-scene continuity scan failed (soft signal — ignored)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Imagery floor: the plan wanted pictures but no image provider was configured and
  // nothing got placed → tell the user honestly instead of shipping a silent CSS-only
  // video (see imagery-floor.ts). Deterministic keys-absent slice only.
  const ms = parentOpts.projectBrief?.mediaStrategy
  const wantImagery =
    scenePlan.scenes.some((s) => (s.mediaLayers ?? '').trim().length > 0) ||
    !!(ms?.stock || ms?.generate || ms?.research)
  // Land research media (B+C): stage anything the parent found via inline research,
  // and auto-place a staged research image if imagery was wanted but none got placed.
  // Runs BEFORE the imagery floor so a successful place makes that warning go quiet.
  try {
    const { landResearchMedia } = await import('../research/land-media')
    await landResearchMedia({
      world: parentWorld,
      toolCalls: opts.researchToolCalls ?? [],
      builtScenes,
      wantImagery,
      preferredSceneId: builtScenes[0]?.id,
      logger,
      emit,
    })
  } catch (e) {
    logger.warn('director', 'landResearchMedia failed (non-fatal)', { error: String(e) })
  }
  for (const w of imageryFloorWarnings({
    plannedScenes: scenePlan.scenes,
    // Re-read from parentWorld.scenes: landResearchMedia's reuse_asset places images via
    // updateScene, which REPLACES the world.scenes slot with a new object — the `builtScenes`
    // snapshot still holds the pre-placement refs, so scanning it would fire a false
    // "CSS-only, no imagery" warning right after we successfully placed the photos.
    builtScenes: parentWorld.scenes.filter((s) => builtSceneIds.has(s.id)),
    hasImageGen: hasRunnableImageProvider(parentOpts.mediaGenEnabled),
    missingKeyHint: 'FAL_KEY or OPENAI_API_KEY',
    briefWantsImagery: !!(ms?.stock || ms?.generate || ms?.research),
  })) {
    emit({ type: 'token', token: `\n\n⚠ ${w}` })
  }

  const succeeded = results.filter((r) => r.success).length
  logger.log('director', `Director loop complete: ${succeeded}/${totalScenes} scenes built`)
  return results
}
