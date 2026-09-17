/**
 * Hierarchical agent configuration resolution.
 *
 * Merges configuration from three levels (org → project → session) using
 * a deep-merge strategy where later sources override earlier ones.
 * This centralizes the scattered config fields from RunnerOptions,
 * WorldStateMutable, and the API request body into a single typed object.
 */

import type { APIPermissions } from '../types'
import type { ModelId, ModelTier, ThinkingMode, CompactionConfig } from './types'

// ── Agent Config ────────────────────────────────────────────────────────────

export interface AgentModelsConfig {
  /** Default model tier selection strategy */
  defaultTier: ModelTier
  /** Which model IDs are enabled for use */
  enabledModelIds?: string[]
  /** Explicit model ID override (bypasses tier logic) */
  modelOverride?: ModelId | null
  /** Thinking mode for extended reasoning */
  thinkingMode: ThinkingMode
}

export interface AgentToolsConfig {
  /** Whitelist of active tools (undefined = all available) */
  activeTools?: string[]
  /** Blacklist of disabled tools */
  disabledTools?: string[]
}

export interface AgentLimitsConfig {
  /** Max total tool calls per run including sub-agents (default: 50) */
  maxToolCalls?: number
  // maxIterations / maxSessionSpend / maxMonthlySpend were dead scaffolding —
  // this resolver isn't wired into the runner (RunnerOptions.maxIterations /
  // rc.maxToolIterations bound the loop; the RunCostLedger enforces spend), and
  // nothing read those fields. Removed rather than left as a misleading knob.
}

export interface AgentAudioConfig {
  /** Which audio providers are enabled */
  enabledProviders?: Record<string, boolean>
  /** Default provider + config for auto-selection */
  defaults?: Record<string, { provider: string; config: Record<string, any> }>
}

export interface AgentMediaConfig {
  /** Which media generation providers are enabled */
  enabledProviders?: Record<string, boolean>
  /** Default provider + config for auto-selection */
  defaults?: Record<string, { provider: string; config: Record<string, any> }>
}

export interface AgentStyleConfig {
  /** Default style preset for new projects */
  defaultPreset?: string
  /** If true, agents cannot change the preset */
  enforcePreset?: boolean
}

export interface AgentGenerationOverrides {
  [key: string]: {
    provider?: string
    prompt?: string
    config?: Record<string, any>
  }
}

/**
 * Unified agent configuration — the single source of truth for all
 * configurable agent behavior. Resolved once per request from the
 * org/project/session config hierarchy.
 */
export interface AgentConfig {
  models: AgentModelsConfig
  tools: AgentToolsConfig
  limits: AgentLimitsConfig
  permissions?: APIPermissions
  audio: AgentAudioConfig
  media: AgentMediaConfig
  style: AgentStyleConfig
  /** Per-generation-type provider/prompt overrides */
  generationOverrides?: AgentGenerationOverrides
  /** Compaction settings for session history */
  compaction: CompactionConfig
  /** Session-scoped permission grants (e.g. after user approves a tool) */
  sessionPermissions?: Record<string, string>
  // No `hooks` field: the hooks that run are the built-in ones
  // (built-in-hooks.ts → registerBuiltInHooks, called at agent-runner.ts module load).
}
