export interface SceneUsage {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

// ── Interaction Style System ──────────────────────────────────────────────────

export type InteractionStylePreset =
  | 'glass'
  | 'glass-warm'
  | 'glass-cool'
  | 'glass-dark'
  | 'professional'
  | 'solid'
  | 'solid-light'
  | 'solid-dark'
  | 'minimal'
  | 'outline'
  | 'gradient'
  | 'neon'
  | 'custom'

export interface InteractionStyle {
  preset: InteractionStylePreset
  bgColor: string
  bgOpacity: number
  blur: number
  borderColor: string
  borderOpacity: number
  borderWidth: number
  borderRadius: number
  shadowColor: string
  shadowOpacity: number
  shadowSpread: number
  innerGlow: number
  fontFamily: string
  fontSize: number
  fontWeight: number
  textColor: string
  textAlign: 'left' | 'center' | 'right'
  letterSpacing: number
  paddingX: number
  paddingY: number
  gap: number
  hoverScale: number
  hoverBrightness: number
  transitionSpeed: number
  accentColor: string
}

/** Backwards compat — old type alias */
export type InteractionGlassStyle = InteractionStyle

const _base: InteractionStyle = {
  preset: 'glass',
  bgColor: '#ffffff',
  bgOpacity: 0.15,
  blur: 20,
  borderColor: '#ffffff',
  borderOpacity: 0.3,
  borderWidth: 1,
  borderRadius: 20,
  shadowColor: '#000000',
  shadowOpacity: 0.1,
  shadowSpread: 32,
  innerGlow: 0.5,
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 15,
  fontWeight: 600,
  textColor: '#ffffff',
  textAlign: 'center',
  letterSpacing: 0,
  paddingX: 28,
  paddingY: 24,
  gap: 10,
  hoverScale: 1.02,
  hoverBrightness: 1.1,
  transitionSpeed: 200,
  accentColor: '#e84545',
}

export const STYLE_PRESETS: Record<InteractionStylePreset, InteractionStyle> = {
  glass: { ..._base, preset: 'glass' },
  'glass-warm': {
    ..._base,
    preset: 'glass-warm',
    bgColor: '#fff5e6',
    borderColor: '#fff5e6',
    innerGlow: 0.7,
    bgOpacity: 0.18,
  },
  'glass-cool': {
    ..._base,
    preset: 'glass-cool',
    bgColor: '#e0f2fe',
    borderColor: '#e0f2fe',
    blur: 28,
    borderOpacity: 0.4,
    shadowSpread: 40,
  },
  'glass-dark': {
    ..._base,
    preset: 'glass-dark',
    bgColor: '#000000',
    bgOpacity: 0.6,
    blur: 24,
    borderColor: '#ffffff',
    borderOpacity: 0.15,
    innerGlow: 0.2,
  },
  /** Legible, low-noise panels for explainers & B2B — light surface, slate type, restrained blue accent */
  professional: {
    ..._base,
    preset: 'professional',
    bgColor: '#f1f5f9',
    bgOpacity: 0.96,
    blur: 6,
    borderColor: '#94a3b8',
    borderOpacity: 0.55,
    borderWidth: 1,
    borderRadius: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowSpread: 18,
    innerGlow: 0,
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: 15,
    fontWeight: 600,
    textColor: '#0f172a',
    textAlign: 'left',
    letterSpacing: 0.01,
    paddingX: 22,
    paddingY: 18,
    gap: 10,
    hoverScale: 1.01,
    hoverBrightness: 1,
    transitionSpeed: 180,
    accentColor: '#2563eb',
  },
  solid: {
    ..._base,
    preset: 'solid',
    bgColor: '#1a1a2e',
    bgOpacity: 1,
    blur: 0,
    borderColor: '#2a2a4a',
    borderOpacity: 0.8,
    borderRadius: 12,
    innerGlow: 0,
    shadowSpread: 24,
  },
  'solid-light': {
    ..._base,
    preset: 'solid-light',
    bgColor: '#ffffff',
    bgOpacity: 0.95,
    blur: 0,
    borderColor: '#e5e5e5',
    borderOpacity: 0.8,
    textColor: '#111111',
    innerGlow: 0,
    shadowColor: '#000000',
    shadowOpacity: 0.08,
  },
  'solid-dark': {
    ..._base,
    preset: 'solid-dark',
    bgColor: '#0f0f14',
    bgOpacity: 0.95,
    blur: 0,
    borderColor: '#222222',
    borderOpacity: 0.6,
    innerGlow: 0,
    textColor: '#eeeeee',
  },
  minimal: {
    ..._base,
    preset: 'minimal',
    bgColor: '#ffffff',
    bgOpacity: 0,
    blur: 0,
    borderColor: '#ffffff',
    borderOpacity: 0.2,
    borderWidth: 1,
    borderRadius: 8,
    innerGlow: 0,
    shadowSpread: 0,
    shadowOpacity: 0,
  },
  outline: {
    ..._base,
    preset: 'outline',
    bgColor: '#ffffff',
    bgOpacity: 0,
    blur: 0,
    borderColor: '#ffffff',
    borderOpacity: 0.5,
    borderWidth: 2,
    borderRadius: 12,
    innerGlow: 0,
    shadowSpread: 0,
    shadowOpacity: 0,
  },
  gradient: {
    ..._base,
    preset: 'gradient',
    bgColor: '#6366f1',
    bgOpacity: 0.85,
    blur: 0,
    borderColor: '#ffffff',
    borderOpacity: 0.15,
    innerGlow: 0.3,
    accentColor: '#ec4899',
  },
  neon: {
    ..._base,
    preset: 'neon',
    bgColor: '#000000',
    bgOpacity: 0.8,
    blur: 12,
    borderColor: '#e84545',
    borderOpacity: 0.8,
    borderWidth: 2,
    innerGlow: 0.9,
    shadowColor: '#e84545',
    shadowOpacity: 0.4,
    shadowSpread: 24,
  },
  custom: { ..._base, preset: 'custom' },
}

export const DEFAULT_INTERACTION_STYLE = STYLE_PRESETS['glass']

/** @deprecated Use DEFAULT_INTERACTION_STYLE */
export const DEFAULT_GLASS_STYLE = DEFAULT_INTERACTION_STYLE

// ── Interaction Elements ─────────────────────────────────────────────────────

export interface BaseInteraction {
  id: string
  type: string
  x: number // % of canvas width (0–100)
  y: number // % of canvas height (0–100)
  width: number // % of canvas width
  height: number // % of canvas height
  appearsAt: number // seconds into scene
  hidesAt: number | null // null = stays until scene ends
  entranceAnimation: 'fade' | 'slide-up' | 'pop' | 'none'
  visualStyle?: Partial<InteractionStyle>
}

export interface HotspotElement extends BaseInteraction {
  type: 'hotspot'
  label: string
  shape: 'circle' | 'rectangle' | 'pill'
  style: 'pulse' | 'glow' | 'border' | 'filled'
  color: string
  triggersEdgeId: string | null
  jumpsToSceneId: string | null
}

export interface ChoiceOption {
  id: string
  label: string
  icon: string | null
  jumpsToSceneId: string
  color: string | null
}

export interface ChoiceElement extends BaseInteraction {
  type: 'choice'
  question: string | null
  layout: 'horizontal' | 'vertical' | 'grid'
  options: ChoiceOption[]
}

export interface QuizOption {
  id: string
  label: string
}

export interface QuizElement extends BaseInteraction {
  type: 'quiz'
  question: string
  options: QuizOption[]
  correctOptionId: string
  onCorrect: 'continue' | 'jump'
  onCorrectSceneId: string | null
  onWrong: 'retry' | 'jump' | 'continue'
  onWrongSceneId: string | null
  explanation: string | null
}

export interface GateElement extends BaseInteraction {
  type: 'gate'
  buttonLabel: string
  buttonStyle: 'primary' | 'outline' | 'minimal'
  minimumWatchTime: number
}

export type { TooltipTriggerShape } from '../interactions/tooltip-trigger-css'

export interface TooltipElement extends BaseInteraction {
  type: 'tooltip'
  triggerShape: import('../interactions/tooltip-trigger-css').TooltipTriggerShape
  triggerColor: string
  triggerLabel: string | null
  tooltipTitle: string
  tooltipBody: string
  tooltipPosition: 'top' | 'bottom' | 'left' | 'right'
  tooltipMaxWidth: number
}

export interface FormField {
  id: string
  label: string
  type: 'text' | 'select' | 'radio'
  placeholder: string | null
  options: string[]
  required: boolean
}

export interface FormInputElement extends BaseInteraction {
  type: 'form'
  fields: FormField[]
  submitLabel: string
  setsVariables: { fieldId: string; variableName: string }[]
  jumpsToSceneId: string | null
}

export type InteractionElement =
  | HotspotElement
  | ChoiceElement
  | QuizElement
  | GateElement
  | TooltipElement
  | FormInputElement
  | SliderElement
  | ToggleElement
  | RevealElement
  | CountdownElement

// ── Scene Variables ─────────────────────────────────────────────────────────

export type VariableType = 'string' | 'number' | 'boolean'

export interface SceneVariable {
  name: string
  type?: VariableType // defaults to 'string' for backwards compat
  defaultValue?: string | number | boolean
}

// ── Variable Conditions ─────────────────────────────────────────────────────

export type ConditionOperator =
  | 'eq'       // equals
  | 'neq'      // not equals
  | 'gt'       // greater than (number)
  | 'lt'       // less than (number)
  | 'gte'      // greater than or equal (number)
  | 'lte'      // less than or equal (number)
  | 'contains' // string contains substring
  | 'truthy'   // boolean truthiness check (no value needed)
  | 'falsy'    // boolean falsiness check (no value needed)

export interface VariableCondition {
  variableName: string
  operator: ConditionOperator
  value?: string | number | boolean // not needed for truthy/falsy
}

// ── Slider Interaction ──────────────────────────────────────────────────────

export interface SliderElement extends BaseInteraction {
  type: 'slider'
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  setsVariable: string // variable name to bind to
  showValue: boolean
  unit: string | null // e.g. '%', '$', 'ms'
  trackColor: string | null
  thumbColor: string | null
}

// ── Toggle Interaction ──────────────────────────────────────────────────────

export interface ToggleElement extends BaseInteraction {
  type: 'toggle'
  label: string
  defaultValue: boolean
  setsVariable: string // variable name to bind to
  onLabel: string | null  // e.g. 'ON', 'Enabled'
  offLabel: string | null // e.g. 'OFF', 'Disabled'
  activeColor: string | null
}

// ── Reveal Interaction ──────────────────────────────────────────────────────

export interface RevealElement extends BaseInteraction {
  type: 'reveal'
  triggerLabel: string
  revealedContent: string // HTML or markdown text
  revealAnimation: 'expand' | 'fade' | 'slide-down'
  startRevealed: boolean
}

// ── Countdown Interaction ───────────────────────────────────────────────────

export interface CountdownElement extends BaseInteraction {
  type: 'countdown'
  durationSeconds: number
  label: string | null
  onComplete: 'continue' | 'jump'
  onCompleteSceneId: string | null
  showProgress: boolean
  urgentColor: string | null // color when < 25% remaining
}
