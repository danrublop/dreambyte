// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isInsideAsar, materializeForFfmpeg } from './materialize-asar-audio'

describe('isInsideAsar', () => {
  it('flags paths inside an .asar archive', () => {
    expect(isInsideAsar('/Applications/X.app/Contents/Resources/app.asar/out/sfx-library/foley/cc0-door.ogg')).toBe(
      true,
    )
    expect(isInsideAsar(path.join('a', 'b.asar', 'c', 'd.wav'))).toBe(true)
  })
  it('does NOT flag real filesystem paths', () => {
    expect(isInsideAsar('/Users/me/dreambyte/out/sfx-library/zzfx-coin.wav')).toBe(false)
    expect(isInsideAsar('/var/folders/tmp/audio-123.ogg')).toBe(false)
  })
  it('does NOT flag .asar.unpacked (a real on-disk dir)', () => {
    expect(isInsideAsar('/X/Resources/app.asar.unpacked/out/sfx-library/x.ogg')).toBe(false)
  })
})

describe('materializeForFfmpeg', () => {
  let root: string
  let tmpDir: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mat-asar-'))
    tmpDir = path.join(root, 'tmp')
    await fs.mkdir(tmpDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('passes real-filesystem paths through untouched (no copy in dev)', async () => {
    const real = path.join(root, 'sfx-library', 'zzfx-coin.wav')
    await fs.mkdir(path.dirname(real), { recursive: true })
    await fs.writeFile(real, Buffer.from('REAL'))
    const out = await materializeForFfmpeg(real, tmpDir)
    expect(out).toBe(real)
  })

  it('copies an asar-resident file out to tmpDir and preserves bytes + extension', async () => {
    // A real on-disk dir literally named `app.asar` exercises both the string
    // detection and the byte-copy (readFile reads the real file just as the
    // asar-aware fs would read through a true archive).
    const asarFile = path.join(root, 'app.asar', 'out', 'sfx-library', 'foley', 'cc0-door.ogg')
    await fs.mkdir(path.dirname(asarFile), { recursive: true })
    const payload = Buffer.from('OGGDATA ')
    await fs.writeFile(asarFile, payload)

    const out = await materializeForFfmpeg(asarFile, tmpDir)
    expect(out).not.toBe(asarFile)
    expect(path.dirname(out)).toBe(tmpDir)
    expect(out.endsWith('.ogg')).toBe(true)
    expect(isInsideAsar(out)).toBe(false)
    expect(await fs.readFile(out)).toEqual(payload)
  })
})
