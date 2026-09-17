/**
 * Post-run memory extraction — observes agent results and extracts
 * persistent learnings about user preferences.
 *
 * Rule-based extraction (no LLM cost). Called fire-and-forget after
 * a successful agent run completes.
 */

import type { AgentType, ToolCallRecord } from './types'
import type { GlobalStyle } from '../types'

export interface MemoryExtraction {
  category: 'style' | 'content' | 'workflow' | 'feedback'
  key: string
  value: string
  confidence: number
}

/**
 * Extract persistent memories from a completed agent run.
 * Returns a list of memory entries to upsert into the user_memory table.
 */
export function extractMemories(
  agentType: AgentType,
  toolCalls: ToolCallRecord[],
  globalStyle?: GlobalStyle,
): MemoryExtraction[] {
  const memories: MemoryExtraction[] = []

  // ── Style preferences ──────────────────────────────────────────────────

  // If set_global_style was called, the user (via the agent) chose a style
  const styleCalls = toolCalls.filter((tc) => tc.toolName === 'set_style' && tc.output?.success)
  if (styleCalls.length > 0) {
    const lastStyle = styleCalls[styleCalls.length - 1]
    const input = lastStyle.input as Record<string, unknown>

    if (input.presetId) {
      memories.push({
        category: 'style',
        key: 'preferred_preset',
        value: String(input.presetId),
        confidence: 0.6,
      })
    }
    if (input.palette && Array.isArray(input.palette)) {
      memories.push({
        category: 'style',
        key: 'preferred_palette',
        value: JSON.stringify(input.palette),
        confidence: 0.5,
      })
    }
    if (input.font) {
      memories.push({
        category: 'style',
        key: 'preferred_font',
        value: String(input.font),
        confidence: 0.5,
      })
    }
  }

  // If globalStyle has a preset, record it as a weaker signal
  if (globalStyle?.presetId && styleCalls.length === 0) {
    memories.push({
      category: 'style',
      key: 'current_preset',
      value: globalStyle.presetId,
      confidence: 0.3,
    })
  }

  // ── Content preferences ────────────────────────────────────────────────

  // Track scene type distribution from add_layer calls
  const layerCalls = toolCalls.filter((tc) => tc.toolName === 'add_layer' && tc.output?.success)
  if (layerCalls.length >= 2) {
    const typeCounts = new Map<string, number>()
    for (const lc of layerCalls) {
      const sceneType = (lc.input as Record<string, unknown>).sceneType as string
      if (sceneType) {
        typeCounts.set(sceneType, (typeCounts.get(sceneType) || 0) + 1)
      }
    }

    // Find dominant scene type (used 50%+ of the time)
    const dominant = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]
    if (dominant && dominant[1] >= layerCalls.length * 0.5) {
      memories.push({
        category: 'content',
        key: 'preferred_scene_type',
        value: dominant[0],
        confidence: Math.min(0.8, 0.4 + dominant[1] * 0.1),
      })
    }
  }

  // Track if narration is typically added
  const narrationCalls = toolCalls.filter((tc) => tc.toolName === 'add_narration' && tc.output?.success)
  const sceneCalls = toolCalls.filter((tc) => tc.toolName === 'create_scene' && tc.output?.success)
  if (sceneCalls.length >= 2) {
    const narrationRatio = narrationCalls.length / sceneCalls.length
    if (narrationRatio >= 0.7) {
      memories.push({
        category: 'content',
        key: 'prefers_narration',
        value: 'true',
        confidence: 0.6,
      })
    } else if (narrationRatio === 0 && sceneCalls.length >= 3) {
      memories.push({
        category: 'content',
        key: 'prefers_narration',
        value: 'false',
        confidence: 0.5,
      })
    }
  }

  // ── Workflow preferences ───────────────────────────────────────────────

  // Did the agent use plan_scenes? This indicates planning preference
  const planCalls = toolCalls.filter((tc) => tc.toolName === 'plan_scenes' && tc.output?.success)
  if (planCalls.length > 0) {
    memories.push({
      category: 'workflow',
      key: 'prefers_planning',
      value: 'true',
      confidence: 0.5,
    })
  }

  // Track if charts/data viz is commonly used
  const chartCalls = toolCalls.filter((tc) => tc.toolName === 'chart' && tc.output?.success)
  if (chartCalls.length >= 2) {
    memories.push({
      category: 'content',
      key: 'uses_data_viz',
      value: 'true',
      confidence: 0.6,
    })
  }

  // Track avatar usage
  const avatarCalls = toolCalls.filter((tc) => tc.toolName.startsWith('generate_avatar') && tc.output?.success)
  if (avatarCalls.length > 0) {
    memories.push({
      category: 'content',
      key: 'uses_avatars',
      value: 'true',
      confidence: 0.6,
    })
  }

  // ── Failure patterns ────────────────────────────────────────────────

  // Track scene types that consistently fail generation
  const failedLayers = toolCalls.filter((tc) => tc.toolName === 'add_layer' && !tc.output?.success)
  if (failedLayers.length >= 2) {
    const failTypeCounts = new Map<string, number>()
    for (const fl of failedLayers) {
      const sceneType = (fl.input as Record<string, unknown>).sceneType as string
      if (sceneType) failTypeCounts.set(sceneType, (failTypeCounts.get(sceneType) || 0) + 1)
    }
    for (const [type, count] of failTypeCounts) {
      if (count >= 2) {
        memories.push({
          category: 'feedback',
          key: `scene_type_failure_${type}`,
          value: `${type} generation failed ${count} times in this run — consider alternative renderer`,
          confidence: Math.min(0.7, 0.3 + count * 0.1),
        })
      }
    }
  }

  // Track if regenerate_layer was called often (indicates quality issues)
  const regenCalls = toolCalls.filter((tc) => tc.toolName === 'regenerate_layer')
  if (regenCalls.length >= 3) {
    memories.push({
      category: 'feedback',
      key: 'high_regeneration_rate',
      value: `${regenCalls.length} regeneration calls in one run — prompts may need refinement`,
      confidence: 0.5,
    })
  }

  return memories
}
