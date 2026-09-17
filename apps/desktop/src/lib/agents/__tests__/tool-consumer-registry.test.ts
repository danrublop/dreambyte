// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ALL_TOOLS } from '../tools'
import { toolRegistry } from '../tool-registry'
import {
  ensureAllHandlersRegistered,
  ensureRegistryCoverage,
  executeTool,
  INTERNAL_ONLY_TOOL_NAMES,
} from '../tool-executor'

/**
 * The tool consumer registry (v5 T11/E7) — stop the lying-tool class from
 * regrowing.
 *
 * Three successive sweeps (v4, v5 audit, this lane) each found "the last"
 * tools whose cross-boundary claims had no consumer: handlers emitted
 * `action:`/`clientAction:` payloads or world-state writes that NOTHING on
 * the other side of the runner/renderer/MCP boundary ever read, so the agent
 * reported phantom successes. This source-parity test (cap-checkpoint.test.ts
 * style) makes the contract executable:
 *
 *  1. REGISTRY — every cross-boundary claim names its consumer FILE and the
 *     consuming string; the test asserts the file really contains it.
 *  2. SWEEP — every `action:`/`clientAction:` string literal emitted by a
 *     handler must be registered (or explicitly listed as a non-emission
 *     false positive). An unregistered action fails with instructions.
 *  3. FAIL_HONEST — the converted liars stay converted: their handler files
 *     must contain a toolNotAvailable refusal for each verb.
 *
 * Adding a new cross-boundary tool? Either register its consumer file here
 * (and make sure the consumer exists), or fail-honest the tool via
 * toolNotAvailable until the consumer lands. Do not ship a third option.
 */

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8')
}

// ── 1. The registry ──────────────────────────────────────────────────────────

interface ConsumerPin {
  /** Consumer file, repo-relative. */
  file: string
  /** Exact substring that performs the consumption in that file. */
  mustContain: string
}

interface RegistryEntry {
  /** The cross-boundary claim (action name or world-field). */
  claim: string
  /** Handler file that emits it (sanity pin so the registry can't go stale). */
  emitter: ConsumerPin
  consumers: ConsumerPin[]
}

