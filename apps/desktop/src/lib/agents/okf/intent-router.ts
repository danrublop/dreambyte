/**
 * OKF Intent Router.
 *
 * `routeOKF(brief)` turns the structured ProjectBrief (the "compass")
 * into a concrete OKFLoadPlan: which craft rule packs,
 * which execution lanes, and the pacing profile to use for THIS video. The
 * context-builder consumes the plan to deterministically inject the right
 * knowledge — replacing the old fuzzy `matchHints()`-on-raw-prompt selection with
 * routing off structured intent.
 *
 * PURE FUNCTION — no I/O, no side effects. The CALLER (context-builder) is
 * responsible for actually loading the referenced rule packs from disk
 * (`.claude/skills/dreambyte/rules/*.md`) and tolerating a missing file.
 *
 * Craft principles informed by Daniel Mace's filmmaking tutorials. The 1:30 pacing formula, 3-act shape, and lane gating below
 * encode that method.
 */
import type { ProjectBrief } from '../../types/project'

/** Canonical OKF craft rule-pack ids. These map 1:1 to
 *  `.claude/skills/dreambyte/rules/<id>.md`. Exported so the loader and tests
 *  reference the same source of truth (no string drift). */
// Only technical packs exist, routable on-demand via get_routed_craft. Renderer craft
// reaches a builder from PLAN STATE (prompts.ts SCENE_TYPE_GUIDANCE, not a pack), and
// the model owns aesthetics.
export const OKF_RULE_PACKS = {
  audio: 'audio',
  three: 'three',
  research: 'research',
  generation: 'generation',
} as const

export interface PacingActBudget {
  role: 'impact' | 'communicate' | 'persuade'
  targetSec: number
}

export interface PacingProfile {
  /** 3-act for longform (Mace's 1:30 formula); single-act-fast for shortform. */
  shape: '3-act' | 'single-act-fast'
  /** The runtime we're pacing to (brief.runtimeTargetSec or a per-type default). */
  totalTargetSec: number
  /** Seconds available to grab the viewer before they bounce. Tiny for shortform. */
  hookWindowSec: number
  /** Act budgets in seconds (empty for single-act-fast). */
  acts: PacingActBudget[]
  /** How densely beats/cuts are packed. Shortform = tight; podcast/film = relaxed. */
  beatDensity: 'tight' | 'standard' | 'relaxed'
}

export interface OKFLoadPlan {
  /** Craft rule-pack ids to inject (rules/*.md), in injection order. */
  rulePacks: string[]
  /** Boolean lanes that gate craft routing. Only the two that still route a pack
   *  survive the design cut; footage/branding/narration lanes were removed with
   *  their packs (nothing consumed them). */
  lanes: {
    avatarSequencing: boolean
    mediaSourcing: boolean
  }
  pacingProfile: PacingProfile
}

/** Default runtime (seconds) when the brief leaves runtimeTargetSec null. */
function defaultRuntimeSec(brief: ProjectBrief): number {
  if (brief.lengthClass === 'shortform') return 30
  switch (brief.videoType) {
    case 'explainer':
    case 'educational':
      return 90
    case 'marketing':
      return 60
    case 'professional':
    case 'podcast':
    case 'film':
      return 120
    default:
      return 60
  }
}

/**
 * Derive the pacing profile from type + length + runtime. Longform follows Mace's
 * 1:30 formula (impact 5-7s → communicate → persuade); shortform collapses to a
 * single fast act with a 1-2s hook window.
 */
export function derivePacingProfile(brief: ProjectBrief): PacingProfile {
  const total = brief.runtimeTargetSec && brief.runtimeTargetSec > 0 ? brief.runtimeTargetSec : defaultRuntimeSec(brief)

  if (brief.lengthClass === 'shortform') {
    return {
      shape: 'single-act-fast',
      totalTargetSec: total,
      hookWindowSec: 2,
      acts: [],
      beatDensity: 'tight',
    }
  }

  // Longform 3-act: impact ≤7s (Mace's 5-7s grab), persuade ~20%, communicate the rest.
  const impact = Math.max(5, Math.min(7, Math.round(total * 0.1)))
  const persuade = Math.max(5, Math.round(total * 0.2))
  const communicate = Math.max(5, total - impact - persuade)

  const beatDensity: PacingProfile['beatDensity'] =
    brief.videoType === 'podcast' || brief.videoType === 'film' ? 'relaxed' : 'standard'

  return {
    shape: '3-act',
    totalTargetSec: total,
    hookWindowSec: Math.min(30, impact + 3), // hook lands inside the first ~30s
    acts: [
      { role: 'impact', targetSec: impact },
      { role: 'communicate', targetSec: communicate },
      { role: 'persuade', targetSec: persuade },
    ],
    beatDensity,
  }
}

