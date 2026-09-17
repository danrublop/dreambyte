// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB layer: use_asset_in_scene must look the asset up for real.
let mockRows: any[] = []
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockRows),
        }),
      }),
    }),
  },
}))

import { createAssetMediaToolHandler } from './asset-media-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'

const handler = createAssetMediaToolHandler({
  checkApiPermission: () => null,
  regenerateHTML: async () => ({ htmlWritten: true }),
})

const world = { scenes: [], projectId: 'project-test', currentRunId: 'run' } as unknown as WorldStateMutable

beforeEach(() => {
  mockRows = []
})

describe('use_asset_in_scene resolves the asset honestly', () => {
  it('missing asset → error (not a phantom success)', async () => {
    mockRows = []
    const res = await handler('use_asset_in_scene', { assetId: 'ghost', usage: 'overlay' }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
  })

  it('found asset → success WITH the real publicUrl + metadata', async () => {
    mockRows = [
      {
        type: 'image',
        publicUrl: 'https://cdn/x.png',
        thumbnailUrl: 'https://cdn/x_t.png',
        width: 800,
        height: 600,
        name: 'logo',
      },
    ]
    const res = await handler('use_asset_in_scene', { assetId: 'a1', usage: 'overlay' }, world)
    expect(res.success).toBe(true)
    expect((res.data as any).publicUrl).toBe('https://cdn/x.png')
    expect((res.data as any).type).toBe('image')
  })

  it('asset with no usable URL yet → error', async () => {
    mockRows = [{ type: 'image', publicUrl: null, thumbnailUrl: null, width: null, height: null, name: 'pending' }]
    const res = await handler('use_asset_in_scene', { assetId: 'a1', usage: 'overlay' }, world)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no usable url/i)
  })

  it('missing projectId → error', async () => {
    const noProj = { scenes: [], currentRunId: 'r' } as unknown as WorldStateMutable
    const res = await handler('use_asset_in_scene', { assetId: 'a1', usage: 'overlay' }, noProj)
    expect(res.success).toBe(false)
  })
})

describe('add_watermark validates the asset (v5 T9/E2)', () => {
  it('missing asset → error, and world.watermark is NOT set', async () => {
    mockRows = []
    const w = { scenes: [], projectId: 'project-test', currentRunId: 'run' } as unknown as WorldStateMutable
    const res = await handler('add_watermark', { assetId: 'ghost' }, w)
    // The old handler never looked the asset up — a stale assetId produced an
    // invisible watermark while the agent reported success.
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect((w as { watermark?: unknown }).watermark).toBeUndefined()
  })

  it('asset with no usable URL yet → error, no world.watermark', async () => {
    mockRows = [{ publicUrl: null, name: 'pending' }]
    const w = { scenes: [], projectId: 'project-test', currentRunId: 'run' } as unknown as WorldStateMutable
    const res = await handler('add_watermark', { assetId: 'a1' }, w)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no usable url/i)
    expect((w as { watermark?: unknown }).watermark).toBeUndefined()
  })

  it('valid asset → success with clamped config on world.watermark', async () => {
    mockRows = [{ publicUrl: 'https://cdn/logo.png', name: 'logo' }]
    const w = { scenes: [], projectId: 'project-test', currentRunId: 'run' } as unknown as WorldStateMutable
    const res = await handler('add_watermark', { assetId: 'a1', position: 'top-left', opacity: 9, sizePercent: 99 }, w)
    expect(res.success).toBe(true)
    const wm = (w as { watermark?: { assetId: string; position: string; opacity: number; sizePercent: number } })
      .watermark
    expect(wm).toEqual({ assetId: 'a1', position: 'top-left', opacity: 1, sizePercent: 50 })
    expect((res.data as { watermark: unknown }).watermark).toEqual(wm)
  })

  it('missing projectId → error', async () => {
    const noProj = { scenes: [], currentRunId: 'r' } as unknown as WorldStateMutable
    const res = await handler('add_watermark', { assetId: 'a1' }, noProj)
    expect(res.success).toBe(false)
  })
})
