/**
 * Shared LLM → chartLayers → compile path for DreambyteCharts (used by /api/generate-d3 and agent regenerate_layer).
 */

import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '../agents/providers'
import { compileD3SceneFromLayers } from '../charts/compile'
import { autoGridChartLayoutsForLayers, normalizeChartLayersFromStructuredResponse } from '../charts/structured-d3'
import type { D3ChartLayer } from '../types'
import { D3_STRUCTURED_DREAMBYTE_PROMPT } from './prompts'
import { createLogger } from '../logger'

const log = createLogger('generation.d3-structured')

export type StructuredD3GenInput = {
  prompt: string
  palette: string[]
  font: string
  bgColor: string
  duration: number
  previousSummary?: string
  d3Data?: unknown
  /** Anthropic model id; defaults to claude-sonnet-4-6 */
  model?: string
}

export type StructuredD3GenResult = {
  chartLayers: D3ChartLayer[]
  sceneCode: string
  d3Data: unknown
  styles: string
  usage: { input_tokens: number; output_tokens: number }
}

async function generateOnce(client: Anthropic, model: string, systemPrompt: string, userContent: string) {
  const result = await client.messages.create({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  })
  const textBlock = result.content.find((b: any) => b.type === 'text')
  const raw = textBlock?.type === 'text' ? textBlock.text : ''
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const parsed = JSON.parse(cleaned)
  return { result, parsed, raw }
}

/**
 * Calls Anthropic and compiles chartLayers. Throws on parse failure or empty layers after retry.
 */
export async function runStructuredD3Generation(input: StructuredD3GenInput): Promise<StructuredD3GenResult> {
  // BYOK key is read by the unified provider factory; no explicit key check
  // here because the SDK will throw a clear 401 if it's missing.
  const client = getAnthropicClient()
  const model = input.model?.trim() || 'claude-sonnet-4-6'
  const duration = Number.isFinite(input.duration) ? input.duration : 8

  const existingHint = input.d3Data
    ? `Existing chart / data context (refine or replace as the prompt asks):\n${JSON.stringify(input.d3Data, null, 2)}`
    : ''

  const systemPrompt = D3_STRUCTURED_DREAMBYTE_PROMPT(
    input.palette,
    input.font,
    input.bgColor,
    duration,
    input.previousSummary ?? '',
    existingHint,
  )
  const userContent = input.prompt

  let usageInput = 0
  let usageOutput = 0
  let parsed: any
  let raw = ''

  try {
    const first = await generateOnce(client, model, systemPrompt, userContent)
    parsed = first.parsed
    raw = first.raw
    usageInput += first.result.usage.input_tokens
    usageOutput += first.result.usage.output_tokens

    let chartLayers = normalizeChartLayersFromStructuredResponse(parsed, duration)
    if (chartLayers.length === 0) {
      const repairPrompt = `${userContent}

Your previous response did not include a valid non-empty "chartLayers" array. Return JSON only with chartLayers (see system shape).`
      const second = await generateOnce(client, model, systemPrompt, repairPrompt)
      parsed = second.parsed
      raw = second.raw
      usageInput += second.result.usage.input_tokens
      usageOutput += second.result.usage.output_tokens
      chartLayers = normalizeChartLayersFromStructuredResponse(parsed, duration)
    }

    if (chartLayers.length === 0) {
      throw new Error('Model did not return usable chartLayers')
    }

    if (chartLayers.length >= 2 && chartLayers.length <= 4) {
      chartLayers = autoGridChartLayoutsForLayers(chartLayers)
    }

    const compiled = compileD3SceneFromLayers(chartLayers)
    const styles = typeof parsed?.styles === 'string' ? parsed.styles : ''

    return {
      chartLayers,
      sceneCode: compiled.sceneCode,
      d3Data: compiled.d3Data,
      styles,
      usage: { input_tokens: usageInput, output_tokens: usageOutput },
    }
  } catch (e) {
    log.error('failed', { error: e })
    throw e
  }
}