/** One rule file's routing surface (structurally matches load-rule-packs'
 *  RulePackIndexEntry). Passing the index into routeOKF keeps routeOKF PURE. */
export interface RuleTagEntry {
  id: string
  tags: string[]
}

/** Injection-order priority of routing tags (lowest index = injected first). */
const TAG_PRIORITY = ['core', 'lane:media', 'lane:avatar']

/** Derive the craft-routing lanes from the brief. Pure + exported. */
export function deriveLanes(brief: ProjectBrief): OKFLoadPlan['lanes'] {
  return {
    avatarSequencing: brief.isAvatarCentric,
    mediaSourcing: brief.mediaStrategy.research || brief.mediaStrategy.stock || brief.mediaStrategy.generate,
  }
}

/**
 * The routing TAGS this brief requires. A craft file whose frontmatter `tags`
 * intersect this set gets injected. `core` is always required (story/pacing/audio);
 * the rest gate on lanes / grade / format. Pure + exported for the parity tests.
 */
export function deriveRequiredTags(brief: ProjectBrief): string[] {
  const lanes = deriveLanes(brief)
  // core (audio) always; production lanes gate on the brief. Renderer craft is NOT
  // routed here — it reaches a builder from plan state (prompts.ts SCENE_TYPE_GUIDANCE).
  const tags = ['core']
  if (lanes.mediaSourcing) tags.push('lane:media')
  if (lanes.avatarSequencing) tags.push('lane:avatar')
  return tags
}

/**
 * Select rule-pack ids from the bundle index whose tags intersect the required
 * set, ordered deterministically (highest-priority matching tag first, then id).
 * Data-driven: a NEW file tagged `core`/`lane:*` routes itself with no
 * code change here. Pure + exported.
 */
export function selectRulePacksByTags(required: string[], index: RuleTagEntry[]): string[] {
  const req = new Set(required)
  const rank = (e: RuleTagEntry): number => {
    let best = TAG_PRIORITY.length
    for (const t of e.tags) {
      const i = TAG_PRIORITY.indexOf(t)
      if (i >= 0 && i < best) best = i
    }
    return best
  }
  return index
    .filter((e) => e.tags.some((t) => req.has(t)))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((e) => e.id)
}

/** Hardcoded rule-pack selection — the FALLBACK used when no bundle index is
 *  supplied (pure unit tests, or a bundle that can't be read). Tag-routing
 *  (selectRulePacksByTags) reproduces this set; the parity test guards that. */
function rulePacksHardcoded(_brief: ProjectBrief, lanes: OKFLoadPlan['lanes']): string[] {
  // core=audio always; mirrors deriveRequiredTags so tag-routing == fallback
  // (parity test guards this).
  const rulePacks: string[] = [OKF_RULE_PACKS.audio]
  if (lanes.mediaSourcing) rulePacks.push(OKF_RULE_PACKS.research)
  if (lanes.avatarSequencing) rulePacks.push(OKF_RULE_PACKS.generation)
  return rulePacks
}

/**
 * Route a ProjectBrief to its OKFLoadPlan. Pure + deterministic — same brief in,
 * same plan out (asserted by the table-driven tests across every type × format ×
 * driver combination).
 *
 * When `opts.ruleIndex` is supplied (the bundle's frontmatter tag index, loaded
 * by the caller via loadRulePackIndex), rule packs are selected DATA-DRIVEN by tag
 * intersection — so new/refined packs route off their own frontmatter with no code
 * change. Without it, the hardcoded fallback is used (tests / unreadable bundle).
 */
export function routeOKF(brief: ProjectBrief, opts?: { ruleIndex?: RuleTagEntry[] }): OKFLoadPlan {
  const lanes = deriveLanes(brief)

  const rulePacks =
    opts?.ruleIndex && opts.ruleIndex.length > 0
      ? selectRulePacksByTags(deriveRequiredTags(brief), opts.ruleIndex)
      : rulePacksHardcoded(brief, lanes)

  return {
    rulePacks,
    lanes,
    pacingProfile: derivePacingProfile(brief),
  }
}
