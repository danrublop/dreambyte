/**
 * OKF tool handler — the manual door to a craft pack, for both brains.
 *
 * `get_routed_craft` runs `routeOKF` + `loadRulePacks` and returns the routed pacing
 * profile + craft markdown for one pack (or all packs the project's stored brief
 * routes to). It is an ESCAPE HATCH, not the main road: a scene builder's renderer
 * craft is injected from plan state before it ever gets a turn (buildSceneMakerPrompt
 * via focusedSceneType, renderDirectorSkillGuides for the director). An earlier version
 * of this comment claimed the in-app context-builder auto-injected the packs; it never
 * did at any point this file has existed, which is how 31,605 words of craft ended up
 * reachable only through a tool the builder's prompt never named.
 */
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { AspectRatio } from '@/lib/dimensions'
import type { ProjectBrief, MP4Settings } from '@/lib/types/project'
import { okGlobal, err, type ToolResult } from './_shared'
import { routeOKF } from '../okf/intent-router'
import { loadRulePacks, loadRulePackIndex } from '../okf/load-rule-packs'
import { normalizeProjectBrief } from '../extract-project-brief'

export const OKF_TOOL_NAMES = ['get_routed_craft', 'set_aspect_ratio'] as const

const VALID_ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:5']

/**
 * Set the PROJECT's aspect ratio so scenes render at that shape (e.g. 9:16
 * vertical for TikTok). Persists `mp4Settings.aspectRatio` to the DB — the source
 * of truth every render reads via resolveProjectDimensions — and updates the live
 * world so the next scene build uses the new WIDTH/HEIGHT. Call this BEFORE
 * building scenes. The preview canvas reflects it on the next render/refresh.
 */
async function setAspectRatio(args: Record<string, unknown>, world: WorldStateMutable): Promise<ToolResult> {
  const ar = typeof args.aspectRatio === 'string' ? args.aspectRatio : ''
  if (!(VALID_ASPECTS as string[]).includes(ar)) {
    return err(`Invalid aspectRatio "${ar}". Use one of: ${VALID_ASPECTS.join(', ')}.`)
  }
  if (!world.projectId) return err('No active project to set the aspect ratio on.')
  const aspectRatio = ar as AspectRatio
  const next: MP4Settings = {
    resolution: world.mp4Settings?.resolution ?? '1080p',
    fps: world.mp4Settings?.fps ?? 30,
    format: world.mp4Settings?.format ?? 'mp4',
    platformProfileId: world.mp4Settings?.platformProfileId ?? null,
    aspectRatio,
  }
  world.mp4Settings = next
  try {
    const { updateProject } = await import('../../db/queries/projects')
    await updateProject(world.projectId, { mp4Settings: next })
  } catch (e) {
    return err(`Failed to persist aspect ratio: ${e instanceof Error ? e.message : String(e)}`)
  }
  return okGlobal(
    `Project aspect ratio set to ${aspectRatio}. Scenes you build now render at this shape; the preview updates on the next render (or call refresh_state).`,
    { aspectRatio, mp4Settings: next },
  )
}

export function createOkfToolHandler() {
  return async function handleOkfTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    _logger?: AgentLogger,
  ): Promise<ToolResult> {
    if (toolName === 'set_aspect_ratio') return setAspectRatio(args, world)
    if (toolName !== 'get_routed_craft') return err(`okf-tools: unknown tool ${toolName}`)

    // Build from explicit inputs ONLY when the caller supplies `videoType` — the
    // primary routing key. A stray scalar (e.g. only runtimeTargetSec) must NOT
    // suppress the project's stored brief with a default-everything one. Without
    // videoType, fall back to the stored brief. aspectRatio is clamped to the
    // valid enum so a bad value can't mis-derive the short/long lane.
    const useArgs = typeof args.videoType === 'string'

    let brief: ProjectBrief | null = null
    if (useArgs) {
      const aspectRatio =
        typeof args.aspectRatio === 'string' && (VALID_ASPECTS as string[]).includes(args.aspectRatio)
          ? (args.aspectRatio as AspectRatio)
          : '16:9'
      brief = normalizeProjectBrief(args, { aspectRatio })
    } else if (world.projectId) {
      const { getProjectBrief } = await import('../../db/queries/projects')
      brief = await getProjectBrief(world.projectId)
    }

    if (!brief) {
      return okGlobal(
        'No routing inputs and no stored Project Brief. Pass at least { videoType, aspectRatio } (plus any drivers: voiceDriver, hasUploadedFootage, footageHasSpeech, isAvatarCentric, mediaStrategy) to get the routed craft.',
        { craft: '', pacingProfile: null, rulePacks: [] },
      )
    }

    const plan = routeOKF(brief, { ruleIndex: loadRulePackIndex() })
    const pace = plan.pacingProfile
    const acts = pace.acts.length ? pace.acts.map((a) => `${a.role} ~${a.targetSec}s`).join(' · ') : 'one fast act'

    // Single-pack pull: the in-app agent gets a one-line MENU of routed packs and
    // pulls a pack's full rules on demand with { pack }. Serve just that body (a
    // pack not in the routed set is still loadable — loadRulePacks guards id/missing).
    const pack = typeof args.pack === 'string' ? args.pack : ''
    if (pack) {
      const body = loadRulePacks([pack])
      if (!body) {
        return okGlobal(
          `No craft pack "${pack}" found. Routed packs for this video: ${plan.rulePacks.join(', ') || '(none)'}.`,
          { craft: '', pacingProfile: plan.pacingProfile, rulePacks: plan.rulePacks },
        )
      }
      const routed = plan.rulePacks.includes(pack)
      return okGlobal(
        `Craft pack "${pack}"${routed ? '' : ' (not auto-routed for this video, loaded on request)'}. Apply every point — MANDATORY for this video.`,
        {
          pacingProfile: plan.pacingProfile,
          rulePacks: plan.rulePacks,
          lanes: plan.lanes,
          craft: body,
        },
      )
    }

    const craft = loadRulePacks(plan.rulePacks)
    const summary =
      `Routed ${plan.rulePacks.length} craft pack(s) for ${brief.videoType} / ${brief.lengthClass}: ` +
      `${plan.rulePacks.join(', ')}. ` +
      `Pacing: ${pace.shape} · ~${pace.totalTargetSec}s · hook within ${pace.hookWindowSec}s · ${acts}. ` +
      `Apply every point in the returned craft — these are MANDATORY for this video.`

    return okGlobal(summary, {
      pacingProfile: plan.pacingProfile,
      rulePacks: plan.rulePacks,
      lanes: plan.lanes,
      craft,
    })
  }
}
