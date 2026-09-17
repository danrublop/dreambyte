#!/usr/bin/env node
/**
 * Expand the bundled SFX library with REAL recorded CC0 packs the agent can search
 * + use locally ($0). Today the library has 100 OGA CC0 foley + the synthesized
 * ZzFX pack; this adds Kenney's CC0 audio packs (footsteps, impacts, UI, digital,
 * RPG — hundreds of clean clips).
 *
 * Kenney releases everything CC0 (public domain). Each pack's download URL carries
 * a content-hash path that changes when Kenney updates the pack, so we SCRAPE the
 * current URL from the asset page at fetch time (robust) rather than hard-coding it.
 *
 * The .ogg binaries are NOT committed (see public/sfx-library/.gitignore — only
 * `cc0-*` and the manifest are tracked); they're fetched here and bundled into the
 * packaged app via assets:fetch (which runs BEFORE build-renderer copies public/→out/).
 *
 * Usage: node scripts/assets/fetch-sfx-packs.mjs   (idempotent — re-merges the kenney rows)
 */
import { mkdir, writeFile, readFile, readdir, copyFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(ROOT, 'public', 'sfx-library')
const KENNEY_DIR = join(LIB, 'kenney')
const MANIFEST = join(LIB, 'manifest.json')
const LICENSE = 'CC0 (Kenney)'

// One manifest category per Kenney pack. `slug` is the kenney.nl/assets/<slug> page.
const PACKS = [
  { slug: 'impact-sounds', id: 'footsteps-impacts', label: 'Footsteps & impacts (Kenney CC0)' },
  { slug: 'interface-sounds', id: 'interface', label: 'Interface & UI (Kenney CC0)' },
  { slug: 'digital-audio', id: 'digital', label: 'Digital & retro (Kenney CC0)' },
  { slug: 'rpg-audio', id: 'rpg', label: 'RPG & fantasy (Kenney CC0)' },
]

const humanize = (s) =>
  s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase())

function ffprobeDuration(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    })
    const d = parseFloat(out.trim())
    return Number.isFinite(d) ? Math.round(d * 1000) / 1000 : null
  } catch {
    return null
  }
}

/** Scrape the current .zip download URL from a Kenney asset page. */
async function resolveKenneyUrl(slug) {
  const res = await fetch(`https://kenney.nl/assets/${slug}`)
  if (!res.ok) throw new Error(`asset page ${slug}: HTTP ${res.status}`)
  const html = await res.text()
  const m = html.match(/media\/pages\/assets\/[^"' ]+\.zip/i)
  if (!m) throw new Error(`no download URL found on the ${slug} page`)
  return `https://kenney.nl/${m[0]}`
}

async function fetchPack(pack, work) {
  const url = await resolveKenneyUrl(pack.slug)
  console.log(`  ${pack.slug} → ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${pack.slug}: HTTP ${res.status}`)
  const zipPath = join(work, `${pack.slug}.zip`)
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))
  const ex = join(work, pack.slug)
  await mkdir(ex, { recursive: true })
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', ex])

  // Collect every audio file (recursively).
  const audio = []
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (/\.(ogg|wav|mp3)$/i.test(e.name)) audio.push(p)
    }
  }
  await walk(ex)

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
    const fileName = `kenney-${pack.id}-${stem}${ext}`
    await copyFile(src, join(KENNEY_DIR, fileName))
    sounds.push({
      id: `kenney-${pack.id}-${stem}`,
      name: humanize(stem),
      file: `kenney/${fileName}`,
      license: LICENSE,
      duration: ffprobeDuration(join(KENNEY_DIR, fileName)),
      librarySource: 'kenney-cc0',
    })
  }
  return { id: pack.id, label: pack.label, sounds }
}

async function main() {
  const work = join(tmpdir(), `kenney-sfx-${process.pid}`)
  await mkdir(work, { recursive: true })
  await mkdir(KENNEY_DIR, { recursive: true })
  console.log('fetching Kenney CC0 audio packs...')

  let manifest = { version: 1, categories: [] }
  if (existsSync(MANIFEST)) manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const packIds = new Set(PACKS.map((p) => p.id))
  // Keep every non-kenney category; replace the kenney ones we manage.
  manifest.categories = (manifest.categories ?? []).filter((c) => !packIds.has(c.id))

  let total = 0
  for (const pack of PACKS) {
    const cat = await fetchPack(pack, work)
    manifest.categories.push({ id: cat.id, label: cat.label, sounds: cat.sounds })
    total += cat.sounds.length
    console.log(`  ${pack.id}: ${cat.sounds.length} clips`)
  }

  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  // Best-effort temp cleanup — a read-only file in a pack zip can EACCES on unlink;
  // the clips + manifest are already written, so a cleanup failure must not fail the fetch.
  await rm(work, { recursive: true, force: true }).catch(() => {})
  console.log(`done — ${total} Kenney CC0 clips → public/sfx-library/kenney/ + ${PACKS.length} manifest categories`)
}

main().catch((e) => {
  console.error('fetch-sfx-packs failed:', e.message)
  process.exit(1)
})
