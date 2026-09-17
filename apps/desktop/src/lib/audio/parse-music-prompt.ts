import { INSTRUMENT_NAMES, type ComposeParams } from './composer/arrange'

/**
 * Map a free-text music prompt to compose() params, so the local Composer model is
 * usable from the media-gen prompt box (the agent does this with an LLM; the direct
 * UI path needs a deterministic heuristic). Picks a template by genre keywords, plus
 * optional instrument + texture + key. Defaults to a calm lo-fi bed.
 */

// Genre/mood keywords → template id, in priority order (first match wins).
const TEMPLATE_KEYWORDS: { id: string; words: string[] }[] = [
  { id: 'cinematic', words: ['cinematic', 'epic', 'orchestral', 'trailer', 'film', 'movie', 'dramatic strings'] },
  { id: 'synthwave', words: ['synthwave', 'retro', '80s', 'eighties', 'neon', 'outrun', 'vaporwave', 'synthwave'] },
  { id: 'dnb', words: ['dnb', 'drum and bass', 'drum & bass', 'jungle', 'breakbeat', 'liquid'] },
  { id: 'tension', words: ['tension', 'suspense', 'dark', 'thriller', 'ominous', 'eerie', 'scary', 'horror'] },
  // Corporate before upbeat: "upbeat corporate" → corporate (upbeat is the modifier).
  {
    id: 'corporate',
    words: ['corporate', 'business', 'tech', 'technology', 'professional', 'presentation', 'explainer', 'motivational'],
  },
  { id: 'upbeat', words: ['upbeat', 'happy', 'energetic', 'cheerful', 'fun', 'playful', 'bouncy', 'pop'] },
  { id: 'folk', words: ['folk', 'acoustic', 'country', 'rustic', 'campfire', 'banjo'] },
  { id: 'ambient', words: ['ambient', 'drone', 'atmospheric', 'meditat', 'peaceful', 'space', 'dreamy', 'ethereal'] },
  {
    id: 'lofi',
    words: ['lofi', 'lo-fi', 'lo fi', 'chill', 'chillhop', 'study', 'relax', 'mellow', 'hip hop', 'hip-hop'],
  },
]

const SOLO_WORDS = ['solo', 'just ', 'only ', 'alone', 'single instrument']
const MINIMAL_WORDS = [
  'minimal',
  'sparse',
  'calm',
  'gentle',
  'soft',
  'background',
  'bed',
  'subtle',
  'quiet',
  'underscore',
  'ambient',
]

export function parseMusicPrompt(prompt: string): ComposeParams & { sceneDurationSec: number } {
  const p = ` ${prompt.toLowerCase()} `

  let templateId = 'lofi' // calm default
  for (const t of TEMPLATE_KEYWORDS) {
    if (t.words.some((w) => p.includes(w))) {
      templateId = t.id
      break
    }
  }

  // Instrument: first known instrument name mentioned (longest first so "electric-piano"
  // / "steel-guitar" / "music box" beat "piano" / "guitar").
  let instrument: string | undefined
  const names = [...INSTRUMENT_NAMES].sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (p.includes(name) || p.includes(name.replace(/-/g, ' '))) {
      instrument = name
      break
    }
  }

  let texture: ComposeParams['texture']
  if (SOLO_WORDS.some((w) => p.includes(w))) texture = 'solo'
  else if (MINIMAL_WORDS.some((w) => p.includes(w))) texture = 'minimal'

  let key: string | undefined
  if (p.includes('minor') || p.includes('sad') || p.includes('melancholic')) key = 'C minor'
  else if (p.includes('major') || p.includes('happy') || p.includes('bright')) key = 'C major'

  return { templateId, instrument, texture, key, sceneDurationSec: 16 }
}
