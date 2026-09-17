// @vitest-environment node
/**
 * A4 (v6 T4) — deny resumes the run.
 *
 * Unit-tests the denial-resume message wording, plus source pins for the two
 * wiring sites that aren't reachable without a full AgentChat render:
 *   - ChatMessageList's onDeny calls denyAndContinue (deny no longer dead-ends).
 *   - AgentChat's denyAndContinue resumes WITHOUT a resumeToolCall (the denied
 *     call must never be replayed), while the approve path keeps it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildDenialResumeMessage } from './permission-resume'

describe('buildDenialResumeMessage', () => {
  it('names the tool + api and instructs the model to adapt (not retry)', () => {
    const msg = buildDenialResumeMessage('generate_video', 'veo3')
    expect(msg).toContain('DENIED')
    expect(msg).toContain('generate_video')
    expect(msg).toContain('veo3')
    expect(msg).toMatch(/do not retry/i)
    expect(msg).toMatch(/free alternative|explain/i)
  })
})

describe('A4 wiring source pins', () => {
  const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8')

  it('ChatMessageList onDeny resumes via denyAndContinue (deny is not a dead-end)', () => {
    const src = read('src/components/chat/ChatMessageList.tsx')
    // onDeny records the deny AND resumes.
    expect(src).toMatch(/onDeny=\{\(\) => \{[\s\S]{0,200}?handlePermission\(msg\.id, perm\.api, 'deny'\)/)
    expect(src).toMatch(/onDeny=\{\(\) => \{[\s\S]{0,200}?denyAndContinue\(msg, perm\.api\)/)
  })

  it('AgentChat denyAndContinue resumes with the denial message and NO resumeToolCall', () => {
    const src = read('src/components/AgentChat.tsx')
    // The deny resume uses the shared message builder…
    expect(src).toMatch(/messageContent: buildDenialResumeMessage\(perm\.toolName, api\)/)
    // …and the denyAndContinue body carries no resumeToolCall (only the approve
    // path — continueAfterPermission — does). Slice the denyAndContinue body and
    // assert resumeToolCall is absent from it.
    const denyStart = src.indexOf('const denyAndContinue')
    expect(denyStart).toBeGreaterThan(-1)
    const denyBody = src.slice(denyStart, src.indexOf('const answerClarification'))
    // No resumeToolCall PROPERTY (a comment mentioning it is fine).
    expect(denyBody).not.toMatch(/resumeToolCall:/)
    // The approve path DOES replay the tool call (regression guard).
    const approveStart = src.indexOf('const continueAfterPermission')
    const approveBody = src.slice(approveStart, denyStart)
    expect(approveBody).toMatch(/resumeToolCall: \{ toolName: perm\.toolName/)
  })
})
