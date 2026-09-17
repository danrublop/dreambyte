// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  searchLocalSfx,
  isBundledKenneySound,
  isBundledCc0Sound,
  isBundledZzfxSound,
  isBundledSoloudSound,
  isBundledReactSoundsSound,
  type SfxLocalManifest,
} from './sfx-local-manifest'

const LIB = join(process.cwd(), 'public', 'sfx-library')
const manifest = JSON.parse(readFileSync(join(LIB, 'manifest.json'), 'utf8')) as SfxLocalManifest
const allSounds = manifest.categories.flatMap((c) => c.sounds)
const resolves = (file: string) => existsSync(join(LIB, file))

describe('SFX library manifest integrity', () => {
  it('has no duplicate sound ids across categories', () => {
    const ids = allSounds.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every COMMITTED entry (zzfx / cc0 / soloud / react-sounds) resolves to a file on disk', () => {
    // These binaries are tracked in git (gitignore exceptions), so they must ALWAYS
    // be present — a broken manifest row here breaks a fresh clone with no fetch.
    const committed = allSounds.filter(
      (s) => isBundledZzfxSound(s) || isBundledCc0Sound(s) || isBundledSoloudSound(s) || isBundledReactSoundsSound(s),
    )
    expect(committed.length).toBeGreaterThan(100)
    const missing = committed.filter((s) => !resolves(s.file)).map((s) => s.file)
    expect(missing).toEqual([])
  })

  it('clean-clone: AFTER the packs fetch, every manifest entry (incl. Kenney) resolves', () => {
    // Kenney binaries are fetched (gitignored), so gate on them being present —
    // mirrors the soundfont/magenta-gated tests. When the fetch has run, the WHOLE
    // manifest must be consistent (no row pointing at a missing file).
    const kenney = allSounds.filter(isBundledKenneySound)
    if (kenney.length === 0 || !resolves(kenney[0].file)) return // fetch not run — skip
    const missing = allSounds.filter((s) => !resolves(s.file)).map((s) => s.file)
    expect(missing).toEqual([])
  })
})

describe('SFX library search over the expanded packs', () => {
  it('finds Kenney footsteps — a capability the synth/old library lacked', () => {
    if (!allSounds.some(isBundledKenneySound)) return // fetch not run
    const r = searchLocalSfx(manifest, 'footstep concrete', 3)
    expect(r.length).toBeGreaterThan(0)
    expect(r.some((x) => x.id.startsWith('kenney-'))).toBe(true)
  })

  it('still finds the original committed clips (no regression)', () => {
    expect(searchLocalSfx(manifest, 'laser', 1)[0]?.id).toMatch(/zzfx-laser/)
    expect(searchLocalSfx(manifest, 'door open', 1).length).toBeGreaterThan(0)
  })
})
