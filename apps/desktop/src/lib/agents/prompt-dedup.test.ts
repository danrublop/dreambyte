import { describe, it, expect } from 'vitest'
import { buildAgentContext, filterToolsForAgent } from './context-builder'
import { buildSceneMakerPrompt } from './prompts'
import { MEDIA_PROVIDERS } from '../media/provider-registry'
import { AUDIO_PROVIDERS } from '../audio/provider-registry'
import type { GlobalStyle, Scene } from '../types'

/**
 * THE DEDUP GUARD.
 *
 * The 39,873b system prompt was not one fat block — it was five decisions each stated
 * three to five times, in up to three different files. Collapsing them is only safe if
 * the surviving statement is still THERE, and only worth anything if the copies stay
 * gone. A plain `toContain` proves the first half and misses the second; a plain
 * `not.toContain` proves the second and deletes the rule.
 *
 * So this counts. Every row below is a rule that used to be stated N times and is now
 * stated ONCE, at a named home. `expected: 1` fails both ways: at 0 the rule was
 * dropped, at 2+ a copy grew back.
 *
 * One counting test, no per-section suite — the count IS the invariant
 */

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}
const STORE_DEFAULT = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'assets', 'audio', 'video']
const ALL = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))
const SCENES = Array.from({ length: 8 }, (_, i) => ({
  id: `scene-${i + 1}`,
  name: `Scene ${i + 1}`,
  prompt: 'a beat',
  sceneType: 'react',
  duration: 8,
  bgColor: '#000',
  transition: 'none',
  layers: [],
})) as unknown as Scene[]

/** Same keyed, fully-enabled configuration the budget test prices — the honest ruler. */
function withKeys<T>(fn: () => T): T {
  const keys = [...MEDIA_PROVIDERS, ...AUDIO_PROVIDERS]
    .map((p) => (p as { requiresKey?: string }).requiresKey)
    .filter((k): k is string => !!k)
  const saved = new Map(keys.map((k) => [k, process.env[k]]))
  for (const k of keys) process.env[k] = 'dedup-test-key'
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const parentPrompt = () =>
  withKeys(
    () =>
      buildAgentContext(
        'scene-maker',
        {
          agentType: 'scene-maker',
          activeTools: STORE_DEFAULT,
          sceneContext: 'all',
          isSubAgent: false,
          webSearchEnabled: true,
          webFetchEnabled: true,
          mediaGenEnabled: ALL(MEDIA_PROVIDERS.map((p) => p.id)),
          audioProviderEnabled: ALL(AUDIO_PROVIDERS.map((p) => p.id)),
        },
        SCENES,
        GLOBAL_STYLE,
        'Dedup Test',
        'mp4',
      ).systemPrompt,
  )

const count = (haystack: string, needle: RegExp) => (haystack.match(needle) ?? []).length

interface Row {
  rule: string
  /** Where the ONE surviving statement lives. */
  home: string
  /** Sections the copies were deleted from. */
  wasAlsoIn: string
  probe: RegExp
}

/**
 * The probe is a phrase that only the surviving statement can produce. Keep them
 * narrow: a probe that matches incidental prose stops guarding anything.
 */
const COLLAPSED: Row[] = [
  {
    rule: 'verify after every write',
    home: 'ROUTER.md ## Non-negotiables (+ verify_scene’s own description)',
    wasAlsoIn: '## Self-Verification, ## Operating Model, ## Completion Standard',
    probe: /`verify_scene`\)/g,
  },
  {
    rule: 'pass expectedElements to verify_scene',
    home: 'ROUTER.md ## Non-negotiables (+ the verify_scene schema)',
    wasAlsoIn: '## Self-Verification',
    probe: /expectedElements/g,
  },
  {
    rule: 'write_plan is the card, plan_scenes is the spec, call BOTH',
    home: 'prompts.ts ## Plan surface',
    wasAlsoIn: 'context-builder ## Planning Guidance',
    probe: /the structured build spec the scene-builders consume/g,
  },
  // 'skills are discovered with search_skills then load_skill' used to be a row here.
  // The rule is GONE, not deduped: search_skills / load_skill / list_skill_categories
  // were deleted (5 calls in 36 runs against a library selectSkillsForScene already
  // injects from plan state), so both statements went with them.
  {
    rule: 'craft arrives with the work; get_routed_craft is only the escape hatch',
    home: 'ROUTER.md §4',
    wasAlsoIn: '## Skill Library, ## 4 duplicate bullet list, the prose pack menu on the tool',
    probe: /is the escape hatch for a deep-dive topic/g,
  },
  {
    rule: 'default to react; other renderers arrive via bridge components',
    home: 'prompts.ts ## Scene Type Selection',
    wasAlsoIn: '## Variety Awareness, the Skill Catalog footer',
    probe: /\*\*Default to `react` for every new scene\.\*\*/g,
  },
  {
    rule: 'scene-type variety comes from the visual approach, not the sceneType field',
    home: 'context-builder ## Variety Alert (computed from the live mix)',
    wasAlsoIn: '## Variety Awareness (static, and it said the opposite)',
    probe: /variety should come from the visual approach/g,
  },
  {
    rule: 'deterministic randomness: random(seed), never Math.random()',
    home: 'prompts.ts SCENE_AUTHORING_CONTRACT',
    wasAlsoIn: 'sceneTypeGuidanceReact, ## Mulberry32 PRNG Pattern',
    probe: /NEVER use requestAnimationFrame, setTimeout, setInterval, or Math\.random\(\)/g,
  },
  {
    rule: 'end the file with exactly `export default Scene;`',
    home: 'prompts.ts SCENE_AUTHORING_CONTRACT',
    wasAlsoIn: 'sceneTypeGuidanceReact',
    probe: /export default Scene;/g,
  },
  {
    rule: 'narrate every scene, not just the first',
    home: 'prompts.ts ## Audio',
    wasAlsoIn: '— (single home, pinned because it exists for a shipped regression)',
    probe: /Narrate ALL scenes/g,
  },
  {
    rule: 'reuse what is already on the timeline before generating',
    home: 'ROUTER.md §1',
    wasAlsoIn: 'SYSTEM.md ## Software Offload Rules',
    probe: /Never regenerate an\s+asset the library already holds/g,
  },
  {
    rule: 'never claim state a tool has not confirmed',
    home: 'SYSTEM.md ## Hard Boundaries',
    wasAlsoIn: '## Operating Model, ## Software Offload Rules, ## Completion Standard',
    probe: /never simulate a tool result in text/g,
  },
  {
    rule: 'the image→video chain order',
    home: 'context-builder ## Composing a rich media scene',
    wasAlsoIn: '(notes that restated generate_veo3_video / add_music / set_audio_mix)',
    probe: /Chain these in ONE turn, in order/g,
  },
]

