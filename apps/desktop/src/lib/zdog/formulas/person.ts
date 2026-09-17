import type {
  ZdogAccessoryType,
  ZdogBodyStyle,
  ZdogEyeStyle,
  ZdogFaceStyle,
  ZdogHairStyle,
  ZdogMouthStyle,
  ZdogNoseStyle,
  ZdogPersonFormula,
  ZdogPersonPalette,
  ZdogPersonProportions,
} from '@/lib/types'
import { mulberry32, pick, range } from '../core/rng'

const FACE_STYLES: ZdogFaceStyle[] = ['friendly', 'serious', 'curious']
const HAIR_STYLES: ZdogHairStyle[] = ['curls', 'short', 'bob', 'bun', 'flat']
const EYE_STYLES: ZdogEyeStyle[] = ['dot', 'almond', 'wide']
const MOUTH_STYLES: ZdogMouthStyle[] = ['smile', 'neutral', 'grin']
const NOSE_STYLES: ZdogNoseStyle[] = ['dot', 'line', 'button']
const ACCESSORIES: ZdogAccessoryType[] = ['glasses', 'tablet', 'badge']

/** From `src/lib/zdog/reference/zdog_person_hair_fix2.html` (#EA0 skin, #C25 top, #636 bottom, etc.). */
export const ZDOG_REFERENCE_DEMO_PALETTE: ZdogPersonPalette = {
  skin: '#eeaa00',
  hair: '#5c3a1e',
  top: '#cc2255',
  bottom: '#663366',
  accent: '#222222',
}

const PALETTES: ZdogPersonPalette[] = [
  ZDOG_REFERENCE_DEMO_PALETTE,
  { skin: '#f2c8a2', hair: '#5a3c2a', top: '#2563eb', bottom: '#334155', accent: '#e84545' },
  { skin: '#d9a47c', hair: '#1f2937', top: '#7c3aed', bottom: '#0f766e', accent: '#f59e0b' },
  { skin: '#f0b58a', hair: '#7f1d1d', top: '#16a34a', bottom: '#1e293b', accent: '#ec4899' },
]

/** HTML reference head stroke; limbs in that file are in this unit space. */
const REF_HTML_HEAD = 12

function buildProportions(rng: () => number): ZdogPersonProportions {
  return {
    head: 16,
    torso: range(rng, 9.5, 15),
    upperArm: range(rng, 4.8, 9),
    forearm: range(rng, 4.2, 8),
    upperLeg: range(rng, 6.5, 11),
    lowerLeg: range(rng, 6, 10),
  }
}

/** Floors for limb length + bulk so characters read as adults, not stick figures. */
const PROPER_SHAPE_MINS: { proportions: Partial<ZdogPersonProportions>; bodyStyle: ZdogBodyStyle } = {
  proportions: {
    torso: 10.5,
    upperArm: 5.2,
    forearm: 5,
    upperLeg: 7.2,
    lowerLeg: 6.8,
  },
  bodyStyle: {
    torsoWidth: 3.4,
    armThickness: 6.4,
    legThickness: 7.2,
    hipWidth: 3.4,
  },
}

/**
 * Seeded variety (palette, face, hair style, etc.) with guaranteed sane proportions and bulk.
 * Use this for the character builder baseline and anywhere a “default person” is needed.
 */
export function createProperPersonFromSeed(seed: number): ZdogPersonFormula {
  const base = createPersonFormulaFromSeed(seed)
  const p = base.proportions
  const b: ZdogBodyStyle = base.bodyStyle ?? {
    torsoWidth: 2.2,
    armThickness: 4.85,
    legThickness: 5.0,
    hipWidth: 2.8,
  }
  const m = PROPER_SHAPE_MINS
  return mergePersonFormula(base, {
    proportions: {
      head: 16,
      torso: Math.max(p.torso, m.proportions.torso!),
      upperArm: Math.max(p.upperArm, m.proportions.upperArm!),
      forearm: Math.max(p.forearm, m.proportions.forearm!),
      upperLeg: Math.max(p.upperLeg, m.proportions.upperLeg!),
      lowerLeg: Math.max(p.lowerLeg, m.proportions.lowerLeg!),
    },
    bodyStyle: {
      torsoWidth: Math.max(b.torsoWidth, m.bodyStyle.torsoWidth),
      armThickness: Math.max(b.armThickness, m.bodyStyle.armThickness),
      legThickness: Math.max(b.legThickness, m.bodyStyle.legThickness),
      hipWidth: Math.max(b.hipWidth, m.bodyStyle.hipWidth),
    },
  })
}

