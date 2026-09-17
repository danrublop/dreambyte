// @vitest-environment node
/**
 * Tests for classifyBridgeSkills — the deterministic bridge-skill router (PR2).
 *
 * These run against the REAL skill registry (src/lib/skills/library/*.md) so the
 * resolution is end-to-end: a keyword match must produce an actual loadable skill.
 * No model calls — the classifier is a pure function over text + the registry.
 */

import { describe, it, expect } from 'vitest'
import { classifyBridgeSkills, BRIDGE_RULES, bridgeSkillsForVisualForm } from './scene-type-rules'
import { loadSkillForSceneType } from '../skills/registry'

const idsOf = (text: string) => classifyBridgeSkills(text).map((s) => s.metadata.id)

describe('classifyBridgeSkills — signal classes', () => {
  it('routes 3D intent to the threejs skill', () => {
    expect(idsOf('a rotating 3d globe of the world')).toContain('threejs-3d-scene')
    expect(idsOf('points orbit a central node')).toContain('threejs-3d-scene')
    expect(idsOf('a scatter cloud in space')).toContain('threejs-3d-scene')
  })

  it('routes chart/data intent to the d3 skill', () => {
    expect(idsOf('an animated bar chart of revenue')).toContain('d3-data-visualization')
    expect(idsOf('a line graph trending up')).toContain('d3-data-visualization')
    expect(idsOf('plot the distribution')).toContain('d3-data-visualization')
  })

  it('routes hand-drawn/particle intent to the canvas2d skill', () => {
    expect(idsOf('a hand-drawn sketch of a house')).toContain('canvas2d-animation')
    expect(idsOf('a swirling particle field')).toContain('canvas2d-animation')
    expect(idsOf('one particle drifts up')).toContain('canvas2d-animation') // singular
  })

  it('routes draw-on/vector intent to the svg skill', () => {
    expect(idsOf('a draw-on line reveal')).toContain('svg-animation')
    expect(idsOf('an animated vector logo')).toContain('svg-animation')
  })

  it('routes icon/micro intent to the lottie skill', () => {
    expect(idsOf('a looping icon animation')).toContain('lottie-animation')
    expect(idsOf('a micro interaction badge')).toContain('lottie-animation')
  })
})

describe('classifyBridgeSkills — multi-label + dedupe', () => {
  it('returns multiple skills for composite intent', () => {
    const ids = idsOf('a bar chart orbiting a 3d globe')
    expect(ids).toContain('d3-data-visualization')
    expect(ids).toContain('threejs-3d-scene')
  })

  it('dedupes when several keywords hit the same bridge', () => {
    // both "bar" and "chart" and "graph" map to d3 → only one entry
    const ids = idsOf('a bar chart and a line graph')
    expect(ids.filter((id) => id === 'd3-data-visualization')).toHaveLength(1)
  })
})

describe('classifyBridgeSkills — no false positives', () => {
  it('returns [] for empty or whitespace text', () => {
    expect(classifyBridgeSkills('')).toEqual([])
    expect(classifyBridgeSkills('   ')).toEqual([])
  })

  it('returns [] for plain text with no bridge intent', () => {
    expect(classifyBridgeSkills('an intro title card that fades in')).toEqual([])
  })

  it('does not over-trigger on substrings (word boundaries)', () => {
    // "timeline" contains "line", "barrier" contains "bar" — neither is a chart
    expect(idsOf('a timeline with a barrier across the outline')).not.toContain('d3-data-visualization')
  })
})

describe('bridgeSkillsForVisualForm — the committed-form router (replaces keyword-guessing)', () => {
  const idsOf = (form: string | undefined | null) => (bridgeSkillsForVisualForm(form) ?? []).map((s) => s.metadata.id)

  it('routes chart form to the d3 skill (an enum cannot miss "The Scoreline" the way keywords do)', () => {
    expect(idsOf('chart')).toContain('d3-data-visualization')
  })
  it('routes 3d form to threejs and diagram form to svg', () => {
    expect(idsOf('3d')).toContain('threejs-3d-scene')
    expect(idsOf('diagram')).toContain('svg-animation')
  })
  it('imagery / stat / text need no renderer bridge → empty (media tools / plain react)', () => {
    expect(bridgeSkillsForVisualForm('imagery')).toEqual([])
    expect(bridgeSkillsForVisualForm('stat')).toEqual([])
    expect(bridgeSkillsForVisualForm('text')).toEqual([])
  })
  it('absent visualForm returns null — the signal to fall back to keyword classify (fan-out path)', () => {
    expect(bridgeSkillsForVisualForm(undefined)).toBeNull()
    expect(bridgeSkillsForVisualForm(null)).toBeNull()
    expect(bridgeSkillsForVisualForm('')).toBeNull()
  })
})

describe('drift (T4) — every rule target resolves to a non-null skill', () => {
  it('resolves each BRIDGE_RULES sceneType via loadSkillForSceneType', () => {
    for (const rule of BRIDGE_RULES) {
      const skill = loadSkillForSceneType(rule.sceneType)
      expect(skill, `rule sceneType '${rule.sceneType}' must resolve to a real skill`).not.toBeNull()
      // and the resolved skill's own sceneType matches the rule target (no aliasing)
      expect(skill?.metadata.sceneType).toBe(rule.sceneType)
    }
  })
})
