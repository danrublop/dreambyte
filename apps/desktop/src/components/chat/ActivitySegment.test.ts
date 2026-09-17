import { describe, it, expect } from 'vitest'
import { groupActivities, summarizeActivity } from './ActivitySegment'
import type { RenderChunk } from './ToolCluster'
import type { ToolCallRecord } from '@/lib/agents/types'

const call = (toolName: string, ok = true): ToolCallRecord => ({
  id: `${toolName}-${Math.random()}`,
  toolName,
  input: {},
  output: { success: ok },
})

const tools = (...names: string[]): RenderChunk => ({ type: 'tools', calls: names.map((n) => call(n)) })
const thinking = (text: string): RenderChunk => ({ type: 'thinking', text })
const text = (t: string): RenderChunk => ({ type: 'text', text: t })

describe('groupActivities', () => {
  it('folds intra-run narration into the activity; only the FINAL reply stays standalone', () => {
    const out = groupActivities([
      thinking('planning'),
      tools('web_search', 'web_search'),
      text('here is the plan'), // narration BETWEEN tool batches → folds in
      tools('generate_image'),
      text('final reply'), // AFTER the last tool → standalone prose
    ])
    expect(out.map((a) => a.type)).toEqual(['activity', 'text'])
    // the one activity holds thinking + tools + intra-run text + tools
    expect(out[0].type === 'activity' && out[0].chunks.length).toBe(4)
    expect(out[1].type === 'text' && out[1].text).toBe('final reply')
  })

  it('a run with no trailing reply is one activity (no standalone text)', () => {
    const out = groupActivities([thinking('t'), tools('web_search'), text('mid'), tools('write_scene_code')])
    expect(out.map((a) => a.type)).toEqual(['activity'])
  })
})

describe('summarizeActivity', () => {
  it('combines reasoning presence + tool-call count + notable tool counts', () => {
    const chunks: RenderChunk[] = [
      thinking('reasoning'),
      {
        type: 'tools',
        calls: [...Array(12)].map(() => call('web_search')).concat([...Array(15)].map(() => call('write_scene_code'))),
      },
    ]
    expect(summarizeActivity(chunks)).toBe('Reasoned · 27 tool calls · 12 web searches')
  })

  it('singularizes counts and includes generated images (mcp-prefixed too)', () => {
    const chunks: RenderChunk[] = [
      { type: 'tools', calls: [call('web_search'), call('mcp__dreambyte__generate_image')] },
    ]
    expect(summarizeActivity(chunks)).toBe('2 tool calls · 1 web search · 1 image')
  })

  it('falls back to "Working" for an empty activity', () => {
    expect(summarizeActivity([])).toBe('Working')
  })
})
