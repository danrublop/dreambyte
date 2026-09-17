#!/usr/bin/env node
/**
 * Fetch the GeneralUser GS 2.x SoundFont used by the native music composer.
 *
 * GeneralUser GS (permissive custom license — free use/modify/redistribute) is the
 * maintained, better-voiced GM bank that MuseScore_General is itself derived from;
 * M3 swapped to it for richer instrument timbre. The ~32MB binary is NOT committed
 * to git (see public/soundfonts/.gitignore); it is fetched here at build/postinstall
 * time and integrity-checked, then bundled into the packaged app.
 *
 * Usage: node scripts/assets/fetch-soundfont.mjs   (idempotent — skips if checksum matches)
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEST = join(ROOT, 'public', 'soundfonts', 'GeneralUser-GS.sf2')
const URL = 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2'
const SHA256 = '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function ok(path) {
  try {
    await stat(path)
    return sha256(await readFile(path)) === SHA256
  } catch {
    return false
  }
}

async function main() {
  if (await ok(DEST)) {
    console.log('soundfont present + verified — skipping download')
    return
  }
  console.log(`fetching GeneralUser-GS.sf2 (~32MB) from ${URL} ...`)
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = sha256(buf)
  if (got !== SHA256) throw new Error(`checksum mismatch: expected ${SHA256}, got ${got}`)
  await mkdir(dirname(DEST), { recursive: true })
  await writeFile(DEST, buf)
  console.log(`wrote ${DEST} (${buf.length} bytes, sha256 ok)`)
}

main().catch((e) => {
  console.error('fetch-soundfont failed:', e.message)
  process.exit(1)
})
