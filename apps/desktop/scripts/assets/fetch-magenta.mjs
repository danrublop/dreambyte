#!/usr/bin/env node
/**
 * Fetch the Magenta checkpoints used by the ML composer:
 *   - chord_pitches_improv (ImprovRNN) — chord-conditioned melody (melody:'ml')
 *   - groovae_2bar_humanize (MusicVAE/GrooveConverter) — humanized drums (groove:'ml')
 *
 * Small weight sets, NOT committed to git (see public/magenta/.gitignore); fetched
 * here at build/postinstall and cached so generation is fully offline + $0 after.
 *
 * Usage: node scripts/assets/fetch-magenta.mjs   (idempotent — skips files already present)
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAGENTA = join(ROOT, 'public', 'magenta')
const GCS = 'https://storage.googleapis.com/magentadata/js/checkpoints'

const CHECKPOINTS = [
  { id: 'chord_pitches_improv', base: `${GCS}/music_rnn/chord_pitches_improv` },
  { id: 'groovae_2bar_humanize', base: `${GCS}/music_vae/groovae_2bar_humanize` },
]

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function get(destDir, base, name) {
  const dest = join(destDir, name)
  if (await exists(dest)) {
    console.log(`  ${name} — present, skipping`)
    return
  }
  const res = await fetch(`${base}/${name}`)
  if (!res.ok) throw new Error(`download failed for ${name}: HTTP ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
  console.log(`  ${name} — downloaded`)
}

async function fetchCheckpoint({ id, base }) {
  const destDir = join(MAGENTA, id)
  await mkdir(destDir, { recursive: true })
  console.log(`fetching Magenta checkpoint: ${id} ...`)
  await get(destDir, base, 'config.json')
  await get(destDir, base, 'weights_manifest.json')
  const manifest = JSON.parse(await readFile(join(destDir, 'weights_manifest.json'), 'utf8'))
  const shards = manifest.flatMap((g) => g.paths)
  for (const s of shards) await get(destDir, base, s)
  console.log(`  done — ${destDir}`)
}

async function main() {
  for (const ckpt of CHECKPOINTS) await fetchCheckpoint(ckpt)
}

main().catch((e) => {
  console.error('fetch-magenta failed:', e.message)
  process.exit(1)
})
