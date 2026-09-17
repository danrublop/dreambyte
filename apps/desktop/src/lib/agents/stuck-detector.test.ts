// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  createStuckDetectorState,
  recordToolForStuckDetection,
  toolSignature,
  buildStuckSteerNote,
  accumulateStuckAction,
  STUCK_WINDOW,
  STUCK_STOP_GRACE,
  STUCK_EXEMPT_TOOLS,
  STUCK_EXEMPT_PREFIXES,
  isStuckExempt,
  type StuckAction,
  type StuckDetectorState,
} from './stuck-detector'

/** Feed a sequence of (tool, input, hadDelta) calls and collect the actions. */
function run(
  state: StuckDetectorState,
  calls: Array<{ tool: string; input?: unknown; delta?: boolean }>,
): StuckAction[] {
  return calls.map((c) => recordToolForStuckDetection(state, c.tool, c.input ?? {}, c.delta ?? false))
}

function kinds(actions: StuckAction[]): string[] {
  return actions.map((a) => a.kind)
}

describe('toolSignature', () => {
  it('is identical for same tool + same args', () => {
    expect(toolSignature('write_scene_code', { id: 's1' })).toBe(toolSignature('write_scene_code', { id: 's1' }))
  })
  it('differs when the tool name differs', () => {
    expect(toolSignature('write_scene_code', { id: 's1' })).not.toBe(toolSignature('patch_layer_code', { id: 's1' }))
  })
  it('differs when args differ', () => {
    expect(toolSignature('write_scene_code', { id: 's1' })).not.toBe(toolSignature('write_scene_code', { id: 's2' }))
  })
  it('does not throw on unserializable input (cycles)', () => {
    const a: any = {}
    a.self = a
    expect(() => toolSignature('x', a)).not.toThrow()
  })
})

describe('recordToolForStuckDetection — single repeated mutating call', () => {
  it('steers ONCE then stops after continued repetition', () => {
    const state = createStuckDetectorState()
    // N identical no-delta mutating calls.
    const total = STUCK_WINDOW + STUCK_STOP_GRACE + 2
    const actions = run(
      state,
      Array.from({ length: total }, () => ({ tool: 'write_scene_code', input: { id: 's1' } })),
    )
    const steers = actions.filter((a) => a.kind === 'steer')
    const stops = actions.filter((a) => a.kind === 'stop')
    expect(steers).toHaveLength(1)
    // First steer at exactly the window threshold (4th call: indices 0..3).
    expect(actions[STUCK_WINDOW - 1].kind).toBe('steer')
    // At least one stop after the grace window; the run breaks on the first.
    expect(stops.length).toBeGreaterThanOrEqual(1)
    // Stop comes after the steer.
    const firstSteer = actions.findIndex((a) => a.kind === 'steer')
    const firstStop = actions.findIndex((a) => a.kind === 'stop')
    expect(firstStop).toBeGreaterThan(firstSteer)
  })
})

describe('recordToolForStuckDetection — distinct calls never trip', () => {
  it('A→B→C→D… (all distinct, no delta) produces no action', () => {
    const state = createStuckDetectorState()
    const actions = run(
      state,
      Array.from({ length: 20 }, (_, i) => ({ tool: 'write_scene_code', input: { id: `s${i}` } })),
    )
    expect(kinds(actions).every((k) => k === 'none')).toBe(true)
  })
})

describe('recordToolForStuckDetection — A↔B ping-pong (no delta) trips', () => {
  it('alternating two no-delta mutating signatures steers then stops', () => {
    const state = createStuckDetectorState()
    const total = STUCK_WINDOW + STUCK_STOP_GRACE + 2
    const actions = run(
      state,
      Array.from({ length: total }, (_, i) => ({
        tool: i % 2 === 0 ? 'write_scene_code' : 'patch_layer_code',
        input: { id: 'x' },
      })),
    )
    expect(actions.filter((a) => a.kind === 'steer')).toHaveLength(1)
    expect(actions.filter((a) => a.kind === 'stop').length).toBeGreaterThanOrEqual(1)
  })

  it('a THREE-way A→B→C→A→B→C rotation never trips (3 distinct in window)', () => {
    const state = createStuckDetectorState()
    const tools = ['write_scene_code', 'patch_layer_code', 'add_layer']
    const actions = run(
      state,
      Array.from({ length: 30 }, (_, i) => ({ tool: tools[i % 3], input: { id: 'x' } })),
    )
    expect(kinds(actions).every((k) => k === 'none')).toBe(true)
  })
})

