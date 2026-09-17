import type { SFXResult } from './types'

export interface SfxLocalSoundEntry {
  id: string
  name: string
  /** Path under public/sfx-library/, e.g. impacts/12345.mp3 */
  file: string
  license: string
  duration: number | null
  /** Where the file was fetched from (metadata only) */
  sourceProvider?: 'pixabay' | 'freesound'
  /**
   * In-repo bundled audio: `zzfx` from `npm run sfx-library:zzfx`;
   * `soloud` — [SoLoud](https://github.com/jarikomppa/soloud) (zlib/libpng);
   * `react-sounds` — files from / generated like [react-sounds](https://github.com/e3ntity/react-sounds) (MIT);
   * `cc0` — real recorded CC0 / public-domain foley (e.g. OpenGameArt "100 CC0 SFX");
   * `kenney-cc0` — Kenney CC0 audio packs (footsteps/impacts/UI/digital/RPG), fetched
   *   by `npm run sfx-library:packs` (binaries NOT committed; manifest rows are).
   */
  librarySource?: 'zzfx' | 'soloud' | 'react-sounds' | 'cc0' | 'kenney-cc0'
}

/** Auto-generated ZzFX pack entries (replaced when re-running `npm run sfx-library:zzfx`). */
export function isBundledZzfxSound(s: SfxLocalSoundEntry): boolean {
  return s.librarySource === 'zzfx' || s.file.includes('/zzfx-') || s.id.startsWith('zzfx-')
}

/** SoLoud-sourced bundled rows (preserved across ZzFX rebuild and `sfx-library:fetch`). */
export function isBundledSoloudSound(s: SfxLocalSoundEntry): boolean {
  return s.librarySource === 'soloud' || s.file.includes('/soloud-') || s.id.startsWith('soloud-')
}

/** react-sounds library clips vendored under `public/sfx-library/` (same preservation rules). */
export function isBundledReactSoundsSound(s: SfxLocalSoundEntry): boolean {
  return s.librarySource === 'react-sounds' || s.file.includes('/react-sounds-') || s.id.startsWith('react-sounds-')
}

/** Real-recorded CC0 / public-domain foley rows (e.g. OpenGameArt). Preserved across rebuilds. */
export function isBundledCc0Sound(s: SfxLocalSoundEntry): boolean {
  return s.librarySource === 'cc0' || s.file.includes('/cc0-') || s.id.startsWith('cc0-')
}

/** Kenney CC0 pack rows (fetched, not committed; preserved across other rebuilds). */
export function isBundledKenneySound(s: SfxLocalSoundEntry): boolean {
  return s.librarySource === 'kenney-cc0' || s.file.includes('/kenney-') || s.id.startsWith('kenney-')
}

/** All bundled library rows to prepend when re-fetching remote SFX. */
export function isBundledLibrarySound(s: SfxLocalSoundEntry): boolean {
  return (
    isBundledZzfxSound(s) ||
    isBundledSoloudSound(s) ||
    isBundledReactSoundsSound(s) ||
    isBundledCc0Sound(s) ||
    isBundledKenneySound(s)
  )
}

export interface SfxLocalCategory {
  id: string
  label: string
  sounds: SfxLocalSoundEntry[]
}

export interface SfxLocalManifest {
  version: number
  generatedAt?: string
  categories: SfxLocalCategory[]
}

export function manifestSoundToResult(entry: SfxLocalSoundEntry): SFXResult {
  const base = `/sfx-library/${String(entry.file ?? '')}`.replace(/\/+/g, '/')
  return {
    id: entry.id,
    name: entry.name,
    audioUrl: base,
    previewUrl: base,
    duration: entry.duration,
    license: entry.license,
    provider: 'local',
  }
}

export function getLocalSoundsForCategory(manifest: SfxLocalManifest | null, categoryId: string): SFXResult[] {
  if (!manifest?.categories?.length) return []
  const cat = manifest.categories.find((c) => c.id === categoryId)
  if (!cat?.sounds?.length) return []
  return cat.sounds.map(manifestSoundToResult)
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * Fuzzy-search the bundled SFX library by a free-text query, scoring each sound by
 * token overlap (+ substring/name/category bonuses) against its name, id, and
 * category label. Returns the best matches as SFXResult[] (provider 'local', $0/
 * offline). This is what makes the in-repo library agent-searchable, not just UI-browsable.
 */
export function searchLocalSfx(manifest: SfxLocalManifest | null, query: string, limit = 5): SFXResult[] {
  if (!manifest?.categories?.length || !query?.trim()) return []
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []
  const qJoined = qTokens.join(' ')

  const scored: Array<{ entry: SfxLocalSoundEntry; score: number }> = []
  for (const cat of manifest.categories) {
    const catTokens = tokenize(`${cat.id} ${cat.label}`)
    for (const sound of cat.sounds ?? []) {
      // Defensive: a hand-edited / corrupt on-disk manifest may carry a non-string
      // name/id. Coerce so search never throws out of the tool handler.
      const safeName = String(sound?.name ?? '')
      const safeId = String(sound?.id ?? '')
      const hayTokens = [...tokenize(`${safeName} ${safeId}`), ...catTokens]
      let score = 0
      for (const q of qTokens) {
        if (hayTokens.includes(q)) score += 3
        else if (hayTokens.some((h) => h.includes(q) || q.includes(h))) score += 1
      }
      const nameLower = safeName.toLowerCase()
      if (nameLower === qJoined) score += 6
      else if (nameLower.includes(qJoined)) score += 2
      if (score > 0) scored.push({ entry: sound, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, limit)).map((s) => manifestSoundToResult(s.entry))
}
