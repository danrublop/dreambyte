/**
 * Native SFX synth — high-level entry point (the SFX twin of src/lib/audio/composer).
 * Synthesize an archetype to a WAV on disk, fully local + $0.
 */
import { writeFile } from 'node:fs/promises'
import { synthesizeSfxWav, synthesizeLayeredSfxWav, type SfxSpec, type SfxLayer } from './synth'
import { generateSfxr } from './sfxr'
import { synthesizeNatureWav, type NatureSpec } from './nature'
import { synthesizeModalWav, type ModalSpec } from './modal'

export * from './synth'
export * from './sfxr'
export * from './nature'
export * from './modal'

/** Cache-salt version. Bump when the synth or archetype mapping changes. */
export const SFX_SYNTH_VERSION = 'sfx-synth-5-modal'

export interface SfxFileResult {
  durationSec: number
  resolvedId: string
}

/** Synthesize an archetype and write the WAV to disk. Returns null if the archetype is unknown. */
export async function synthesizeSfxToFile(spec: SfxSpec, outPath: string): Promise<SfxFileResult | null> {
  const r = synthesizeSfxWav(spec)
  if (!r) return null
  await writeFile(outPath, r.wav)
  return { durationSec: r.durationSec, resolvedId: r.resolvedId }
}

/** Synthesize a layered compound SFX and write the WAV. Returns null if any layer is unknown. */
export async function synthesizeLayeredSfxToFile(layers: SfxLayer[], outPath: string): Promise<SfxFileResult | null> {
  const r = synthesizeLayeredSfxWav(layers)
  if (!r) return null
  await writeFile(outPath, r.wav)
  return { durationSec: r.durationSec, resolvedId: r.resolvedId }
}

/**
 * Generate a fresh sfxr (jsfxr) sound for a category and write the WAV. Returns null
 * for an unknown category. Generative + deterministic per (category, variation).
 */
export async function generateSfxrToFile(
  category: string,
  variation: number,
  outPath: string,
): Promise<SfxFileResult | null> {
  const r = generateSfxr(category, variation)
  if (!r) return null
  await writeFile(outPath, r.wav)
  return { durationSec: r.durationSec, resolvedId: r.category }
}

/** Synthesize a NATURAL ambience (wind/rain/fire/ocean/…) and write the WAV. Null if unknown. */
export async function synthesizeNatureToFile(
  category: string,
  spec: NatureSpec,
  outPath: string,
): Promise<SfxFileResult | null> {
  const r = synthesizeNatureWav(category, spec)
  if (!r) return null
  await writeFile(outPath, r.wav)
  return { durationSec: r.durationSec, resolvedId: r.category }
}

/** Synthesize a MODAL impact (struck metal/wood/glass/ceramic/membrane) and write
 *  the WAV. Returns null for an unknown material. */
export async function synthesizeModalToFile(
  material: string,
  spec: ModalSpec,
  outPath: string,
): Promise<SfxFileResult | null> {
  const r = synthesizeModalWav(material, spec)
  if (!r) return null
  await writeFile(outPath, r.wav)
  return { durationSec: r.durationSec, resolvedId: r.material }
}
