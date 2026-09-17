/**
 * Native music composer — high-level entry point.
 *
 * Ties the arrange layer (template → note events) to the render engine (events →
 * WAV file) and resolves the bundled soundfont path across dev + packaged Electron.
 * The agent tool (compose_music) calls composeMusicToFile; everything below it is
 * pure + provider-free.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { compose, type ComposeParams, type ComposeResult } from './arrange'
import { renderArrangementToFile } from './render'

export * from './arrange'
export { TEMPLATES, TEMPLATE_IDS } from './templates'

/**
 * Cache-salt version. Bump when the engine OR the bundled soundfont changes so a
 * stale rendered WAV is never served for an identical spec.
 */
export const COMPOSER_VERSION = 'composer-6-master+arrange-dynamics+sf-generaluser-gs-2'

/**
 * Resolve the bundled soundfont across dev (cwd) and packaged Electron. Next copies
 * public/ → out/, and electron-builder ships out/** inside the asar, so the packaged
 * asset lives at <resources>/app.asar/out/soundfonts/. We check public/ (dev source),
 * out/ (post-build / dev-server), and the asar/unpacked locations (packaged).
 */
export function resolveSoundfontPath(): string | null {
  const SF = join('soundfonts', 'GeneralUser-GS.sf2')
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env.DREAMBYTE_SOUNDFONT_PATH,
    join(process.cwd(), 'public', SF),
    join(process.cwd(), 'out', SF),
    resourcesPath ? join(resourcesPath, 'app.asar', 'out', SF) : undefined,
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'out', SF) : undefined,
    resourcesPath ? join(resourcesPath, 'app', 'out', SF) : undefined,
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p)) ?? null
}

export class SoundfontMissingError extends Error {
  constructor() {
    super('Music soundfont not found. Install it with: node scripts/assets/fetch-soundfont.mjs')
    this.name = 'SoundfontMissingError'
  }
}

export interface ComposeMusicFileResult {
  audioUrl: string
  filePath: string
  durationSec: number
  rms: number
  corrections: string[]
  meta: ComposeResult['meta']
  /** Which lead the rendered track actually used (ml falls back to template on failure). */
  melodySource: 'template' | 'ml'
  /** Which drum groove the track used (ml falls back to template on failure). */
  grooveSource: 'template' | 'ml'
}

/**
 * Compose + render a track to a WAV on disk. The caller supplies the absolute output
 * path and the public URL (so the handler owns the audio dir + cache-hash filename).
 * When `params.melody === 'ml'`, the template lead is replaced by a Magenta-generated
 * chord-conditioned melody (graceful fallback to the template lead on failure).
 */
export async function composeMusicToFile(
  params: ComposeParams,
  out: { absPath: string; publicUrl: string },
): Promise<ComposeMusicFileResult> {
  const sf = resolveSoundfontPath()
  if (!sf) throw new SoundfontMissingError()
  const composed = compose(params)
  let arrangement = composed.arrangement
  const corrections = [...composed.corrections]
  let melodySource: 'template' | 'ml' = 'template'

  if (params.melody === 'ml') {
    const { generateMlMelody } = await import('./ml-melody')
    const leadEvents = await generateMlMelody({
      chordsInC: composed.plan.chordsInC,
      offset: composed.plan.offset,
      secPerBeat: composed.plan.secPerBeat,
      startSec: composed.plan.coreStartSec,
      leadChannel: composed.plan.leadChannel,
      intensity: params.intensity ?? 0.6,
    })
    if (leadEvents.length > 0) {
      // Replace the template lead line with the generated one.
      const withoutLead = arrangement.events.filter((e) => e.channel !== composed.plan.leadChannel)
      arrangement = { ...arrangement, events: [...withoutLead, ...leadEvents] }
      melodySource = 'ml'
    } else {
      corrections.push('ML melody unavailable — used the template lead')
    }
  }

  let grooveSource: 'template' | 'ml' = 'template'
  if (params.groove === 'ml' && composed.plan.drumPattern) {
    const { generateMlDrums } = await import('./ml-drums')
    const drumEvents = await generateMlDrums({
      ...composed.plan.drumPattern,
      coreBars: composed.plan.coreBars,
      secPerBeat: composed.plan.secPerBeat,
      coreStartSec: composed.plan.coreStartSec,
      qpm: composed.plan.tempo,
    })
    if (drumEvents.length > 0) {
      // Replace the deterministic drum-channel events with the humanized groove.
      const withoutDrums = arrangement.events.filter((e) => e.channel !== composed.plan.drumChannel)
      arrangement = { ...arrangement, events: [...withoutDrums, ...drumEvents] }
      grooveSource = 'ml'
    } else {
      corrections.push('ML groove unavailable — used the template drums')
    }
  }

  const { presetForTemplate } = await import('./master')
  const masterPreset = presetForTemplate(composed.meta.templateId)
  const r = await renderArrangementToFile(arrangement, sf, out.absPath, masterPreset)
  return {
    audioUrl: out.publicUrl,
    filePath: out.absPath,
    durationSec: r.durationSec,
    rms: r.rms,
    corrections,
    meta: composed.meta,
    melodySource,
    grooveSource,
  }
}

export type { ComposeParams } from './arrange'
