/**
 * Heuristics for whether a Freesound `license` string allows typical commercial product use.
 * Freesound returns a license URL or label per sound — always verify on freesound.org for edge cases.
 *
 * Pixabay SFX uses the Pixabay License (free for commercial use, no attribution required) — not evaluated here.
 */
export function isCommercialFriendlyFreesoundLicense(license: string | undefined | null): boolean {
  if (!license || typeof license !== 'string') return false
  const l = license.toLowerCase()

  if (l.includes('noncommercial') || l.includes('non-commercial') || l.includes('by-nc') || l.includes('/by-nc')) {
    return false
  }
  if (l.includes('sampling+') || l.includes('sampling plus')) return false

  if (
    l.includes('publicdomain/zero') ||
    l.includes('creativecommons.org/publicdomain/zero') ||
    l.includes('creative commons 0') ||
    l === 'cc0'
  ) {
    return true
  }

  if (l.includes('creativecommons.org/licenses/by/') && !l.includes('nc')) return true

  return false
}

/** Short label for UI badges */
export function licenseBadgeLabel(license: string | undefined, provider: string | undefined): string {
  if (provider === 'zzfx') return 'ZzFX'
  if (provider === 'local' && license?.toLowerCase().includes('react-sounds')) return 'ReactS'
  if (provider === 'local' && license?.toLowerCase().includes('soloud')) return 'SoLoud'
  if (provider === 'local' && license?.toLowerCase().includes('zzfx')) return 'ZzFX'
  if (provider === 'local') return 'Local'
  if (provider === 'pixabay') return 'Pixabay'
  if (!license) return '—'
  const l = license.toLowerCase()
  if (l.includes('zero') || l.includes('cc0')) return 'CC0'
  if (l.includes('licenses/by/')) return 'CC BY'
  return 'See license'
}

export const PIXABAY_SFX_LICENSE_NOTE =
  'Pixabay License — free for commercial use; see https://pixabay.com/service/license/'

export const FREESOUND_LICENSE_NOTE =
  'Freesound: we only list CC0 and CC BY sounds here for commercial-friendly use; CC BY requires attribution to the author. Verify on the sound’s Freesound page before shipping.'