export function createPersonFormulaFromSeed(seed: number): ZdogPersonFormula {
  const rng = mulberry32(seed)
  const accessoryCount = Math.floor(range(rng, 0, 3))
  const accessories: ZdogAccessoryType[] = []

  for (let i = 0; i < accessoryCount; i += 1) {
    const candidate = pick(rng, ACCESSORIES)
    if (!accessories.includes(candidate)) accessories.push(candidate)
  }

  return {
    seed,
    palette: pick(rng, PALETTES),
    proportions: buildProportions(rng),
    faceStyle: pick(rng, FACE_STYLES),
    hairStyle: pick(rng, HAIR_STYLES),
    hairProfile: {
      size: 1.05,
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      offsetX: 0.0,
      offsetY: 3.52,
      offsetZ: 0.0,
    },
    faceProfile: {
      eyesY: 0,
      noseY: 0,
      mouthY: 0,
      depthZ: 0,
    },
    bodyDepth: { hipsZ: 0, spineZ: 0 },
    headProfile: {
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
      rotateY: 0,
      rotateX: 0,
      rotateZ: 0,
    },
    eyeStyle: pick(rng, EYE_STYLES),
    mouthStyle: pick(rng, MOUTH_STYLES),
    noseStyle: pick(rng, NOSE_STYLES),
    bodyStyle: {
      torsoWidth: range(rng, 2.6, 5.8),
      armThickness: range(rng, 4.8, 10),
      legThickness: range(rng, 5.2, 11),
      hipWidth: range(rng, 2.6, 5.5),
    },
    accessories,
    motionProfile: {
      idleAmplitude: range(rng, 0.6, 1.2),
      gestureBias: range(rng, 0.5, 1.1),
      walkAmplitude: range(rng, 0.8, 1.3),
    },
    studioBlocks: [],
  }
}

export function mergePersonFormula(base: ZdogPersonFormula, overrides?: Partial<ZdogPersonFormula>): ZdogPersonFormula {
  if (!overrides) return base
  const mergedHead = 16
  return {
    ...base,
    ...overrides,
    palette: { ...base.palette, ...(overrides.palette ?? {}) },
    proportions: { ...base.proportions, ...(overrides.proportions ?? {}), head: mergedHead },
    motionProfile: { ...base.motionProfile, ...(overrides.motionProfile ?? {}) },
    bodyStyle: { ...(base.bodyStyle ?? {}), ...(overrides.bodyStyle ?? {}) },
    hairProfile: { ...(base.hairProfile ?? {}), ...(overrides.hairProfile ?? {}) },
    faceProfile: { ...(base.faceProfile ?? {}), ...(overrides.faceProfile ?? {}) },
    headProfile: { ...(base.headProfile ?? {}), ...(overrides.headProfile ?? {}) },
    bodyDepth: {
      hipsZ: 0,
      spineZ: 0,
      ...(base.bodyDepth ?? {}),
      ...(overrides.bodyDepth ?? {}),
    },
    accessories: overrides.accessories ?? base.accessories,
    studioBlocks: overrides.studioBlocks !== undefined ? overrides.studioBlocks : base.studioBlocks,
  } as ZdogPersonFormula
}

/**
 * Same look as `reference/zdog_person_hair_fix2.html`: palette, curl hair, limb lengths
 * (arm 6 / leg 7 in ref units scaled to head 16), stroke-4 body, no hair offset / accessories.
 * Seeded face/eye/mouth/nose/motion variety still comes from the underlying proper-person base.
 */
export function createReferenceDemoPersonFromSeed(seed: number): ZdogPersonFormula {
  const base = createProperPersonFromSeed(seed)
  const h = 16
  return mergePersonFormula(base, {
    hairStyle: 'curls',
    palette: ZDOG_REFERENCE_DEMO_PALETTE,
    proportions: {
      ...base.proportions,
      head: h,
      upperArm: (6 * h) / REF_HTML_HEAD,
      forearm: (6 * h) / REF_HTML_HEAD,
      upperLeg: (7 * h) / REF_HTML_HEAD,
      lowerLeg: (7 * h) / REF_HTML_HEAD,
    },
    bodyStyle: {
      torsoWidth: 2.2,
      armThickness: 4,
      legThickness: 4,
      hipWidth: 2.8,
    },
    hairProfile: {
      size: 1.05,
      rotateX: 0,
      rotateY: 0,
      rotateZ: 0,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
    },
    faceProfile: { eyesY: 0, noseY: 0, mouthY: 0, depthZ: 0 },
    headProfile: { offsetX: 0, offsetY: 0, offsetZ: 0, rotateY: 0, rotateX: 0, rotateZ: 0 },
    bodyDepth: { hipsZ: 0, spineZ: 0 },
    studioBlocks: [],
    accessories: [],
  })
}
