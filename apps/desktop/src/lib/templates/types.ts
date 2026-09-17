import type { SceneLayer, SceneStyleOverride } from '../types'

export type TemplateCategory =
  | 'title-card'
  | 'diagram'
  | 'comparison'
  | 'data'
  | 'process'
  | 'quote'
  | 'transition'
  | 'chalkboard'
  | 'technical'
  | 'interactive'
  | 'custom'

export interface SceneTemplate {
  id: string
  name: string
  description: string
  category: TemplateCategory
  tags: string[]
  thumbnail: string | null

  layers: Omit<SceneLayer, 'id'>[]
  duration: number
  styleOverride: SceneStyleOverride

  isBuiltIn: boolean
  isPublic: boolean
  authorId: string | null
  useCount: number
  createdAt: string

  placeholders: string[]

  /** Pre-configured interactions for interactive templates.
   *  Each interaction omits `id` (generated during instantiation).
   *  Uses Record to allow type-specific fields from the union. */
  interactions?: Array<Record<string, any>>
}