describe('system prompt: each collapsed rule survives exactly once', () => {
  const prompt = parentPrompt()

  for (const row of COLLAPSED) {
    it(`states "${row.rule}" once — in ${row.home}`, () => {
      expect(
        count(prompt, row.probe),
        `0 = the rule was DROPPED when the copies in ${row.wasAlsoIn} went away.\n` +
          `2+ = a copy grew back; ${row.home} is the one home.`,
      ).toBe(1)
    })
  }
})

describe('sections whose only remaining home is a tool schema', () => {
  // These were prompt prose that restated a tool's own description word for word. The
  // prose is gone; the tool must still carry the rule, or it is gone entirely.
  const tools = withKeys(() =>
    filterToolsForAgent(
      'scene-maker',
      STORE_DEFAULT,
      ALL(AUDIO_PROVIDERS.map((p) => p.id)),
      ALL(MEDIA_PROVIDERS.map((p) => p.id)),
      undefined,
      true,
      true,
      undefined,
      false,
    ),
  )
  const desc = (name: string) => JSON.stringify(tools.find((t) => t.name === name) ?? {})
  const prompt = parentPrompt()

  it('send_feedback carries the ONCE / PARAPHRASED rule (## Feedback deleted)', () => {
    expect(prompt).not.toContain('## Feedback')
    expect(desc('send_feedback')).toMatch(/ONCE/)
    expect(desc('send_feedback')).toMatch(/PARAPHRASE/)
  })

  it('dispatch_to_branches carries "this ENDS your turn" (delegation bullet deleted)', () => {
    expect(prompt).not.toContain('dispatch_to_branches')
    expect(desc('dispatch_to_branches')).toMatch(/ENDS your turn/)
  })

  it('generate_veo3_video carries async + black-frame (recipe notes deleted)', () => {
    expect(prompt).not.toContain('get_status')
    expect(desc('generate_veo3_video')).toMatch(/black frame/)
    expect(desc('generate_veo3_video')).toMatch(/Do NOT loop the poller/)
  })

  it('generate_image carries sticker mode (recipe paragraph deleted)', () => {
    expect(prompt).not.toContain("mode:'sticker'")
    expect(desc('generate_image')).toMatch(/sticker/)
  })

  it('add_narration carries the ~150 wpm pace (## Audio bullet deleted)', () => {
    expect(prompt).not.toContain('150 words')
    expect(desc('add_narration')).toMatch(/150 words\/minute/)
  })
})

describe('a scene-builder sub-agent is not handed the same rule twice', () => {
  // A focused sub-agent gets sceneTypeGuidanceReact AND SCENE_AUTHORING_CONTRACT, and
  // both used to state these three rules. On an 8-scene fan-out that duplication is
  // paid eight times.
  const focused = buildSceneMakerPrompt('react', { width: 1920, height: 1080 }, true)

  it.each([
    ['no rAF/setTimeout/setInterval/Math.random', /requestAnimationFrame/g],
    ['export default Scene;', /export default Scene;/g],
    // A LIST of the five bridges on one line — the contract's globals bullet. The
    // BRIDGE SKILLS OVERRIDE paragraph names them with props (`<Canvas2DLayer draw=`)
    // and is a different rule, so it does not match.
    ['the bridge component list', /<Canvas2DLayer>[^\n]{0,80}<LottieLayer>/g],
  ])('states %s once', (_label, probe) => {
    expect(count(focused, probe)).toBe(1)
  })
})
