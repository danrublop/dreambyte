/**
 * Download commercial-filtered SFX into public/sfx-library/ and write manifest.json.
 * Run: npx tsx scripts/assets/fetch-sfx-library.ts
 *
 * Requires PIXABAY_API_KEY and/or FREESOUND_API_KEY in .env (prefers Pixabay when set).
 * Respects provider ToS — moderate limits, one category at a time with small delay.
 */

import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.join(process.cwd(), '.env.local') })
dotenv.config({ path: path.join(process.cwd(), '.env') })

import { getSFXProvider } from '../../src/lib/audio/router'
import {
  type SfxLocalCategory,
  type SfxLocalManifest,
  type SfxLocalSoundEntry,
  isBundledLibrarySound,
} from '../../src/lib/audio/sfx-local-manifest'

async function readExistingManifest(): Promise<SfxLocalManifest | null> {
  try {
    const raw = await fs.readFile(path.join(OUT_DIR, 'manifest.json'), 'utf8')
    return JSON.parse(raw) as SfxLocalManifest
  } catch {
    return null
  }
}
import type { SFXProvider } from '../../src/lib/types'

const OUT_DIR = path.join(process.cwd(), 'public', 'sfx-library')
const PER_CATEGORY = Math.min(24, Number(process.env.SFX_LIBRARY_PER_CATEGORY) || 16)
const DELAY_MS = 400

/** Remote search queries per folder (IDs align with `ZZFX_SFX_CATEGORIES` in lib). */
const FETCH_CATEGORIES: { id: string; label: string; query: string }[] = [
  { id: 'ui', label: 'UI & clicks', query: 'ui click button' },
  { id: 'impacts', label: 'Impacts & hits', query: 'impact hit' },
  { id: 'explosions', label: 'Explosions', query: 'explosion boom' },
  { id: 'pickups', label: 'Pickups & rewards', query: 'coin pickup game' },
  { id: 'alarms', label: 'Alarms & alerts', query: 'notification alert chime' },
  { id: 'sci-fi', label: 'Sci‑fi', query: 'sci fi laser beep' },
  { id: 'cartoon', label: 'Cartoon', query: 'cartoon boing pop' },
  { id: 'percussion', label: 'Drums & rhythm', query: 'drum percussion' },
  { id: 'transitions', label: 'Transitions', query: 'whoosh transition' },
  { id: 'sfxr', label: 'Retro game', query: '8bit game jump blip retro' },
  { id: 'ambient', label: 'Ambient & drones', query: 'ambient drone soft pad' },
  { id: 'misc', label: 'Classic ZzFX demos', query: 'game sound effect' },
]

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 20 * 1024 * 1024) throw new Error('File too large')
  await fs.writeFile(dest, buf)
}

async function main() {
  const usePixabay = !!process.env.PIXABAY_API_KEY
  const useFreesound = !!process.env.FREESOUND_API_KEY
  if (!usePixabay && !useFreesound) {
    console.error('Set PIXABAY_API_KEY or FREESOUND_API_KEY in .env')
    process.exit(1)
  }

  const providerId: SFXProvider = usePixabay ? 'pixabay' : 'freesound'
  console.log(`Using provider: ${providerId}, ${PER_CATEGORY} sounds per category`)

  const impl = await getSFXProvider(providerId)
  const categories: SfxLocalCategory[] = []
  const previous = await readExistingManifest()

  await fs.mkdir(OUT_DIR, { recursive: true })

  for (const cat of FETCH_CATEGORIES) {
    console.log(`Category: ${cat.label}…`)
    const bundledKeep =
      previous?.categories?.find((c) => c.id === cat.id)?.sounds?.filter(isBundledLibrarySound) ?? []
    const sounds: SfxLocalSoundEntry[] = [...bundledKeep]
    const catDir = path.join(OUT_DIR, cat.id)
    await fs.mkdir(catDir, { recursive: true })

    try {
      const results = await impl.search(cat.query, PER_CATEGORY, {
        page: 1,
        commercialOnly: providerId === 'freesound',
      })

      for (const r of results) {
        const url = r.previewUrl || r.audioUrl
        if (!url?.startsWith('http')) continue

        const ext = (() => {
          try {
            const p = new URL(url).pathname
            const e = path.extname(p)
            return e && e.length < 6 ? e : '.mp3'
          } catch {
            return '.mp3'
          }
        })()

        const baseName = safeFileName(r.id)
        const relFile = `${cat.id}/${baseName}${ext}`
        const dest = path.join(OUT_DIR, relFile)

        try {
          await downloadFile(url, dest)
        } catch (e) {
          console.warn(`  skip ${r.name}:`, e)
          continue
        }

        sounds.push({
          id: r.id,
          name: r.name,
          file: relFile.replace(/\\/g, '/'),
          license: r.license || '',
          duration: r.duration,
          sourceProvider: providerId === 'pixabay' ? 'pixabay' : 'freesound',
        })
      }
    } catch (e) {
      console.error(`  category failed:`, e)
    }

    categories.push({ id: cat.id, label: cat.label, sounds })
    await new Promise((r) => setTimeout(r, DELAY_MS))
  }

  const manifest: SfxLocalManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    categories,
  }

  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const total = categories.reduce((n, c) => n + c.sounds.length, 0)
  console.log(`Done. ${total} sounds → public/sfx-library/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
