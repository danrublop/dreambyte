/**
 * Bridge-skill classification.
 *
 * A scene legitimately stays `sceneType: 'react'` (the product default) yet often
 * leans on a bridge layer — `<ThreeJSLayer>`, `<D3Layer>`, `<Canvas2DLayer>`,
 * `<SVGLayer>`, `<LottieLayer>`. Base-renderer injection keys on `sceneType`, and react
 * resolves to no dedicated skill, so that bridge's guide never auto-loads. This
 * module closes that gap: it reads the planner's intent text (purpose + name) and
 * deterministically picks the bridge skills to inject ALONGSIDE the base renderer
 * guide — without ever changing the planner's `sceneType`.
 *
 * Determinism lives here (one module, pure, no model). Multi-label by design: a
 * "bar chart orbiting a 3D globe" pulls in BOTH the d3 and three guides.
 *
 * Each rule targets a dedicated-renderer `sceneType` and resolves it through the
 * SAME registry the base injection uses (`loadSkillForSceneType`), so a rule can
 * never inject a non-existent guide — a skill-less or misspelled target resolves
 * to null and is silently dropped (covered by the drift test).
 */

import { loadSkillForSceneType } from '../skills/registry'
import type { SkillContent } from '../skills/types'

export interface BridgeRule {
  /**
   * The dedicated-renderer `sceneType` this rule maps to. Resolved to a skill via
   * `loadSkillForSceneType` — NEVER a free-form skill id — so the rule target is
   * exactly what the registry can produce (and the drift test asserts it does).
   */
  sceneType: string
  /** Word-boundary keyword patterns that signal this bridge's intent. */
  patterns: RegExp[]
}

/**
 * Keyword → bridge `sceneType` rules. Patterns use word boundaries so common
 * substrings don't over-trigger (`line` matches "line" but not "timeline";
 * `bar` matches "bar" but not "barrier"). Text is lower-cased before matching,
 * so the patterns themselves need no case-insensitive flag.
 */
export const BRIDGE_RULES: BridgeRule[] = [
  { sceneType: 'three', patterns: [/\b3d\b/, /\bscatter\b/, /\bglobe\b/, /\borbit\b/] },
  { sceneType: 'd3', patterns: [/\bchart\b/, /\bbar\b/, /\bline\b/, /\bgraph\b/, /\bplot\b/] },
  { sceneType: 'canvas2d', patterns: [/\bhand-drawn\b/, /\bsketch\b/, /\bparticles?\b/] },
  { sceneType: 'svg', patterns: [/\bdraw-on\b/, /\bvector\b/] },
  { sceneType: 'lottie', patterns: [/\bicon\b/, /\bmicro\b/] },
]

/**
 * Classify free-form scene-intent text into the bridge skills it implies.
 *
 * Pure (no model, no IO beyond the in-memory skill registry). Multi-label: every
 * rule whose keywords match contributes its resolved skill. Targets that resolve
 * to null (skill-less / misspelled `sceneType`) are dropped, and the result is
 * deduped by skill id so the same guide is never injected twice.
 */
export function classifyBridgeSkills(text: string): SkillContent[] {
  if (!text) return []
  const haystack = text.toLowerCase()
  const out: SkillContent[] = []
  const seen = new Set<string>()

  for (const rule of BRIDGE_RULES) {
    if (!rule.patterns.some((re) => re.test(haystack))) continue
    const skill = loadSkillForSceneType(rule.sceneType)
    if (!skill) continue // skill-less / misspelled target → drop, never crash
    if (seen.has(skill.metadata.id)) continue
    seen.add(skill.metadata.id)
    out.push(skill)
  }

  return out
}

/** The committed visual form → the renderer bridge skill it needs. imagery/stat/text
 *  need no renderer bridge (media tools / plain react). This is the DIRECT replacement
 *  for keyword-matching a beat's name/purpose — an enum can't miss "scoreline" the way
 *  /\bchart\b/ does. */
const VISUAL_FORM_TO_SCENE_TYPE: Record<string, string | null> = {
  chart: 'd3',
  diagram: 'svg',
  '3d': 'three',
  imagery: null,
  stat: null,
  text: null,
}

/**
 * Resolve a beat's committed `visualForm` to its bridge skill(s).
 * Returns `null` when no visualForm is set — the signal for the caller to fall back to
 * the keyword `classifyBridgeSkills` (the blind fan-out / branch-variant path, which has
 * no art_direct pass, still gets a guide). Returns `[]` for a form that needs no bridge.
 */
export function bridgeSkillsForVisualForm(visualForm: string | undefined | null): SkillContent[] | null {
  if (!visualForm) return null
  const sceneType = VISUAL_FORM_TO_SCENE_TYPE[visualForm]
  if (!sceneType) return []
  const skill = loadSkillForSceneType(sceneType)
  return skill ? [skill] : []
}
