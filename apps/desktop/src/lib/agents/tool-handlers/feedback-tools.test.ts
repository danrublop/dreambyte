/**
 * send_feedback — tool-gap flywheel.
 *
 * Pins the contract: validation, the auto-collected diagnostics trail, per-run
 * dedupe, the 8-call cap, and routing to the telemetry sink with PARAPHRASED
 * content (no verbatim user message text).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock the telemetry sink so we can assert what gets emitted without a network.
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
import { track } from '@/lib/telemetry'

import {
  createFeedbackToolHandler,
  resetFeedbackState,
  recordFeedbackTool,
  __getFeedbackStateForTesting,
  getFeedbackLogPath,
} from './feedback-tools'
import type { WorldStateMutable } from '../world-state'

const world = { projectId: 'proj-abcdef123456', modelId: 'claude-x' } as unknown as WorldStateMutable
const handle = createFeedbackToolHandler()

beforeEach(() => {
  resetFeedbackState()
  vi.mocked(track).mockClear()
})

describe('validation', () => {
  it('rejects an invalid category', async () => {
    const r = await handle('send_feedback', { category: 'nonsense', summary: 'x' }, world)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/invalid category/i)
    expect(track).not.toHaveBeenCalled()
  })

  it('rejects an empty summary', async () => {
    const r = await handle('send_feedback', { category: 'failure', summary: '   ' }, world)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/summary/i)
  })

  it('rejects an invalid severity', async () => {
    const r = await handle('send_feedback', { category: 'failure', summary: 'x', severity: 'critical' }, world)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/severity/i)
  })
})

describe('happy path + diagnostics', () => {
  it('emits agent_feedback with only enums, counts and hashes (no free text)', async () => {
    recordFeedbackTool('read_timeline', { success: true })
    recordFeedbackTool('place_clip', { success: false, error: 'no such track' })

    const r = await handle(
      'send_feedback',
      { category: 'missing_capability', summary: 'no tool to reverse a clip', severity: 'medium' },
      world,
    )
    expect(r.success).toBe(true)
    expect((r.data as { sent: boolean }).sent).toBe(true)
    expect(track).toHaveBeenCalledTimes(1)
    const [event, props] = vi.mocked(track).mock.calls[0]
    expect(event).toBe('agent_feedback')
    expect(props).toEqual({
      category: 'missing_capability',
      severity: 'medium',
      summary_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      summary_chars: 'no tool to reverse a clip'.length,
      details_chars: 0,
      recent_tool_count: 2,
      has_last_error: true,
      last_error_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    const serialized = JSON.stringify(props)
    for (const text of ['reverse a clip', 'no such track', 'read_timeline', 'proj-abc', 'claude-x']) {
      expect(serialized).not.toContain(text)
    }
  })
})

describe('runner notice + telemetry failure', () => {
  it('returns a ui_action change so the runner emits a state_change notice', async () => {
    const r = await handle('send_feedback', { category: 'suggestion', summary: 'notice me' }, world)
    expect(r.changes).toEqual([{ type: 'ui_action', description: expect.stringMatching(/logged this for the team/i) }])
  })

  it('a throwing telemetry sink cannot escape; the report still counts as sent', async () => {
    vi.mocked(track).mockImplementationOnce(() => {
      throw new Error('sink down')
    })
    const args = { category: 'failure' as const, summary: 'telemetry throws' }
    const r = await handle('send_feedback', args, world)
    expect(r.success).toBe(true)
    expect((r.data as { sent: boolean }).sent).toBe(true)
    const again = await handle('send_feedback', args, world)
    expect((again.data as { reason: string }).reason).toBe('duplicate')
  })
})

describe('dedupe + cap', () => {
  it('does not re-send a duplicate (same category|summary) this run', async () => {
    const args = { category: 'failure' as const, summary: 'thing broke' }
    const first = await handle('send_feedback', args, world)
    const second = await handle('send_feedback', args, world)
    expect((first.data as { sent: boolean }).sent).toBe(true)
    expect((second.data as { sent: boolean; reason: string }).sent).toBe(false)
    expect((second.data as { reason: string }).reason).toBe('duplicate')
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('caps at 8 sends per run, then asks the model to summarize to the user', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await handle('send_feedback', { category: 'suggestion', summary: `idea ${i}` }, world)
      expect((r.data as { sent: boolean }).sent).toBe(true)
    }
    const ninth = await handle('send_feedback', { category: 'suggestion', summary: 'idea 9' }, world)
    expect((ninth.data as { sent: boolean; reason: string }).sent).toBe(false)
    expect((ninth.data as { reason: string }).reason).toBe('session_limit')
    expect(track).toHaveBeenCalledTimes(8)
  })
})

describe('diagnostics trail', () => {
  it('records non-feedback tools and the last error, excludes send_feedback itself, and resets', () => {
    recordFeedbackTool('a', { success: true })
    recordFeedbackTool('b', { success: false, error: 'boom' })
    recordFeedbackTool('send_feedback', { success: true }) // excluded from its own trail
    let s = __getFeedbackStateForTesting()
    expect(s.recentTools).toEqual(['a', 'b'])
    expect(s.lastError).toBe('boom')

    resetFeedbackState()
    s = __getFeedbackStateForTesting()
    expect(s.recentTools).toEqual([])
    expect(s.lastError).toBeNull()
    expect(s.sentKeys.size).toBe(0)
  })

  it('keeps only the most recent 15 tool names', () => {
    for (let i = 0; i < 20; i++) recordFeedbackTool(`t${i}`, { success: true })
    const s = __getFeedbackStateForTesting()
    expect(s.recentTools.length).toBe(15)
    expect(s.recentTools[0]).toBe('t5')
    expect(s.recentTools[14]).toBe('t19')
  })

  it('clips a long last_error and keeps it out of telemetry', async () => {
    // A raw error carrying a long path/prompt fragment.
    const long = 'ENOENT: ' + '/Users/secret/very/long/path/'.repeat(40) + 'file.png'
    expect(long.length).toBeGreaterThan(200)
    recordFeedbackTool('generate_image', { success: false, error: long })

    // Captured form is already clipped (bounds memory + the telemetry payload).
    const s = __getFeedbackStateForTesting()
    expect(s.lastError!.length).toBeLessThanOrEqual(201) // 200 + the … marker
    expect(s.lastError!.endsWith('…')).toBe(true)
    expect(s.lastError!.startsWith('ENOENT: ')).toBe(true) // head preserved

    // The event carries only a hash of it — never the path text.
    await handle('send_feedback', { category: 'failure', summary: 'image gen failed' }, world)
    const [, props] = vi.mocked(track).mock.calls[0]
    expect(JSON.stringify(props)).not.toContain('/Users/secret')
    expect((props as { has_last_error: boolean }).has_last_error).toBe(true)
  })

  it('leaves a short last_error untouched (no spurious marker)', () => {
    recordFeedbackTool('place_clip', { success: false, error: 'no such track' })
    const s = __getFeedbackStateForTesting()
    expect(s.lastError).toBe('no such track')
  })
})

describe('durable local sink', () => {
  // The regression this guards: track() short-circuits when no telemetry endpoint is
  // configured, and none is configured by default — so routing feedback ONLY through
  // it meant every report was silently discarded while the tool still told the model
  // it had filed one. The local JSONL is what makes the success message true.
  const HOME = mkdtempSync(join(tmpdir(), 'dreambyte-feedback-'))
  const realHome = os.homedir

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(HOME)
  })
  afterEach(() => {
    vi.mocked(os.homedir).mockRestore?.()
  })
  afterAll(() => {
    os.homedir = realHome
    rmSync(HOME, { recursive: true, force: true })
  })

  it('writes the report to disk even when telemetry has no endpoint', async () => {
    const r = await handle(
      'send_feedback',
      { category: 'missing_capability', summary: 'no tool to invert a matte', severity: 'high' },
      world,
    )
    expect(r.success).toBe(true)

    const lines = readFileSync(getFeedbackLogPath(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0])
    expect(rec.summary).toBe('no tool to invert a matte')
    expect(rec.category).toBe('missing_capability')
    expect(rec.severity).toBe('high')
    expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // project id is truncated to a prefix, never the full id
    expect(rec.project_id).toBe('proj-abc')
  })

  it('carries the auto-collected diagnostics trail into the record', async () => {
    recordFeedbackTool('write_scene_code', { success: true })
    recordFeedbackTool('add_music', { success: false, error: 'provider disabled' })
    await handle('send_feedback', { category: 'failure', summary: 'music provider unavailable' }, world)

    const lines = readFileSync(getFeedbackLogPath(), 'utf8').trim().split('\n')
    const rec = JSON.parse(lines[lines.length - 1])
    expect(rec.recent_tools).toContain('write_scene_code')
    expect(rec.last_error).toBe('provider disabled')
  })

  it('a disk failure never fails the run', async () => {
    vi.mocked(os.homedir).mockReturnValue('/nonexistent/\0/bad')
    const r = await handle('send_feedback', { category: 'suggestion', summary: 'unwritable path' }, world)
    expect(r.success).toBe(true)
  })
})
