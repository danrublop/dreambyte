import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filterToolsForAgent, buildAgentContext } from './context-builder'
import { ALL_TOOLS } from './tools'
import {
  TOOL_GATED_PROMPT_FRAGMENTS,
  CLI_ROLE_BLOCK_LINES,
  CLI_RUNTIME_CONTEXT_LINES,
  CLI_PERMISSION_WARNING_LINES,
} from './prompts'
import { ensureAllHandlersRegistered } from './tool-executor'
import { toolRegistry } from './tool-registry'
import { AUDIO_PROVIDERS } from '../audio/provider-registry'
import { MEDIA_PROVIDERS } from '../media/provider-registry'
import type { GlobalStyle } from '../types'

const GLOBAL_STYLE: GlobalStyle = {
  presetId: null,
  paletteOverride: null,
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

/** What the editor store ships with all default chips on. */
const STORE_DEFAULT_CHIPS = ['react', 'svg', 'canvas2d', 'd3', 'three', 'lottie', 'zdog', 'assets', 'audio', 'video']

/** Every provider toggled off — a keyless install, without depending on the host's .env. */
const ALL_PROVIDERS_OFF = {
  audio: Object.fromEntries(AUDIO_PROVIDERS.map((p) => [p.id, false])),
  media: Object.fromEntries(MEDIA_PROVIDERS.map((p) => [p.id, false])),
}

/**
 * No prompt text may command a tool the model cannot call.
 *
 * THE RECURRING BUG: every consolidation pass renames or absorbs tools (e.g. the
 * routers turned `set_global_style` into an internal op of `set_style`, and
 * `query_media_library`/`reuse_asset` into ops of `media_library`), but the prose
 * that names them lives in a different file and silently goes stale. The model then
 * emits a call for a tool that isn't in its schema list — a wasted turn at best, and
 * on a top-level run (which skips enforcedToolNames) a guess-the-signature dispatch.
 *
 * This scans model-facing text for identifiers that LOOK like tool calls and asserts
 * each one is really offered. It only inspects strings the model receives, so a code
 * comment mentioning a retired name is fine.
 * Regex over prose, not an AST — cheap and it catches the real regressions
 */
describe('prompt text never names an unofferable tool', () => {
  // Everything offered to a normal parent run, plus every tool that exists at all —
  // a name gated off by config is not a phantom, it is just currently disabled.
  const STORE_DEFAULT = STORE_DEFAULT_CHIPS
  const offered = new Set(
    filterToolsForAgent(
      'scene-maker',
      STORE_DEFAULT,
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      false,
    ).map((t) => t.name),
  )
  const defined = new Set(ALL_TOOLS.map((t) => t.name))

  // Tool names retired into internal router ops. These never had standalone
  // handlers, so they can't be derived — they stay listed by hand.
  // NOT here: `list_scenes` / `read_scene`. Those are LIVE MCP-native tools
  // (scripts/mcp/mcp-server.ts:169,187), and the .md this scans is Claude Code-facing —
  // flagging them would fail an accurate doc.
  const RETIRED_ROUTER_OPS = ['set_global_style', 'query_media_library', 'reuse_asset', 'brand_kit']

  // The rest is DERIVED, because a hand-written list is what let this bug back in.
  // Every consolidation pass here uses the same technique — delete the offered
  // schema, keep the handler dispatchable for replay/MCP — so a retired tool is
  // exactly "still in the dispatch table, no longer in ALL_TOOLS". Reading the
  // real registry means the next cut is covered the day it lands, with nobody
  // remembering to update a constant.
  ensureAllHandlersRegistered()
  const RETIRED = [...RETIRED_ROUTER_OPS, ...toolRegistry.getRegisteredToolNames().filter((n) => !defined.has(n))]

  /**
   * Names that NEVER existed, or were deleted OUTRIGHT (schema AND handler), so nothing
   * can derive them.
   *
   * RETIRED is derived from the dispatch table — which by construction cannot contain a
   * tool that was never registered, and no longer contains one that was deleted whole.
   * Every entry below actually shipped in a live prompt or skill doc while every other
   * check passed. Add to this list, never remove from it.
   */
  const NEVER_EXISTED = [
    'edit_layer',
    'create_interaction',
    'apply_physics_to_scene',
    'add_sound_effect',
    'add_background_music',
    'set_global_style',
    'generate_variation',
    // Deleted outright (feature removed, not merged): the physics family + world_scene.
    'generate_physics_scene',
    'explain_physics_concept',
    'annotate_simulation',
    'set_simulation_params',
    'world_scene',
    // Collapsed into one-tool-per-noun routers by the consolidation pass. The handlers
    // went with the schemas, so RETIRED cannot see any of these.
    'read_scene_code',
    'describe_scene_state', // → inspect
    'generate_chart',
    'update_chart',
    'reorder_charts', // → chart
    'search_lottie',
    'search_3d_models', // → find_media
    'set_video_layer',
    'set_audio_layer', // → set_media_layer
    'review_video',
    'review_scene_motion', // → review
    'export_mp4',
    'get_export_status',
    'get_video_status',
    'get_avatar_status', // → export / get_status
    'move_clip',
    'trim_clip',
    'split_clip',
    'remove_clip',
    'set_clip_props',
    'slip_edit', // → clip
    'add_interaction',
    'add_multiple_interactions', // → interaction
    'auto_cut_silence',
    'cut_by_transcript', // → auto_cut
    'apply_color_grade', // → apply_color
    'save_zdog_person_asset',
    'build_zdog_asset', // → save_zdog_asset
  ]

  /**
   * The single list every check below uses. Splitting it was the bug: RETIRED reached the
   * assembled prompt but NEVER_EXISTED only reached markdown and the CLI block, so a tool
   * deleted outright could sit in ROUTER.md — which context-builder injects into
   * staticPrompt — with the whole suite green.
   */
  const GHOSTS = [...RETIRED, ...NEVER_EXISTED].filter((n) => !defined.has(n))

  it('names no retired tool in any model-facing prompt string', () => {
    const ctx = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: STORE_DEFAULT, sceneContext: 'all' },
      [],
      GLOBAL_STYLE,
      'Test Project',
      'mp4',
    )
    const modelFacing = [ctx.systemPrompt, ctx.staticPrompt, ctx.stableCascade, ctx.volatileState]
      .filter(Boolean)
      .join('\n')

    const found = GHOSTS.filter((name) => new RegExp(`\\b${name}\\b`).test(modelFacing))
    expect(
      found,
      'The assembled system prompt names a tool that is not offered. Every string in ' +
        'buildAgentContext — including the docs it appends, like docs/agent/ROUTER.md — is read by the model.',
    ).toEqual([])
  })

  it('every tool named in a tool DESCRIPTION is a real tool', () => {
    // Tool descriptions are the densest instruction surface (they outweigh the system
    // prompt ~3:1), so a stale name here is read on every single turn.
    const offenders: string[] = []
    for (const tool of ALL_TOOLS) {
      const desc = tool.description ?? ''
      for (const name of GHOSTS) {
        if (new RegExp(`\\b${name}\\b`).test(desc)) offenders.push(`${tool.name} → ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // The GHOSTS scan only catches names that were once real, or that somebody remembered
  // to list. It cannot see a name that NEVER existed and nobody noticed — which is how
  // `create_design_brief`, `add_clip_to_track`, `create_character` and `find_stock_*`
  // all rode live descriptions while the real tools were called `design_brief`,
  // `place_clip`, `character` and `find_media`. So: scan for snake_case identifiers
  // that start with a tool verb and assert each one is offered.
  // Verb-prefix heuristic over prose, not an AST — it caught all four.
  const VERB = String.raw`(?:add|apply|ask|analyze|build|capture|clone|compose|connect|create|crop|cut|define|delete|describe|dispatch|dub|duplicate|edit|explain|export|fetch|find|generate|get|import|inspect|list|migrate|move|patch|place|plan|publish|query|read|regenerate|remove|reorder|request|resize|reuse|review|run|save|search|set|slip|split|sync|trim|update|use|verify|write)`
  const CITED = new RegExp(String.raw`\b${VERB}(?:_[a-z0-9]+)+\b`, 'g')

  // Snake_case words with a verb prefix that are NOT tool calls. Keep this tight —
  // every entry is a phrase the model could plausibly misread as a callable name.
  const NOT_A_TOOL = new Set([
    'add_object',
    'remove_object',
    'move_object',
    'add_panel',
    'remove_panel', // world_scene ops
    'update_camera_path',
    'change_environment',
    'create_scene_from_template',
    'get_started',
    'read_only',
    'write_once',
    // Live MCP-native tools (scripts/mcp/mcp-server.ts) — real, just not in ALL_TOOLS,
    // and the .md this scans is Claude Code-facing.
    'list_scenes',
    'read_scene',
    'create_project',
    'select_project',
    'refresh_state',
    'set_run_mode',
    'set_max_run_cost',
    'get_world_state',
    'approve_pending_generation',
  ])

  /** Every tool-SHAPED identifier in `text` that is not a real, offered tool. */
  const toolShapedGhosts = (text: string): string[] =>
    [...new Set([...text.matchAll(CITED)].map((m) => m[0]))].filter((n) => !defined.has(n) && !NOT_A_TOOL.has(n))

  it('every tool-SHAPED name cited in a description is a real tool', () => {
    const offenders: string[] = []
    for (const tool of ALL_TOOLS) {
      for (const cited of toolShapedGhosts(tool.description ?? '')) offenders.push(`${tool.name} → ${cited}`)
    }
    expect(
      offenders,
      'A tool description names something that looks like a tool but is not offered. ' +
        'Fix the name, or add it to NOT_A_TOOL if it is prose/an op discriminator.',
    ).toEqual([])
  })

  it('every tool-SHAPED name in the assembled prompt is a real tool', () => {
    // Same heuristic, aimed at the prompt the model actually receives. GHOSTS above only
    // matches names somebody listed; this catches the ones nobody did.
    const ctx = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: STORE_DEFAULT, sceneContext: 'all' },
      [],
      GLOBAL_STYLE,
      'Test Project',
      'mp4',
    )
    const text = [ctx.systemPrompt, ctx.staticPrompt, ctx.stableCascade, ctx.volatileState].filter(Boolean).join('\n')
    expect(
      toolShapedGhosts(text),
      'The assembled system prompt names something tool-shaped that is not a real tool. ' +
        'Fix the name, or add it to NOT_A_TOOL if it is prose/an op discriminator.',
    ).toEqual([])
  })

  it('every tool-SHAPED name in model-facing markdown is a real tool', () => {
    // src/lib/skills/library/*.md is injected verbatim into the builder prompt
    // (director-loop renderDirectorSkillGuides), so a stale name here is a live command.
    const offenders: string[] = []
    for (const { rel, text } of modelFacingMarkdown()) {
      for (const cited of toolShapedGhosts(text)) offenders.push(`${rel} → ${cited}`)
    }
    expect(
      offenders,
      'A skill/rule doc names something tool-shaped that is not a real tool. ' +
        'Fix the name, or add it to NOT_A_TOOL if it is prose/an op discriminator.',
    ).toEqual([])
  })

  it('sub-agents are never told to call a PARENT_ONLY tool', () => {
    const sub = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: STORE_DEFAULT, sceneContext: 'all', isSubAgent: true },
      [],
      GLOBAL_STYLE,
      'Test Project',
      'mp4',
    )
    const text = [sub.systemPrompt, sub.staticPrompt, sub.stableCascade, sub.volatileState].filter(Boolean).join('\n')

    const subOffered = new Set(
      filterToolsForAgent(
        'scene-maker',
        STORE_DEFAULT,
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
        true,
      ).map((t) => t.name),
    )
    // plan_scenes / dispatch_scene_builder exist, but are stripped from sub-agents.
    const parentOnly = ['plan_scenes', 'dispatch_scene_builder'].filter((n) => defined.has(n) && !subOffered.has(n))
    expect(parentOnly.length).toBeGreaterThan(0) // guard the guard

    const commanded = parentOnly.filter((n) => new RegExp(`call ${n}\\b|${n}\\(`).test(text))
    expect(commanded).toEqual([])
  })

  /**
   * Every model-facing .md, including SKILL.md itself.
   *
   * The old list was three DIRECTORIES, read with a non-recursive readdirSync — so
   * `.claude/skills/dreambyte/SKILL.md` (the biggest model-facing doc there is, injected
   * verbatim into every Claude Code run) was never scanned, and neither was the
   * `.agents/` mirror. That is how SEVEN never-existing tool names — edit_layer,
   * create_interaction, apply_physics_to_scene, add_sound_effect, add_background_music,
   * set_global_style, generate_variation — sat in it while this test stayed green.
   */
  const MODEL_FACING_MD_ROOTS = [
    '.claude/skills/dreambyte',
    '.claude/skills/dreambyte/rules',
    '.claude/skills/dreambyte/pipelines',
    '.agents/skills/dreambyte',
    '.agents/skills/dreambyte/rules',
    '.agents/skills/dreambyte/pipelines',
    'src/lib/skills/library',
  ]

  const modelFacingMarkdown = (): Array<{ rel: string; text: string }> => {
    const out: Array<{ rel: string; text: string }> = []
    for (const rel of MODEL_FACING_MD_ROOTS) {
      const dir = join(process.cwd(), rel)
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'))
      } catch {
        continue // dir not present in this checkout — nothing to police
      }
      for (const f of files) out.push({ rel: `${rel}/${f}`, text: readFileSync(join(dir, f), 'utf-8') })
    }
    return out
  }

  it('names no retired tool in a rule pack or skill the model can load', () => {
    // These .md files are model-facing too — load-rule-packs reads the rules dir
    // and the skill library is listed in its own generated index — but they live
    // far from tools.ts, so a cut sweeps the prompts and misses them. That is
    // exactly how remove_chart / get_3d_model_url / list_3d_assets /
    // verify_scene_pedagogy ended up orphaned here.
    const docs = modelFacingMarkdown()
    expect(docs.length, 'no model-facing markdown found — the roots are wrong').toBeGreaterThan(5)
    const offenders: string[] = []
    for (const { rel, text } of docs) {
      for (const name of GHOSTS) {
        if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${rel} → ${name}`)
      }
    }
    expect(
      offenders,
      'A skill/rule doc names a tool that does not exist. These are injected verbatim into ' +
        'the model context, so the model will try to call it.',
    ).toEqual([])
  })

  it('the Claude Code CLI prompt names no retired or never-existing tool', () => {
    // The CLI-provider prompt is assembled in runner.ts and is NOT produced by
    // buildAgentContext, so the four-string scan above cannot see it. Its static prose
    // now lives in prompts.ts precisely so this check can reach it — that block is where
    // all seven NEVER_EXISTED names were found.
    const cliText = [...CLI_ROLE_BLOCK_LINES, ...CLI_RUNTIME_CONTEXT_LINES, ...CLI_PERMISSION_WARNING_LINES].join('\n')
    const offenders = GHOSTS.filter((name) => new RegExp(`\\b${name}\\b`).test(cliText))
    expect(offenders, 'The Claude Code system prompt commands a tool that does not exist.').toEqual([])
  })

  it('offered set is non-empty (sanity)', () => {
    expect(offered.size).toBeGreaterThan(50)
  })
})

