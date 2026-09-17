// @vitest-environment node
// $HOME is overridden to a tmp dir so writes never touch the real ~/.dreambyte
// (same isolation as src/lib/memory/okf-view.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { promises as fsp } from 'fs'
import { writeSandboxReview, renderSandboxTranscript } from './sandbox-capture'
import type { ToolCallRecord } from './types'

function tc(name: string, sandboxRequest?: unknown): ToolCallRecord {
  return {
    id: name,
    toolName: name,
    input: {},
    output: { success: true, data: sandboxRequest ? { sandboxRequest } : {} },
  }
}

describe('renderSandboxTranscript', () => {
  it('includes the FULL prompt untruncated + params (the point is to review the real prompt)', () => {
    const long = 'a cinematic wide establishing shot of a neon city, '.repeat(20)
    const md = renderSandboxTranscript('run1', [
      { tool: 'generate_image', provider: 'imageGen', model: 'flux-schnell', prompt: long, params: { aspectRatio: '16:9' } },
    ])
    expect(md).toContain(long) // not sliced to 60/80 chars like the placeholder label
    expect(md).toContain('generate_image')
    expect(md).toContain('flux-schnell')
    expect(md).toContain('16:9')
  })
})

describe('writeSandboxReview', () => {
  let tmpHome: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dreambyte-sandbox-capture-test-'))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('captures ONLY tool calls that carry a sandboxRequest, and writes json + transcript', async () => {
    const calls = [
      tc('write_scene_code'), // no sandboxRequest → ignored
      tc('generate_image', { tool: 'generate_image', provider: 'imageGen', prompt: 'a fox in snow', model: 'flux' }),
      tc('generate_veo3_video', { tool: 'generate_veo3_video', provider: 'auto', prompt: 'a river at dawn' }),
    ]
    const { count, dir } = await writeSandboxReview('runX', calls)
    expect(count).toBe(2)
    expect(dir.startsWith(tmpHome)).toBe(true) // $HOME override honoured

    const json = JSON.parse(await fsp.readFile(path.join(dir, 'generations.json'), 'utf8'))
    expect(json.map((r: { tool: string }) => r.tool)).toEqual(['generate_image', 'generate_veo3_video'])

    const md = await fsp.readFile(path.join(dir, 'transcript.md'), 'utf8')
    expect(md).toContain('a fox in snow')
    expect(md).toContain('a river at dawn')
  })

  it('writes nothing and returns 0 when no generation request was captured', async () => {
    const { count, dir } = await writeSandboxReview('runY', [tc('write_scene_code'), tc('add_narration')])
    expect(count).toBe(0)
    await expect(fsp.access(path.join(dir, 'transcript.md'))).rejects.toThrow()
  })
})
