// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCluster, groupSegments } from './ToolCluster'
import type { ToolCallRecord } from '@/lib/agents/types'

const call = (toolName: string, ok = true, over?: Partial<ToolCallRecord>): ToolCallRecord => ({
  id: `${toolName}-${Math.random()}`,
  toolName,
  input: {},
  output: { success: ok, ...(over?.output ?? {}) },
  ...over,
})

describe('groupSegments (#4 tool flood)', () => {
  it('folds consecutive tool calls into one chunk; text breaks the run', () => {
    const chunks = groupSegments([
      { text: 'intro' },
      { call: call('write_scene_code') },
      { call: call('verify_scene') },
      { text: 'mid' },
      { call: call('add_layer') },
    ])
    expect(chunks.map((c) => c.type)).toEqual(['text', 'tools', 'text', 'tools'])
    expect(chunks[1].type === 'tools' && chunks[1].calls.length).toBe(2)
  })

  it('drops permission-paused tools (rendered as a permission card elsewhere)', () => {
    const chunks = groupSegments([{ call: call('add_narration', true, { output: { success: true, permissionNeeded: { api: 'elevenLabs', estimatedCost: '~$0.02' } } as ToolCallRecord['output'] }) }])
    expect(chunks).toEqual([])
  })

  it('a thinking block breaks the tool run and stays inline in order', () => {
    const chunks = groupSegments([
      { call: call('write_scene_code') },
      { thinking: 'now I will verify' },
      { call: call('verify_scene') },
      { call: call('add_layer') },
    ])
    // tool | thinking | tools(verify+add) — the reasoning sits BETWEEN, not lumped.
    expect(chunks.map((c) => c.type)).toEqual(['tools', 'thinking', 'tools'])
    expect(chunks[1].type === 'thinking' && chunks[1].text).toBe('now I will verify')
    expect(chunks[2].type === 'tools' && chunks[2].calls.length).toBe(2)
  })
})

describe('ToolCluster (#4)', () => {
  it('a single call renders bare (no cluster wrapper / count)', () => {
    render(<ToolCluster calls={[call('write_scene_code')]} />)
    expect(screen.queryByText(/steps/)).toBeNull()
  })

  it('multiple calls collapse to "N steps", expand on click', () => {
    render(<ToolCluster calls={[call('write_scene_code'), call('verify_scene'), call('add_layer')]} />)
    expect(screen.getByText(/3 steps/)).toBeTruthy()
    fireEvent.click(screen.getByText(/3 steps/))
    // expanded → individual rows present (CompactToolCall labels)
    expect(screen.getAllByText(/scene|layer|verify/i).length).toBeGreaterThan(1)
  })

  it('surfaces a failure count on the collapsed header (never hides an error)', () => {
    render(<ToolCluster calls={[call('write_scene_code', true), call('verify_scene', false)]} />)
    expect(screen.getByText('1')).toBeTruthy() // failed badge
  })
})