describe('recordToolForStuckDetection — poll/read tools are exempt', () => {
  for (const tool of STUCK_EXEMPT_TOOLS) {
    it(`repeated ${tool} (no delta) never trips`, () => {
      const state = createStuckDetectorState()
      const actions = run(
        state,
        Array.from({ length: 50 }, () => ({ tool, input: { jobId: 'job-1' } })),
      )
      expect(kinds(actions).every((k) => k === 'none')).toBe(true)
    })
  }

  // REAL read-only tools that are NOT in any hand-maintained allowlist by name
  // but ARE exempt by the read-only prefix heuristic. These all return
  // affectedSceneId:null by construction, so before the prefix exemption a
  // healthy model re-reading state to orient (esp. weaker tiers) would
  // accumulate them in the window and falsely trip steer@4 / stop@8.
  describe('real prefix-exempt read tools never steer and never stop', () => {
    // Verified present in src/lib/agents/tools.ts and read-only in the handlers.
    const realReads = [
      'describe_scene_state',
      'read_editor_state',
      'read_design_brief',
      'read_scene_code',
      'list_snapshots',
      'list_blocks',
      'media_library',
      'review_video',
    ]
    for (const tool of realReads) {
      it(`${tool} matches the exempt policy and 50 identical calls produce no action`, () => {
        expect(isStuckExempt(tool)).toBe(true)
        const state = createStuckDetectorState()
        const actions = run(
          state,
          Array.from({ length: 50 }, () => ({ tool, input: { sceneId: 's1' } })),
        )
        const ks = kinds(actions)
        expect(ks.some((k) => k === 'steer')).toBe(false)
        expect(ks.some((k) => k === 'stop')).toBe(false)
        expect(ks.every((k) => k === 'none')).toBe(true)
      })
    }

    // The exact P1 false-positive the fix targets: a model that orients by
    // ping-ponging between two REAL read tools (no name in the legacy allowlist,
    // no delta) must NOT steer@4 and must NOT hard-stop@8.
    it('read_editor_state ↔ describe_scene_state, 8 identical-arg calls, no delta: no steer, no stop', () => {
      const state = createStuckDetectorState()
      const actions = run(
        state,
        Array.from({ length: 8 }, (_, i) => ({
          tool: i % 2 === 0 ? 'read_editor_state' : 'describe_scene_state',
          input: { sceneId: 's1' },
        })),
      )
      const ks = kinds(actions)
      expect(ks.some((k) => k === 'steer')).toBe(false)
      expect(ks.some((k) => k === 'stop')).toBe(false)
      expect(ks.every((k) => k === 'none')).toBe(true)
    })

    // The phantom names the old allowlist carried (none registered) are gone:
    // the exempt logic must be driven by real prefixes/extras, not those.
    it('does not rely on phantom (unregistered) tool names', () => {
      const phantoms = ['get_scene', 'read_scene', 'get_world_state', 'refresh_state', 'get_project_state']
      // They happen to match get_/read_ prefixes so isStuckExempt is true, but
      // STUCK_EXEMPT_EXTRAS (the explicit set) must NOT enumerate them.
      for (const p of phantoms) {
        expect(STUCK_EXEMPT_TOOLS.has(p)).toBe(false)
      }
    })

    it('a real MUTATOR is NOT exempt (set_scene_background)', () => {
      expect(isStuckExempt('set_scene_background')).toBe(false)
      expect(isStuckExempt('write_scene_code')).toBe(false)
      expect(isStuckExempt('rollback_to_snapshot')).toBe(false)
    })

    it('every exempt prefix is a known read verb', () => {
      expect(STUCK_EXEMPT_PREFIXES).toEqual(
        expect.arrayContaining(['get_', 'list_', 'read_', 'describe_', 'query_', 'review_']),
      )
    })
  })

  it('poll calls interleaved with progress never trip', () => {
    const state = createStuckDetectorState()
    // build, then poll the export 40x while it runs, then build again.
    const seq: Array<{ tool: string; input?: unknown; delta?: boolean }> = [
      { tool: 'create_scene', input: { id: 's1' }, delta: true },
      ...Array.from({ length: 40 }, () => ({ tool: 'get_export_status', input: { jobId: 'j' } })),
      { tool: 'create_scene', input: { id: 's2' }, delta: true },
    ]
    const actions = run(state, seq)
    expect(kinds(actions).every((k) => k === 'none')).toBe(true)
  })
})

