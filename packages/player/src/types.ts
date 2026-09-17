// Shared types for the player package (mirrors src/lib/types.ts subset)

import type { TransitionType } from '../../../apps/desktop/src/lib/transitions'
export type { TransitionType }

export type SceneType = 'svg' | 'canvas2d' | 'motion' | 'd3' | 'three' | 'lottie' | 'zdog'

export interface SceneNode {
  id: string
  position: { x: number; y: number }
}

export interface EdgeCondition {
  type: 'auto' | 'hotspot' | 'choice' | 'quiz' | 'gate' | 'variable'
  interactionId: string | null
  variableName: string | null
  variableValue: string | null
}

export interface SceneEdge {
  id: string
  fromSceneId: string
  toSceneId: string
  condition: EdgeCondition
}

export interface SceneGraph {
  nodes: SceneNode[]
  edges: SceneEdge[]
  startSceneId: string
}

export interface BaseInteraction {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  appearsAt: number
  hidesAt: number | null
  entranceAnimation: 'fade' | 'slide-up' | 'pop' | 'none'
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

export interface TooltipElement extends BaseInteraction {
  type: 'tooltip'
  triggerShape: 'circle' | 'pill' | 'rounded' | 'square' | 'rectangle'
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

export interface SceneVariable {
  name: string
}

export interface PublishedScene {
  id: string
  type: SceneType
  duration: number
  htmlUrl: string
  htmlContent: string | null
  interactions: InteractionElement[]
  variables: SceneVariable[]
  transition: TransitionType
}

export interface PlayerOptions {
  theme: 'dark' | 'light' | 'transparent'
  showProgressBar: boolean
  showSceneNav: boolean
  allowFullscreen: boolean
  brandColor: string
  autoplay: boolean
}

export interface PublishedProject {
  id: string
  version: number
  name: string
  playerOptions: PlayerOptions
  sceneGraph: SceneGraph
  scenes: PublishedScene[]
}

export type PlayerEvent = 'sceneChange' | 'interactionFired' | 'completed' | 'variableSet' | 'quizAnswered'
