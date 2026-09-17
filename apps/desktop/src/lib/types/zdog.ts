// ── Zdog Reusable Person System ───────────────────────────────────────────────

export type ZdogFaceStyle = 'friendly' | 'serious' | 'curious'
export type ZdogHairStyle = 'short' | 'bob' | 'bun' | 'flat' | 'curls'
export type ZdogEyeStyle = 'dot' | 'almond' | 'wide'
export type ZdogMouthStyle = 'smile' | 'neutral' | 'grin'
export type ZdogNoseStyle = 'dot' | 'line' | 'button'
export type ZdogAccessoryType = 'glasses' | 'hat' | 'tablet' | 'badge'
export type ZdogAnimationPreset =
  | 'idleBreath'
  | 'talkNod'
  | 'wave'
  | 'pointLeft'
  | 'pointRight'
  | 'present'
  | 'walkInPlace'

export interface ZdogPersonPalette {
  skin: string
  hair: string
  top: string
  bottom: string
  accent: string
}

export interface ZdogPersonProportions {
  head: number
  torso: number
  upperArm: number
  forearm: number
  upperLeg: number
  lowerLeg: number
}

export interface ZdogMotionProfile {
  idleAmplitude: number
  gestureBias: number
  walkAmplitude: number
}

export interface ZdogBodyStyle {
  torsoWidth: number
  armThickness: number
  legThickness: number
  hipWidth: number
}

export interface ZdogHairProfile {
  size: number
  rotateX: number
  rotateY: number
  rotateZ: number
  offsetX: number
  offsetY: number
  offsetZ: number
}

export interface ZdogFaceProfile {
  eyesY: number
  noseY: number
  mouthY: number
  /** Global forward/back offset added to all face feature Z (rig units). */
  depthZ: number
  /** Extra lateral shift for both eyes (added to ±2). */
  eyesX?: number
  /** Per-feature forward/back vs `depthZ` baseline. */
  eyesZ?: number
  noseX?: number
  noseZ?: number
  mouthX?: number
  mouthZ?: number
}

/** Fine head placement on the neck (rig space). */
export interface ZdogHeadProfile {
  offsetX: number
  offsetY: number
  offsetZ: number
  rotateY: number
  rotateX?: number
  rotateZ?: number
}

/** Whole-body Z layering on the rig (use Illustration → Root Z for scene depth). */
export interface ZdogBodyDepthProfile {
  /** Hips anchor Z on character root. */
  hipsZ: number
  /** Spine anchor Z on hips (shifts torso/arms/head vs legs). */
  spineZ: number
}

export type ZdogStudioBlockKind = 'box' | 'sphere' | 'cylinder'

/**
 * Extra Zdog primitives parented to the person root (move/scale with the character).
 * Box: w,h,d = width,height,depth. Sphere: w = stroke diameter. Cylinder: w = diameter, d = length on Y, stroke = edge thickness.
 */
export interface ZdogStudioBlock {
  id: string
  kind: ZdogStudioBlockKind
  name?: string
  x: number
  y: number
  z: number
  w: number
  h: number
  d: number
  rotateX: number
  rotateY: number
  rotateZ: number
  color: string
  stroke?: number
}

export interface ZdogPersonFormula {
  seed: number
  palette: ZdogPersonPalette
  proportions: ZdogPersonProportions
  faceStyle: ZdogFaceStyle
  hairStyle: ZdogHairStyle
  hairProfile?: ZdogHairProfile
  faceProfile?: ZdogFaceProfile
  headProfile?: ZdogHeadProfile
  eyeStyle?: ZdogEyeStyle
  mouthStyle?: ZdogMouthStyle
  noseStyle?: ZdogNoseStyle
  bodyStyle?: ZdogBodyStyle
  /** Optional Z offsets for major groups (all directions via face/head/hair + this). */
  bodyDepth?: ZdogBodyDepthProfile
  accessories: ZdogAccessoryType[]
  motionProfile: ZdogMotionProfile
  /** Props / set pieces in character-local space (Zdog studio blocks). */
  studioBlocks?: ZdogStudioBlock[]
}

export interface ZdogPersonPlacement {
  x: number
  y: number
  z: number
  scale?: number
  rotationY?: number
}

export type ZdogModuleType = 'barChart' | 'lineChart' | 'donutChart' | 'presentationBoard' | 'desk' | 'tablet'

export interface ZdogModuleConfig {
  id: string
  type: ZdogModuleType
  x: number
  y: number
  z: number
  scale?: number
  color?: string
  data?: number[]
  labels?: string[]
}

export interface ZdogBeat {
  at: number
  action: ZdogAnimationPreset
  targetPersonId: string
  duration?: number
}

export interface ZdogComposedSceneSpec {
  seed: number
  title?: string
  people: Array<{
    id: string
    assetId?: string
    formula?: Partial<ZdogPersonFormula>
    placement: ZdogPersonPlacement
  }>
  modules: ZdogModuleConfig[]
  beats: ZdogBeat[]
}

export interface ZdogPersonAsset {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  formula: ZdogPersonFormula
  tags?: string[]
}
