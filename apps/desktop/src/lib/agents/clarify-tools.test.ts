// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'
import { createClarifyToolHandler } from './tool-handlers/clarify-tools'
import { executeTool } from './tool-executor'
import type { WorldStateMutable } from './world-state'

const handler = createClarifyToolHandler()
const world = {} as WorldStateMutable
const makeWorld = (): WorldStateMutable =>
  ({
    scenes: [],
    globalStyle: { presetId: null },
    projectName: 'p',
    projectId: 'proj',
    currentRunId: 'r',
    outputMode: 'mp4',
  }) as unknown as WorldStateMutable

/**
 * ask_user clarify tool. The handler decides between PAUSE (no answer yet →
 * clarificationNeeded, which the runner turns into a card) and ANSWER (resume
 * with _answer → return it as the tool result so the loop continues).
 */
describe('ask_user handler (#okf-clarify-gate)', () => {
  it('first call (no answer) → clarificationNeeded with question + options', async () => {
    const r = await handler(
      'ask_user',
      { question: 'Is this a 16:9 explainer or a 9:16 short?', options: ['16:9 explainer', '9:16 short'] },
      world,
    )
    expect(r.success).toBe(true)
    expect(r.clarificationNeeded?.question).toMatch(/16:9 explainer/)
    expect(r.clarificationNeeded?.options).toEqual(['16:9 explainer', '9:16 short'])
    expect((r.data as { clientAction?: string }).clientAction).toBe('ask_user')
    expect(r.clarificationNeeded?.id).toMatch(/^clarify-/)
  })

  it('resume call (_answer present) → returns the answer, NO clarificationNeeded', async () => {
    const r = await handler('ask_user', { question: 'format?', _answer: '9:16 short' }, world)
    expect(r.success).toBe(true)
    expect((r.data as { answer?: string }).answer).toBe('9:16 short')
    expect(r.clarificationNeeded).toBeUndefined()
  })

  it('blank/whitespace _answer is NOT treated as answered → re-pause', async () => {
    const r = await handler('ask_user', { question: 'format?', _answer: '   ' }, world)
    expect(r.clarificationNeeded).toBeTruthy() // re-pause, don't return "" as a confirmation
  })

  it('missing question is an honest failure', async () => {
    const r = await handler('ask_user', { question: '   ' }, world)
    expect(r.success).toBe(false)
    expect(String(r.error)).toMatch(/non-empty/)
  })

  it('drops empty/blank option strings; omits the field when none survive', async () => {
    const r = await handler('ask_user', { question: 'q', options: ['', '  ', 'real one'] }, world)
    expect(r.clarificationNeeded?.options).toEqual(['real one'])
    const r2 = await handler('ask_user', { question: 'q', options: [] }, world)
    expect(r2.clarificationNeeded?.options).toBeUndefined()
  })

  it('a stable id is derived from the question (no Date/random)', async () => {
    const a = await handler('ask_user', { question: 'Which format do you want?' }, world)
    const b = await handler('ask_user', { question: 'Which format do you want?' }, world)
    expect(a.clarificationNeeded?.id).toBe(b.clarificationNeeded?.id)
  })
})

describe('ask_user through executeTool (real seam)', () => {
  it('registered + pauses on first call', async () => {
    const r = await executeTool('ask_user', { question: 'Confirm the format?', options: ['16:9', '9:16'] }, makeWorld())
    expect(r.success).toBe(true)
    expect(r.clarificationNeeded?.question).toMatch(/Confirm the format/)
  })

  it('registered + answers on resume (_answer threaded in toolInput)', async () => {
    const r = await executeTool('ask_user', { question: 'Confirm the format?', _answer: '16:9' }, makeWorld())
    expect((r.data as { answer?: string }).answer).toBe('16:9')
    expect(r.clarificationNeeded).toBeUndefined()
  })
})
