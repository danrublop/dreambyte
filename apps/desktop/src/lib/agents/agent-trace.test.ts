import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderSystemPrompts, renderTranscript, createTraceAppender, type AgentTraceTurn } from './agent-trace'

const turn = (iteration: number, systemPrompt: string, messages: unknown[]): AgentTraceTurn =>
  ({ iteration, systemPrompt, messages }) as AgentTraceTurn

describe('renderSystemPrompts', () => {
  it('collapses consecutive identical prompts into one section, splits on a rebuild', () => {
    const md = renderSystemPrompts('r1', [
      turn(1, 'PROMPT_A', []),
      turn(2, 'PROMPT_A', []),
      turn(3, 'PROMPT_B', []), // refresh
      turn(4, 'PROMPT_B', []),
    ])
    // Two distinct prompts → two sections, each appearing once.
    expect(md.match(/PROMPT_A/g)?.length).toBe(1)
    expect(md.match(/PROMPT_B/g)?.length).toBe(1)
    expect(md).toContain('## Turns 1–2')
    expect(md).toContain('## Turns 3–4')
  })
})

describe('renderTranscript', () => {
  it('renders per-turn deltas (only newly-added messages per turn)', () => {
    const md = renderTranscript('r1', [
      turn(1, 'S', [{ role: 'user', content: 'hi' }]),
      turn(2, 'S', [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'reply',
          tool_calls: [{ function: { name: 'write_scene_code', arguments: '{}' } }],
        },
      ]),
    ])
    expect(md).toContain('## Turn 1')
    expect(md).toContain('hi')
    expect(md).toContain('## Turn 2')
    // Turn 2's delta shows the assistant reply + its tool call, not a re-print of 'hi'.
    expect(md).toContain('reply')
    expect(md).toContain('write_scene_code')
    // 'hi' appears once (turn 1), not duplicated in turn 2's delta.
    expect(md.match(/\bhi\b/g)?.length).toBe(1)
  })

  it('marks an in-flight compaction when the message array shrinks', () => {
    const md = renderTranscript('r1', [
      turn(1, 'S', [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]),
      turn(2, 'S', [{ role: 'user', content: 'SUMMARY' }]), // compacted 3 → 1
    ])
    expect(md).toContain('in-flight compaction')
    expect(md).toContain('3 → 1')
    expect(md).toContain('SUMMARY')
  })
})

describe('createTraceAppender (crash-safety)', () => {
  const realHome = process.env.HOME
  afterEach(() => {
    // Bare assignment writes the literal string "undefined" when HOME was unset,
    // which makes getAgentRunsDir() a RELATIVE path for every later test in the
    // fork. Matches the guard the six sibling $HOME tests already use.
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
  })

  it('writes each turn to disk AS IT HAPPENS — a run killed mid-flight keeps every completed turn', () => {
    // os.homedir() honours $HOME on POSIX, which is how getAgentRunsDir resolves.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-home-'))
    process.env.HOME = home
    const dir = path.join(home, '.dreambyte', 'agent-runs', 'r-crash')

    const appender = createTraceAppender('r-crash')
    appender.push(turn(1, 'PROMPT_A', [{ role: 'user', content: 'build it' }]))
    appender.push(
      turn(2, 'PROMPT_A', [
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'write_scene_code', arguments: '{}' } }] },
      ]),
    )
    // ── process dies here. No writeAgentTrace, no finally. ──

    const transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8')
    expect(transcript).toContain('## Turn 1')
    expect(transcript).toContain('build it')
    expect(transcript).toContain('## Turn 2')
    expect(transcript).toContain('write_scene_code')
    // Turn 2 appended only its DELTA — 'build it' isn't reprinted.
    expect(transcript.match(/build it/g)?.length).toBe(1)

    const sys = fs.readFileSync(path.join(dir, 'system-prompt.md'), 'utf8')
    // Unchanged prompt across turns 1-2 → written once.
    expect(sys.match(/PROMPT_A/g)?.length).toBe(1)
    expect(sys).toContain('## From turn 1')

    // A prompt rebuild opens a new section rather than back-patching the old one.
    appender.push(turn(3, 'PROMPT_B', []))
    const sys2 = fs.readFileSync(path.join(dir, 'system-prompt.md'), 'utf8')
    expect(sys2).toContain('## From turn 3')
    expect(sys2.match(/PROMPT_B/g)?.length).toBe(1)
  })

  it('never throws when the trace dir is unwritable', () => {
    // HOME → a regular FILE, so mkdir fails ENOTDIR identically on every OS.
    // This was '/proc/nonexistent-eacces': /proc is a real kernel filesystem on
    // Linux and absent on macOS, so the test exercised a different code path on
    // CI than on any dev machine here.
    const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-home-')), 'not-a-dir')
    fs.writeFileSync(notADir, '')
    process.env.HOME = notADir
    const appender = createTraceAppender('r-bad')
    expect(() => appender.push(turn(1, 'S', [{ role: 'user', content: 'x' }]))).not.toThrow()
  })
})
