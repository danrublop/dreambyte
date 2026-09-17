/**
 * Writes deterministic ZzFX WAVs under public/sfx-library/{category}/zzfx-{presetId}.wav
 * and merges them into public/sfx-library/manifest.json (preserves non-ZzFX entries from fetch).
 *
 * Run: npx tsx scripts/assets/build-native-sfx-zzfx.ts
 */

import fs from 'fs/promises'
import path from 'path'

import './zzfx-node-polyfill'
// @ts-expect-error - no type declarations available for zzfx
import { ZZFX } from 'zzfx/ZzFX.js'
import { ZZFX_SFX_CATEGORIES } from '../../src/lib/audio/sfx-zzfx-presets'
import { encodeMonoWavPcm16 } from '../../src/lib/audio/encode-mono-wav-pcm16'
import type { SfxLocalCategory, SfxLocalManifest, SfxLocalSoundEntry } from '../../src/lib/audio/sfx-local-manifest'
import { isBundledZzfxSound } from '../../src/lib/audio/sfx-local-manifest'

const OUT_DIR = path.join(process.cwd(), 'public', 'sfx-library')
const LICENSE = 'MIT (ZzFX)'

function zzfxDeterministicParams(params: number[]): number[] {
  const z = [...params]
  z[1] = 0
  return z
}

async function readExistingManifest(): Promise<SfxLocalManifest | null> {
  try {
    const raw = await fs.readFile(path.join(OUT_DIR, 'manifest.json'), 'utf8')
    return JSON.parse(raw) as SfxLocalManifest
  } catch {
    return null
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })

  const zzfxCategories: SfxLocalCategory[] = []

  for (const cat of ZZFX_SFX_CATEGORIES) {
    const catDir = path.join(OUT_DIR, cat.id)
    await fs.mkdir(catDir, { recursive: true })
    const sounds: SfxLocalSoundEntry[] = []

    for (const preset of cat.presets) {
      const fileName = `zzfx-${preset.id}.wav`
      const relFile = `${cat.id}/${fileName}`
      const dest = path.join(OUT_DIR, relFile)

      const samples = ZZFX.buildSamples(...zzfxDeterministicParams(preset.zzfx))
      const wav = encodeMonoWavPcm16(samples, ZZFX.sampleRate)
      await fs.writeFile(dest, wav)

      const duration = samples.length / ZZFX.sampleRate
      sounds.push({
        id: `zzfx-${preset.id}`,
        name: preset.name,
        file: relFile.replace(/\\/g, '/'),
        license: LICENSE,
        duration,
        librarySource: 'zzfx',
      })
    }

    zzfxCategories.push({ id: cat.id, label: cat.label, sounds })
  }

  const existing = await readExistingManifest()
  const existingById = new Map((existing?.categories ?? []).map((c) => [c.id, c]))
  const orderIds = ZZFX_SFX_CATEGORIES.map((c) => c.id)
  const extraIds = [...existingById.keys()].filter((id) => !orderIds.includes(id))
  const allIds = [...orderIds, ...extraIds]

  const merged: SfxLocalCategory[] = allIds.map((id) => {
    const zz = zzfxCategories.find((c) => c.id === id)
    const prev = existingById.get(id)
    const kept = (prev?.sounds ?? []).filter((s) => !isBundledZzfxSound(s))
    const label = zz?.label ?? prev?.label ?? id
    const zzSounds = zz?.sounds ?? []
    return { id, label, sounds: [...zzSounds, ...kept] }
  })

  const manifest: SfxLocalManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    categories: merged,
  }

  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const n = zzfxCategories.reduce((a, c) => a + c.sounds.length, 0)
  console.log(`Wrote ${n} ZzFX WAVs + merged manifest → public/sfx-library/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
