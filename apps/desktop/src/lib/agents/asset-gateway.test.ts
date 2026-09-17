// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'

import { resolveAsset, sandboxImageAsset, stockQueryFromPrompt, SANDBOX_ASSET_TAG } from './asset-gateway'

describe('stockQueryFromPrompt', () => {
  it('strips diffusion modifiers and keeps concrete keywords', () => {
    const q = stockQueryFromPrompt(
      'photorealistic Moroccan football stadium at golden hour, cinematic, 8k, highly detailed, bokeh',
    )
    expect(q).toContain('Moroccan')
    expect(q).toContain('football')
    expect(q).toContain('stadium')
    expect(q.toLowerCase()).not.toContain('photorealistic')
    expect(q.toLowerCase()).not.toContain('cinematic')
    expect(q.toLowerCase()).not.toContain('8k')
  })

  it('caps at 6 words and never returns empty', () => {
    expect(stockQueryFromPrompt('a b c d e f g h i').split(' ')).toHaveLength(6)
    expect(stockQueryFromPrompt('')).toBe('abstract background')
    expect(stockQueryFromPrompt('cinematic 8k hdr bokeh')).toBe('abstract background')
  })
})

describe('resolveAsset', () => {
  it('runs the sandbox producer (not real) when sandboxMode is set', async () => {
    let realCalled = false
    let sandboxCalled = false
    const out = await resolveAsset(
      { sandboxMode: true },
      {
        real: async () => {
          realCalled = true
          return 'real'
        },
        sandbox: async () => {
          sandboxCalled = true
          return 'sandbox'
        },
      },
    )
    expect(out).toBe('sandbox')
    expect(sandboxCalled).toBe(true)
    expect(realCalled).toBe(false)
  })

  it('runs the real producer (not sandbox) when sandboxMode is off', async () => {
    let realCalled = false
    let sandboxCalled = false
    const out = await resolveAsset(
      { sandboxMode: false },
      {
        real: async () => {
          realCalled = true
          return 'real'
        },
        sandbox: async () => {
          sandboxCalled = true
          return 'sandbox'
        },
      },
    )
    expect(out).toBe('real')
    expect(realCalled).toBe(true)
    expect(sandboxCalled).toBe(false)
  })
})

describe('sandboxImageAsset', () => {
  it('writes a real placeholder file and returns the generateImage shape at $0', async () => {
    const r = await sandboxImageAsset({ prompt: 'a red fox in snow', width: 800, height: 600 })
    expect(r.cost).toBe(0)
    expect(r.width).toBe(800)
    expect(r.height).toBe(600)
    expect(r.imageUrl).toMatch(/^\/generated\/sandbox\/[\w-]+\.svg$/)

    const abs = path.join(process.cwd(), 'public', r.imageUrl)
    const svg = await fs.readFile(abs, 'utf8')
    expect(svg).toContain('Sandbox placeholder')
    expect(svg).toContain('a red fox in snow') // prompt is rendered onto the card
    await fs.rm(abs, { force: true })
  })

  it('defaults dimensions and escapes XML-unsafe prompt characters', async () => {
    const r = await sandboxImageAsset({ prompt: '<script> & "quotes"' })
    expect(r.width).toBe(1024)
    expect(r.height).toBe(1024)
    const abs = path.join(process.cwd(), 'public', r.imageUrl)
    const svg = await fs.readFile(abs, 'utf8')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    await fs.rm(abs, { force: true })
  })

  it('exposes the placeholder tag constant', () => {
    expect(SANDBOX_ASSET_TAG).toBe('sandbox-placeholder')
  })
})
