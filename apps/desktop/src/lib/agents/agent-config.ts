/**
 * Agent config types for Dreambyte.
 *
 * The multi-agent persona registry was removed — there is one unified agent
 * (Master Builder). `AgentCategory` is still used by the settings UI; the
 * `AgentConfig` shape is kept for any config-shaped data. There is no longer a
 * default agent list — specialization happens via Skills & Rules.
 */

import type { ThinkingMode } from './types'

// ── Types ──────────────────────────────────────────────────────────────────────

export type AgentCategory = 'general' | 'animation' | 'style' | 'data' | 'custom'

/**
 * Configuration for a single AI agent.
 */
export interface AgentConfig {
  /** Stable identifier — used as the agent type key in API requests */
  id: string
  /** Display name shown in UI */
  name: string
  /** One-line description of what this agent does */
  description: string
  /** lucide-react icon name */
  icon: string
  /** Hex color for the agent's badge/border in chat */
  color: string
  /** Full system prompt injected at the start of every conversation */
  systemPrompt: string
  /** Which model tier this agent defaults to when the user has set "auto". */
  defaultModelTier: 'budget' | 'balanced' | 'performance'
  /** Tool names this agent is allowed to call */
  toolAccess: string[]
  /** True = shipped with Dreambyte; prompt can be edited but agent cannot be deleted */
  isBuiltIn: boolean
  /** When false the agent is hidden from the agent selector */
  isEnabled: boolean
  /** Paths to knowledge/rule files to inject into context */
  knowledgeFiles?: string[]
  category: AgentCategory
  /** For Director agents: which narrative template to use (explainer, onboarding, product-demo) */
  directorTemplate?: string
  /** Default thinking mode for this agent. Defaults to 'adaptive' if not set. */
  defaultThinkingMode?: ThinkingMode
}
