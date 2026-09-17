#!/usr/bin/env node
/**
 * Import real-recorded CC0 foley into the bundled SFX library so the agent can use
 * natural sounds (doors, metal, wood, water, paper, springs) locally + $0.
 *
 * Source: OpenGameArt "100 CC0 SFX" (https://opengameart.org/content/100-cc0-sfx) —
 * 100 sounds recorded on an Android device, dedicated to the public domain (CC0).
 *
 * Copies the .ogg files into public/sfx-library/foley/ as cc0-<name>.ogg (committed,
 * like the ZzFX pack), computes durations via ffprobe, and merges a "foley" category
 * into manifest.json (preserving every existing category/sound). Idempotent.
 *
 * Usage: node scripts/assets/import-cc0-foley.mjs
 */
import { mkdir, writeFile, readFile, readdir, copyFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(ROOT, 'public', 'sfx-library')
const FOLEY_DIR = join(LIB, 'foley')
const MANIFEST = join(LIB, 'manifest.json')
const URL = 'https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip'
const LICENSE = 'CC0 (OpenGameArt — 100 CC0 SFX)'

const humanize = (name) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\d+\b/g, (n) => n) // keep numeric variant suffixes
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())

function ffprobeDuration(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' },
    )
    const d = parseFloat(out.trim())
    return Number.isFinite(d) ? Math.round(d * 1000) / 1000 : null
  } catch {
    return null
  }
}

async function main() {
  const work = join(tmpdir(), `cc0-foley-${Date.now()}`)
  await mkdir(work, { recursive: true })
  console.log('downloading OpenGameArt 100 CC0 SFX...')
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const zipPath = join(work, 'pack.zip')
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', join(work, 'x')])

  // Find every audio file (recursively).
  const audio = []
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (/\.(ogg|wav|mp3|flac)$/i.test(e.name)) audio.push(p)
    }
  }
  await walk(join(work, 'x'))
  if (audio.length === 0) throw new Error('no audio files found in the pack')

  await mkdir(FOLEY_DIR, { recursive: true })
  const sounds = []
  const seen = new Set()
  for (const src of audio.sort()) {
    const stem = basename(src, extname(src))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!stem || seen.has(stem)) continue
    seen.add(stem)
    const ext = extname(src).toLowerCase()
    const fileName = `cc0-${stem}${ext}`
    await copyFile(src, join(FOLEY_DIR, fileName))
    sounds.push({
      id: `cc0-${stem}`,
      name: humanize(stem),
      file: `foley/${fileName}`,
      license: LICENSE,
      duration: ffprobeDuration(join(FOLEY_DIR, fileName)),
      librarySource: 'cc0',
    })
  }

  // Merge into manifest.json: replace the foley category, keep everything else.
  let manifest = { version: 1, categories: [] }
  if (existsSync(MANIFEST)) manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  manifest.categories = (manifest.categories ?? []).filter((c) => c.id !== 'foley')
  manifest.categories.push({ id: 'foley', label: 'Foley & materials (real recordings)', sounds })
  manifest.generatedAt = manifest.generatedAt // leave existing; not stamping a date (keeps diffs clean)
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')

  await rm(work, { recursive: true, force: true })
  console.log(`imported ${sounds.length} CC0 foley sounds → public/sfx-library/foley/ + manifest "foley" category`)
}

main().catch((e) => {
  console.error('import-cc0-foley failed:', e.message)
  process.exit(1)
})