/**
 * THE GENERAL GUARD (H2). The checks above police names that are stale or fictional;
 * this one polices names that are REAL but not offered ON THIS RUN — the same defect
 * from the config axis. `buildAgentContext` produces the system prompt and the
 * resolved tool list together, so the invariant is checkable per configuration:
 *
 *   every tool name the prompt cites ∈ (tools offered for that run) ∪ ALLOWLIST
 *
 * Run across the configurations where the phantoms hide: chips off, provider keys
 * absent, sub-agent, interactive vs mp4. A prompt block that gates on provider
 * readiness while ignoring `activeTools` (the rich-media recipe did exactly that)
 * goes red the moment a chip is dropped.
 */
describe('no prompt cites a tool this run does not offer', () => {
  const defined = ALL_TOOLS.map((t) => t.name)
  // The only tool names that are also ordinary English words. For these, require a
  // call-shaped citation so "the character on screen" isn't read as a tool call.
  const BARE_WORDS = new Set(defined.filter((n) => !n.includes('_')))

  const cites = (text: string, name: string): boolean => {
    if (!new RegExp(`\\b${name}\\b`).test(text)) return false
    if (!BARE_WORDS.has(name)) return true
    return new RegExp(`\`${name}\`|\\b${name}\\(|\\bcall ${name}\\b|\\*\\*${name}\\*\\*`).test(text)
  }

  /**
   * Names the prompt may cite while NOT offering them. Every entry needs a reason —
   * "the prompt says it is unavailable / how to unlock it" is the only valid one.
   * Anything else is a phantom and belongs in a gate, not here.
   */
  const ALLOWLIST: Record<string, string> = {
    // The prompt's "web research is OFF, here is how to turn it on" line. The three
    // research tools are stripped exactly when that line fires, so naming them is
    // the POINT — the model otherwise has no signal the capability exists.
    set_research_mode: 'named as the unlock path when research tools are stripped',
  }

  const CONFIGS: Array<{
    label: string
    agentType: 'scene-maker'
    outputMode: 'mp4' | 'interactive'
    opts: Record<string, unknown>
  }> = [
    {
      label: 'default chips · mp4',
      agentType: 'scene-maker',
      outputMode: 'mp4',
      opts: { activeTools: STORE_DEFAULT_CHIPS, webSearchEnabled: true, webFetchEnabled: true },
    },
    {
      label: 'default chips · interactive',
      agentType: 'scene-maker',
      outputMode: 'interactive',
      opts: { activeTools: [...STORE_DEFAULT_CHIPS, 'interactions'], webSearchEnabled: true, webFetchEnabled: true },
    },
    {
      // The configuration that exposed H1: react only, provider keys untouched.
      label: 'minimal chips (react only)',
      agentType: 'scene-maker',
      outputMode: 'mp4',
      opts: { activeTools: ['react'] },
    },
    {
      label: 'no chips at all',
      agentType: 'scene-maker',
      outputMode: 'mp4',
      opts: { activeTools: [] },
    },
    {
      // Every provider toggled OFF — simulates an install with no API keys without
      // depending on whatever the test machine happens to have in .env.
      label: 'default chips · no provider keys',
      agentType: 'scene-maker',
      outputMode: 'mp4',
      opts: {
        activeTools: STORE_DEFAULT_CHIPS,
        audioProviderEnabled: ALL_PROVIDERS_OFF.audio,
        mediaGenEnabled: ALL_PROVIDERS_OFF.media,
      },
    },
    {
      label: 'sub-agent scene builder',
      agentType: 'scene-maker',
      outputMode: 'mp4',
      opts: { activeTools: STORE_DEFAULT_CHIPS, isSubAgent: true },
    },
  ]

  for (const cfg of CONFIGS) {
    it(`offers every tool it names — ${cfg.label}`, () => {
      const ctx = buildAgentContext(
        cfg.agentType,
        { agentType: cfg.agentType, sceneContext: 'all', ...cfg.opts } as never,
        [],
        GLOBAL_STYLE,
        'Test Project',
        cfg.outputMode,
      )
      const text = [ctx.systemPrompt, ctx.staticPrompt, ctx.stableCascade, ctx.volatileState].filter(Boolean).join('\n')
      const offeredHere = new Set(ctx.tools.map((t) => t.name))

      const phantoms = defined.filter((n) => !offeredHere.has(n) && !ALLOWLIST[n] && cites(text, n))
      expect(
        phantoms,
        `The system prompt for "${cfg.label}" commands tools this run does not offer. ` +
          `Gate the prompt block on the offered tool list (see \`offers()\` in context-builder), ` +
          `or add the name to ALLOWLIST with a reason if it is deliberately named as unavailable.`,
      ).toEqual([])
    })
  }

  it('every gated fragment still appears VERBATIM when everything is offered', () => {
    // dropUnofferedPromptFragments does exact-substring surgery. Reword the prompt
    // and the gate silently becomes a no-op — which is how the phantom gets back in.
    // Assert each `drop` string is really in the assembled prompt.
    const ctx = buildAgentContext(
      'scene-maker',
      {
        agentType: 'scene-maker',
        activeTools: STORE_DEFAULT_CHIPS,
        sceneContext: 'all',
        webSearchEnabled: true,
        webFetchEnabled: true,
      } as never,
      [],
      GLOBAL_STYLE,
      'Test Project',
      'mp4',
    )
    const missing = TOOL_GATED_PROMPT_FRAGMENTS.filter(
      (f) => f.keepIf(() => true) && !ctx.staticPrompt.includes(f.drop),
    ).map((f) => f.drop.slice(0, 70))
    expect(missing, 'A gated fragment no longer matches the prompt text — update TOOL_GATED_PROMPT_FRAGMENTS').toEqual(
      [],
    )
  })

  it('guard the guard — it fails when a prompt names an unofferable tool', () => {
    const ctx = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: ['react'], sceneContext: 'all' },
      [],
      GLOBAL_STYLE,
      'Test Project',
      'mp4',
    )
    const offeredHere = new Set(ctx.tools.map((t) => t.name))
    const notOffered = defined.find((n) => !offeredHere.has(n) && n.includes('_'))!
    expect(notOffered).toBeTruthy()
    // Same predicate the assertion uses, fed a prompt that DOES name it.
    expect(cites(`${ctx.systemPrompt}\nAlways call ${notOffered} first.`, notOffered)).toBe(true)
  })
})