const REGISTRY: RegistryEntry[] = [
  {
    claim: 'run_export',
    emitter: {
      file: 'src/lib/agents/tool-handlers/planning-export-tools.ts',
      mustContain: "clientAction: 'run_export'",
    },
    consumers: [
      { file: 'src/lib/agents/runner.ts', mustContain: 'isExportClientAction(result.data)' },
      { file: 'src/lib/agents/mcp-handler.ts', mustContain: 'isExportClientAction(result.data)' },
    ],
  },
  {
    claim: 'capture_frame',
    emitter: {
      file: 'src/lib/agents/tool-handlers/capture-frame-tools.ts',
      mustContain: "clientAction: 'capture_frame'",
    },
    consumers: [
      { file: 'src/lib/agents/runner.ts', mustContain: "clientAction === 'capture_frame'" },
      { file: 'src/lib/agents/mcp-handler.ts', mustContain: "clientAction === 'capture_frame'" },
    ],
  },
  {
    claim: 'review_video',
    emitter: {
      file: 'src/lib/agents/tool-handlers/capture-frame-tools.ts',
      mustContain: "clientAction: 'review_video'",
    },
    consumers: [
      { file: 'src/lib/agents/runner.ts', mustContain: "clientAction === 'review_video'" },
      { file: 'src/lib/agents/mcp-handler.ts', mustContain: "'review_video'" },
    ],
  },
  {
    claim: 'review_scene_motion',
    emitter: {
      file: 'src/lib/agents/tool-handlers/capture-frame-tools.ts',
      mustContain: "clientAction: 'review_scene_motion'",
    },
    consumers: [
      { file: 'src/lib/agents/runner.ts', mustContain: "clientAction === 'review_scene_motion'" },
      { file: 'src/lib/agents/mcp-handler.ts', mustContain: "'review_scene_motion'" },
    ],
  },
  {
    claim: 'ask_user (clarify pause → resume with the user answer)',
    emitter: { file: 'src/lib/agents/tool-handlers/clarify-tools.ts', mustContain: "clientAction: 'ask_user'" },
    consumers: [
      { file: 'src/lib/agents/runner.ts', mustContain: 'clarificationNeeded' },
      { file: 'src/lib/hooks/use-agent-run.ts', mustContain: 'clarificationNeeded' },
    ],
  },
  {
    claim: 'designBrief (world.globalStyle.designBrief → system prompt)',
    emitter: { file: 'src/lib/agents/tool-handlers/design-tools.ts', mustContain: 'world.globalStyle.designBrief' },
    consumers: [{ file: 'src/lib/agents/context-builder.ts', mustContain: 'designBrief' }],
  },
  {
    claim: 'crop fields (layer.cropX/cropY → render)',
    emitter: { file: 'src/lib/agents/tool-handlers/ai-layer-tools.ts', mustContain: 'cropX' },
    consumers: [{ file: 'src/lib/sceneTemplate.ts', mustContain: 'cropX' }],
  },
  {
    claim: 'recordingCommand (start_recording → renderer record control)',
    emitter: { file: 'src/lib/agents/tool-handlers/recording-tools.ts', mustContain: "recordingCommand = 'start'" },
    consumers: [{ file: 'src/lib/hooks/use-agent-run.ts', mustContain: 'recordingCommand' }],
  },
  {
    claim: 'watermark (add_watermark → project.watermark, v5 T9)',
    emitter: {
      file: 'src/lib/agents/tool-handlers/asset-media-tools.ts',
      mustContain: 'world.watermark = watermarkConfig',
    },
    consumers: [
      { file: 'src/lib/services/agent-runner.ts', mustContain: 'updatedWatermark: result.updatedWatermark' },
      { file: 'src/lib/agents/mcp-handler.ts', mustContain: 'watermark: world.watermark' },
      { file: 'src/lib/hooks/use-agent-run.ts', mustContain: 'setWatermark(event.updatedWatermark)' },
    ],
  },
  {
    // reuse_asset is de-advertised from the model surface but MUST stay dispatchable:
    // landResearchMedia auto-places staged research images by id via executeTool.
    //
    // This entry used to claim it pinned "both ends" and did not: BOTH pins read the
    // handler-registration array, and the SCHEMA end was never checked at all — which
    // is how the tool stayed registered, lost its schema, and had every call rejected
    // by executeTool's canonical-name gate while this test stayed green. The real
    // both-ends check is now `INTERNAL_ONLY_TOOL_NAMES` + `ensureRegistryCoverage`
    // (see the executable pin below), which DERIVES the invariant for every tool
    // instead of restating it by hand for one.
    claim: 'reuse_asset (internal auto-placer → media-library registration)',
    emitter: { file: 'src/lib/research/land-media.ts', mustContain: "executeTool('reuse_asset'" },
    consumers: [
      { file: 'src/lib/agents/tool-handlers/media-library-tools.ts', mustContain: "'reuse_asset',\n] as const" },
    ],
  },
  {
    claim: 'world.timeline (move/place/remove/etc. → project.timeline, v6 B1/B2)',
    emitter: {
      // The timeline tools mutate world.timeline (via setTimeline / direct
      // assignment in move_clip's write-through). Pin the gated carry-out, which
      // is the cross-boundary claim's actual source of truth.
      file: 'src/lib/agents/runner.ts',
      mustContain: 'updatedTimeline: timelineCarryOut(allToolCalls, world.timeline)',
    },
    consumers: [
      { file: 'src/lib/services/agent-runner.ts', mustContain: 'updatedTimeline: result.updatedTimeline' },
      { file: 'src/lib/hooks/use-agent-run.ts', mustContain: 'applyAgentTimeline(event.updatedTimeline)' },
      { file: 'src/lib/db/queries/projects.ts', mustContain: 'timeline: payload.timeline' },
    ],
  },
]

/** Action names the registry vouches for (used by the sweep). */
const REGISTERED_ACTIONS = new Set(['run_export', 'capture_frame', 'review_video', 'review_scene_motion', 'ask_user'])

// ── 2. Sweep config ──────────────────────────────────────────────────────────

/**
 * Regex matches in handler source that are NOT emitted actions (e.g. object
 * keys in lookup maps). Keyed by file basename + value. Add here ONLY when
 * the match is provably not part of a returned ToolResult payload.
 */
const NON_EMISSION_ALLOWLIST = new Set([
  // motion-tools.ts EMOTION_KEYWORD_MAP: `action: 'energetic'` maps the
  // keyword "action" to the energetic preset — a map key, not a payload.
  'motion-tools.ts::energetic',
  // timeline-tools.ts `keyframe` / `marker` merged tools take an `action`
  // DISCRIMINATOR param ('set'|'remove' / 'add'|'remove') read from args — a
  // tool INPUT + its type annotation, plus the internal re-dispatch that sets
  // `action: 'set'` on an executeTool arg object. None is a returned
  // cross-boundary ToolResult payload; the actual emitted actions are the
  // `keyframe/add`, `keyframe/remove`, `marker/add`, `marker/remove` (type:)
  // emitAgentAction calls, which the regex does not match.
  'timeline-tools.ts::set',
  'timeline-tools.ts::add',
])

// ── 3. Fail-honest pins ──────────────────────────────────────────────────────

/**
 * Converted liars: handler file must refuse via toolNotAvailable.
 *
 * EMPTY on purpose. publish_interactive and request_screen_recording were the last
 * two, and both were DELETED rather than kept refusing: neither had a schema, so
 * executeTool's canonical-name gate returned `Unknown tool` before dispatch could
 * reach the honest refusal. A refusal nobody can trigger is not honesty, it is dead
 * code. Add an entry here only for a tool that is genuinely OFFERED and refuses.
 */
