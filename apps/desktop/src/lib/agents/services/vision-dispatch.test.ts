// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runVisionPrompt } from './vision-dispatch'

const IMG = { base64: 'AAAA', mimeType: 'image/png', systemPrompt: 'sys', userText: 'ask' }

describe('runVisionPrompt — engine routing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns null for an unknown engine id', async () => {
    expect(await runVisionPrompt('cloud:nope', IMG)).toBeNull()
  })

  it('returns null for a bare local: engine (no model tag)', async () => {
    expect(await runVisionPrompt('local:ollama', IMG)).toBeNull()
  })

  it('routes cloud:qwen / cloud:kimi through the OpenAI-compat vision transport', async () => {
    const mod = await import('./intake-engines/openai-compat-vision')
    const spy = vi.spyOn(mod, 'callOpenAICompatVision').mockResolvedValue('{"ok":true}')
    const out = await runVisionPrompt('cloud:qwen', IMG)
    expect(out).toBe('{"ok":true}')
    // system prompt is folded into the user prompt for compat providers
    expect(spy).toHaveBeenCalledOnce()
    const [, images, prompt] = spy.mock.calls[0]
    expect(images).toEqual([{ base64: 'AAAA', mimeType: 'image/png' }])
    expect(prompt).toContain('sys')
    expect(prompt).toContain('ask')
  })

  it('returns null (not throw) when the compat transport errors', async () => {
    const mod = await import('./intake-engines/openai-compat-vision')
    vi.spyOn(mod, 'callOpenAICompatVision').mockRejectedValue(new Error('boom'))
    expect(await runVisionPrompt('cloud:kimi', IMG)).toBeNull()
  })

  it('rejects unsupported media on the Anthropic path', async () => {
    expect(await runVisionPrompt('cloud:anthropic', { ...IMG, mimeType: 'image/tiff' })).toBeNull()
  })

  it('cloud:anthropic success path returns the text block (default vision engine)', async () => {
    const prov = await import('../providers')
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"dominant_color":"blue"}' }],
    })
    vi.spyOn(prov, 'getAnthropicClient').mockReturnValue({ messages: { create } } as never)
    const out = await runVisionPrompt('cloud:anthropic', IMG)
    expect(out).toBe('{"dominant_color":"blue"}')
    // image + text content was actually sent
    const body = create.mock.calls[0][0]
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { data: 'AAAA' } })
  })

  it('cloud:anthropic returns null when the response carries no text block', async () => {
    const prov = await import('../providers')
    vi.spyOn(prov, 'getAnthropicClient').mockReturnValue({
      messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
    } as never)
    expect(await runVisionPrompt('cloud:anthropic', IMG)).toBeNull()
  })

  it('routes cloud:gemini through getGoogleClient and returns text', async () => {
    const prov = await import('../providers')
    vi.spyOn(prov, 'getGoogleClient').mockReturnValue({
      models: { generateContent: async () => ({ text: '{"dominant_color":"red"}' }) },
    } as never)
    expect(await runVisionPrompt('cloud:gemini', IMG)).toBe('{"dominant_color":"red"}')
  })

  it('cloud:gemini returns null if the call outlives the timeout (no hung run)', async () => {
    const prov = await import('../providers')
    vi.spyOn(prov, 'getGoogleClient').mockReturnValue({
      models: { generateContent: () => new Promise(() => {}) /* never resolves */ },
    } as never)
    expect(await runVisionPrompt('cloud:gemini', { ...IMG, timeoutMs: 20 })).toBeNull()
  })

  it('routes local:<tag> to Ollama and returns message content; !res.ok → null', async () => {
    const okFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'x' } }) })
    global.fetch = okFetch as never
    expect(await runVisionPrompt('local:llava', IMG)).toBe('x')
    const body = JSON.parse(okFetch.mock.calls[0][1].body)
    expect(body.model).toBe('llava')
    expect(body.messages[1].images).toEqual(['AAAA'])

    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as never
    expect(await runVisionPrompt('local:llava', IMG)).toBeNull()
  })
})