describe('recordToolForStuckDetection — healthy verify→write→verify never trips', () => {
  it('repeated verify/write cycles that carry a delta reset the window', () => {
    const state = createStuckDetectorState()
    // verify_scene + write_scene_code both carry affectedSceneId (delta=true) in
    // the runner; even repeated many times they make progress every call.
    const seq: Array<{ tool: string; input?: unknown; delta?: boolean }> = []
    for (let i = 0; i < 15; i++) {
      seq.push({ tool: 'verify_scene', input: { id: 's1' }, delta: true })
      seq.push({ tool: 'write_scene_code', input: { id: 's1' }, delta: true })
    }
    const actions = run(state, seq)
    expect(kinds(actions).every((k) => k === 'none')).toBe(true)
  })

  it('a single mid-stream delta resets a building stall', () => {
    const state = createStuckDetectorState()
    // 3 no-delta repeats (not yet at the steer threshold) …
    run(state, Array.from({ length: STUCK_WINDOW - 1 }, () => ({ tool: 'write_scene_code', input: { id: 's1' } })))
    // … then a real write (delta) …
    const reset = recordToolForStuckDetection(state, 'write_scene_code', { id: 's1' }, true)
    expect(reset.kind).toBe('none')
    // … then 3 more no-delta repeats must still NOT have tripped (window reset).
    const after = run(
      state,
      Array.from({ length: STUCK_WINDOW - 1 }, () => ({ tool: 'write_scene_code', input: { id: 's1' } })),
    )
    expect(kinds(after).every((k) => k === 'none')).toBe(true)
  })
})

describe('buildStuckSteerNote', () => {
  it('mentions the tool and tells the model to change approach', () => {
    const note = buildStuckSteerNote('write_scene_code')
    expect(note).toContain('write_scene_code')
    expect(note.toLowerCase()).toContain('change your approach')
  })
})

// P2: the runner drains at most ONE stuck action per iteration, but a whole
// stall (or a recovery) can unfold across several tools in one iteration. These
// pin the burst-accumulation rules the runner delegates to accumulateStuckAction.
describe('accumulateStuckAction — once-per-iteration burst folding (P2)', () => {
  const steer: StuckAction = { kind: 'steer', signature: 'write_scene_code {}' }
  const stop: StuckAction = { kind: 'stop', signature: 'write_scene_code {}' }

  it('a real-progress (hadDelta) non-exempt call CLEARS a pending steer (no stale steer)', () => {
    const box = { action: steer as StuckAction }
    accumulateStuckAction(box, { kind: 'none' }, /*hadDelta*/ true, /*exempt*/ false)
    expect(box.action.kind).toBe('none')
  })

  it('a hadDelta call also clears a pending stop', () => {
    const box = { action: stop as StuckAction }
    accumulateStuckAction(box, { kind: 'none' }, true, false)
    expect(box.action.kind).toBe('none')
  })

  it('an EXEMPT poll/read that happens to report hadDelta does NOT clear a real pending action', () => {
    // Exempt tools never reset the detector window, so their hadDelta must not
    // wipe a steer earned by real no-delta mutations around them.
    const box = { action: steer as StuckAction }
    accumulateStuckAction(box, { kind: 'none' }, true, /*exempt*/ true)
    expect(box.action.kind).toBe('steer')
  })

  it('keeps the FIRST steer of the burst sticky — a later stop does NOT overwrite it', () => {
    // The "one steer (and a turn to react) before we hard-stop" guarantee: a
    // stall that fully unfolds in a single iteration must still steer once first.
    const box = { action: { kind: 'none' } as StuckAction }
    accumulateStuckAction(box, steer, false, false)
    expect(box.action.kind).toBe('steer')
    accumulateStuckAction(box, stop, false, false)
    expect(box.action.kind).toBe('steer') // stop deferred to a later iteration
  })

  it('escalates to stop when no steer is pending this iteration', () => {
    const box = { action: { kind: 'none' } as StuckAction }
    accumulateStuckAction(box, stop, false, false)
    expect(box.action.kind).toBe('stop')
  })

  it('does not downgrade a pending stop back to a steer', () => {
    const box = { action: stop as StuckAction }
    accumulateStuckAction(box, steer, false, false)
    expect(box.action.kind).toBe('stop')
  })
})
