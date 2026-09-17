// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { searchLocalSfx, type SfxLocalManifest } from './sfx-local-manifest'

const manifest: SfxLocalManifest = {
  version: 1,
  categories: [
    {
      id: 'impacts',
      label: 'Impacts & hits',
      sounds: [
        { id: 'zzfx-impact-punch', name: 'Punch', file: 'impacts/punch.wav', license: 'MIT', duration: 0.4 },
        { id: 'zzfx-impact-glass', name: 'Glass break', file: 'impacts/glass.wav', license: 'MIT', duration: 0.5 },
      ],
    },
    {
      id: 'pickups',
      label: 'Pickups & rewards',
      sounds: [{ id: 'zzfx-coin', name: 'Coin', file: 'pickups/coin.wav', license: 'MIT', duration: 0.2 }],
    },
    {
      id: 'ui',
      label: 'UI & clicks',
      sounds: [{ id: 'zzfx-ui-click', name: 'Click', file: 'ui/click.wav', license: 'MIT', duration: 0.07 }],
    },
  ],
}

describe('searchLocalSfx', () => {
  it('finds an exact name match first', () => {
    const r = searchLocalSfx(manifest, 'coin', 3)
    expect(r[0].name).toBe('Coin')
    expect(r[0].provider).toBe('local')
    expect(r[0].audioUrl).toBe('/sfx-library/pickups/coin.wav')
  })

  it('matches multi-word queries against name + category', () => {
    expect(searchLocalSfx(manifest, 'glass break', 1)[0].name).toBe('Glass break')
    expect(searchLocalSfx(manifest, 'click', 1)[0].name).toBe('Click')
  })

  it('matches via category label (impact → impacts category)', () => {
    const names = searchLocalSfx(manifest, 'impact', 5).map((r) => r.name)
    expect(names).toContain('Punch')
  })

  it('returns [] for no match, empty query, or null manifest', () => {
    expect(searchLocalSfx(manifest, 'didgeridoo', 3)).toEqual([])
    expect(searchLocalSfx(manifest, '', 3)).toEqual([])
    expect(searchLocalSfx(null, 'coin', 3)).toEqual([])
  })

  it('respects the limit', () => {
    expect(searchLocalSfx(manifest, 'a', 1).length).toBeLessThanOrEqual(1)
  })
})