const FAIL_HONEST: Array<{ tool: string; file: string }> = []

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip block comments and comment lines so documented examples don't trip the sweep. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
}

function handlerFiles(): string[] {
  const dir = path.resolve(process.cwd(), 'src/lib/agents/tool-handlers')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join('src/lib/agents/tool-handlers', f))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('tool consumer registry (v5 T11/E7)', () => {
  for (const entry of REGISTRY) {
    it(`${entry.claim}: emitter + every named consumer file actually consume it`, () => {
      const emitterSrc = read(entry.emitter.file)
      expect(
        emitterSrc.includes(entry.emitter.mustContain),
        `${entry.emitter.file} no longer emits "${entry.emitter.mustContain}" — update or remove this registry entry`,
      ).toBe(true)
      for (const consumer of entry.consumers) {
        const src = read(consumer.file)
        expect(
          src.includes(consumer.mustContain),
          `${consumer.file} must contain "${consumer.mustContain}" — the consumer for ${entry.claim} is gone. ` +
            'Restore it or fail-honest the emitting tool via toolNotAvailable.',
        ).toBe(true)
      }
    })
  }

  it('SWEEP: every action/clientAction a handler emits is registered or an allowlisted non-emission', () => {
    const offenders: string[] = []
    for (const file of handlerFiles()) {
      const src = stripComments(read(path.resolve(process.cwd(), file)))
      for (const m of src.matchAll(/(clientAction|action):\s*['"]([a-zA-Z0-9_-]+)['"]/g)) {
        const value = m[2]
        const key = `${path.basename(file)}::${value}`
        if (REGISTERED_ACTIONS.has(value)) continue
        if (NON_EMISSION_ALLOWLIST.has(key)) continue
        offenders.push(`${file} emits ${m[1]}: '${value}'`)
      }
    }
    expect(
      offenders,
      `Unregistered cross-boundary action(s) found:\n  ${offenders.join('\n  ')}\n` +
        'Every emitted action must name its consumer FILE in the REGISTRY of ' +
        'tool-consumer-registry.test.ts (and the consumer must exist), or the tool ' +
        'must fail-honest via toolNotAvailable until the consumer lands. If the match ' +
        'is not actually an emitted payload (e.g. a map key), add it to NON_EMISSION_ALLOWLIST.',
    ).toEqual([])
  })

  it('BOTH ENDS: every registered handler is either offered to the model or INTERNAL_ONLY', () => {
    // The invariant this file's reuse_asset entry claimed but never checked, derived
    // once for all 100+ tools. A handler with no schema is unreachable — executeTool
    // rejects the name — so it must be justified as an internal op or deleted.
    // ensureRegistryCoverage throws; this asserts it doesn't.
    ensureAllHandlersRegistered()
    expect(() => ensureRegistryCoverage()).not.toThrow()
  })

  it('every INTERNAL_ONLY tool really is dispatchable and really is unoffered', () => {
    ensureAllHandlersRegistered()
    const offered = new Set(ALL_TOOLS.map((t) => t.name))
    for (const name of INTERNAL_ONLY_TOOL_NAMES) {
      expect(toolRegistry.hasExplicit(name), `${name} is on the allowlist but has no handler`).toBe(true)
      expect(offered.has(name), `${name} is on the allowlist but IS offered — drop it from the list`).toBe(false)
    }
  })

  it('reuse_asset actually executes — the auto-placer path is not gated off', async () => {
    // The exact regression: land-media.ts calls executeTool('reuse_asset', …) and a
    // log.warn swallowed `Unknown tool: reuse_asset`, so researched photos staged into
    // the library and were never placed. A missing-asset error proves we reached the
    // handler; "Unknown tool" proves we did not.
    const world = {
      scenes: [],
      globalStyle: {},
      projectName: 'T',
      outputMode: 'mp4',
      sceneGraph: { nodes: [], edges: [] },
    } as unknown as Parameters<typeof executeTool>[2]
    const res = await executeTool('reuse_asset', { assetId: 'nope', sceneId: 'nope' }, world)
    expect(res.success).toBe(false)
    expect(res.error ?? '').not.toMatch(/Unknown tool/)
  })

  for (const { tool, file } of FAIL_HONEST) {
    it(`fail-honest pin: ${tool} refuses via toolNotAvailable in ${path.basename(file)}`, () => {
      const src = read(file)
      const refusal = new RegExp(`toolNotAvailable\\(\\s*'${tool}'`)
      expect(
        refusal.test(src),
        `${file} must contain toolNotAvailable('${tool}', …) — if you wired its consumer for real, ` +
          'move it from FAIL_HONEST into the REGISTRY with the consumer file named.',
      ).toBe(true)
    })
  }
})
