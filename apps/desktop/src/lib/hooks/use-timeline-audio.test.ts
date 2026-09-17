/**
 * Source-parity test for the T4 audio-ownership flip.
 *
 * The driver hook lives inside a React effect closure that can't be imported,
 * so — like PreviewPlayer.parity.test.ts and cap-checkpoint.test.ts — we assert
 * the contract at the source level: the engine now OWNS scene audio
 * (`ownsSceneAudio: true`) so tts/music/sfx ride the mixer faders + drive the
 * per-track VU meters, while avatar lipsync speech is excluded so the avatar
 * overlay keeps playing it (no double-play, matching the controller's
 * `data-avatar-audio` exemption).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync(path.resolve(process.cwd(), 'src/lib/hooks/use-timeline-audio.ts'), 'utf8')

describe('use-timeline-audio engine ownership (T4)', () => {
  it('grants the engine ownership of scene audio', () => {
    expect(src).toContain('ownsSceneAudio: true')
    expect(src).not.toContain('ownsSceneAudio: false')
  })

  it('excludes avatar lipsync audio from engine ownership', () => {
    expect(src).toContain('AVATAR_AUDIO_RE')
    expect(src).toContain('ownershipExceptions: exceptions')
    // the exception set is built from the url-map keys (rebuilt with the map)
    expect(src).toMatch(/exceptions = new Set\(\[\.\.\.map\.keys\(\)\]\.filter/)
  })
})
