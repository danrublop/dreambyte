// @vitest-environment node
/**
 * THE CHECK: a builder's renderer craft arrives from PLAN STATE, on every build path,
 * without the model asking for it — and never twice.
 *
 * This is the wire that broke silently. `get_routed_craft` was the only door to the
 * craft corpus, and across 36 recorded runs / 1,039 tool calls the model opened it
 * ONCE — because the only prose telling anyone to call it lives in ROUTER.md §4, which
 * `context-builder` strips from every sub-agent. Meanwhile the director (the DEFAULT
 * build path) never set `focusedSceneType`, so it was also the one path that
 * received no per-renderer block at all: a 3D beat saw the line "Renderer: three" and
 * guessed the SDK.
 *
 * So both directions are asserted here:
 *   • the block REACHES a three builder on the fan-out path AND the director path;
 *   • it reaches each exactly ONCE (one source per renderer — the fan-out through
 *     `focusedSceneType`, the director through `renderDirectorSkillGuides`);
 *   • a react beat gets none of it (SCENE_AUTHORING_CONTRACT already carries React);
 *   • the packs excluded by name — the removed design doctrine — never ride along.
 *
 * All of it is pure functions over a SceneSpec: no model, no tool call, $0.
 */
import { describe, it, expect } from 'vitest'

import { renderDirectorSkillGuides } from './director-loop'
import { buildSceneMakerPrompt } from './prompts'
import type { SceneSpec } from './types'

const threeBeat: SceneSpec = { name: 'Orbit', purpose: 'a 3d product orbit', sceneType: 'three', duration: 8 }
const reactBeat: SceneSpec = { name: 'Intro', purpose: 'title card', sceneType: 'react', duration: 8 }

/** Strings that exist ONLY in the 3D SDK block — if these are present, it arrived. */
const SDK_MARKERS = ['buildInfiniteStudio', 'makeStudioSet', 'buildExtrudedText', 'createDreambytePostFXPreset']

/**
 * Excluded BY NAME. `design-principles` is the always-on design doctrine deliberately
 * excluded ("too many rules → regression"); `core` is redundant with
 * SCENE_AUTHORING_CONTRACT, which every builder already gets. Neither may re-enter
 * through the state route — that is how a "routing" change turns into a prose wall.
 */
const EXCLUDED_BY_NAME = [
  'The Slop Test', // design-principles.md
  'Never use overused fonts', // design-principles.md
  '# Core — every scene', // core.md
]

describe('renderer craft is routed from plan state', () => {
  it('fan-out: the beat’s sceneType selects the 3D SDK block', () => {
    // buildSceneWithSubAgent passes `focusedSceneType: planned.sceneType` — this is
    // that call, with nothing else supplied.
    const prompt = buildSceneMakerPrompt(threeBeat.sceneType, undefined, true)
    for (const m of SDK_MARKERS) expect(prompt, `fan-out three builder is missing ${m}`).toContain(m)
  })

  it('director: the plan selects the same block for the whole video', () => {
    const block = renderDirectorSkillGuides([threeBeat], null)
    for (const m of SDK_MARKERS) expect(block, `director is missing ${m}`).toContain(m)
  })

  it('one source per renderer — the block is never injected twice', () => {
    // Two 3D beats in one plan, plus a react beat: still one block. And the director
    // deliberately does NOT set focusedSceneType, so its system prompt cannot also
    // carry it (that overlap is the trap this wiring had to avoid).
    const block = renderDirectorSkillGuides([threeBeat, { ...threeBeat, name: 'Reveal' }, reactBeat], null)
    expect(block.split('## Layer Generation Rules (three)').length - 1).toBe(1)
    expect(buildSceneMakerPrompt(undefined, undefined, true)).not.toContain('buildInfiniteStudio')
  })

  it('a react beat gets no renderer block on either path', () => {
    // React is row 5: SCENE_AUTHORING_CONTRACT already carries the React contract into
    // every builder, so a second copy would be pure duplication.
    expect(renderDirectorSkillGuides([reactBeat, reactBeat], null)).toBe('')
    const prompt = buildSceneMakerPrompt(reactBeat.sceneType, undefined, true)
    for (const m of SDK_MARKERS) expect(prompt).not.toContain(m)
  })

  it('the packs excluded by name never ride along', () => {
    const surfaces = [
      renderDirectorSkillGuides([threeBeat, reactBeat], null),
      buildSceneMakerPrompt(threeBeat.sceneType, undefined, true),
      buildSceneMakerPrompt(reactBeat.sceneType, undefined, true),
    ]
    for (const s of surfaces) for (const doctrine of EXCLUDED_BY_NAME) expect(s).not.toContain(doctrine)
  })
})
