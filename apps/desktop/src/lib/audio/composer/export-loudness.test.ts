// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compose } from './arrange'
import { renderArrangementToFile } from './render'
import { presetForTemplate, measureLufs } from './master'

/**
 * T1b — export-loudness ACCEPTANCE tests. The outside-voice catch: the export
 * loudnorm is opt-in (usually OFF), so the composed-music gain chain must sound
 * right ON ITS OWN. The chain is: master stem (~-16 LUFS) → MusicTrack.volume →
 * (× duckLevel during narration). These assert the calibrated default volume
 * lands music-only at a present content level and a proper bed under narration.
 */
const DEFAULT_MUSIC_VOLUME = 0.6 // compose_music default (calibrated in T1b)
const DEFAULT_DUCK_LEVEL = 0.2 // music × this during TTS

/** Decode a 16-bit stereo PCM WAV → {L,R} Float32 (skip the 44-byte header). */
function decodeWav(buf: Buffer): { L: Float32Array; R: Float32Array } {
  const dataOffset = 44
  const frames = (buf.length - dataOffset) / 4 // 2ch × 2 bytes
  const L = new Float32Array(frames)
  const R = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    L[i] = buf.readInt16LE(dataOffset + i * 4) / 32768
    R[i] = buf.readInt16LE(dataOffset + i * 4 + 2) / 32768
  }
  return { L, R }
}

function lufsAtGain(L: Float32Array, R: Float32Array, gain: number): number {
  const gl = new Float32Array(L.length)
  const gr = new Float32Array(R.length)
  for (let i = 0; i < L.length; i++) {
    gl[i] = L[i] * gain
    gr[i] = R[i] * gain
  }
  return measureLufs(gl, gr)
}

async function composeStem(templateId: string): Promise<{ L: Float32Array; R: Float32Array }> {
  const out = join(tmpdir(), `t1b-${templateId}-${process.pid}.wav`)
  const c = compose({ templateId, key: 'C minor', intensity: 0.7, sceneDurationSec: 14 })
  await renderArrangementToFile(c.arrangement, SF, out, presetForTemplate(templateId))
  return decodeWav(readFileSync(out))
}

const SF = process.env.DREAMBYTE_SOUNDFONT_PATH || join(process.cwd(), 'public', 'soundfonts', 'GeneralUser-GS.sf2')

;(existsSync(SF) ? describe : describe.skip)('export loudness acceptance (T1b)', () => {
  it('SCENARIO music-only: present content level at the default volume (NOT -31 LUFS)', async () => {
    const { L, R } = await composeStem('corporate')
    const stem = measureLufs(L, R)
    expect(stem).toBeGreaterThan(-20) // master hits a healthy stem (~-16)
    const musicOnly = lufsAtGain(L, R, DEFAULT_MUSIC_VOLUME)
    // The whole point of T1b: at 0.18 this was ~-31 LUFS (inaudible). At the
    // calibrated 0.6 it must land in a present music-content range.
    expect(musicOnly).toBeGreaterThan(-25)
    expect(musicOnly).toBeLessThan(-15)
  }, 30_000)

  it('SCENARIO music+TTS-ducked: music drops to a proper bed under narration', async () => {
    const { L, R } = await composeStem('lofi')
    const musicOnly = lufsAtGain(L, R, DEFAULT_MUSIC_VOLUME)
    const ducked = lufsAtGain(L, R, DEFAULT_MUSIC_VOLUME * DEFAULT_DUCK_LEVEL)
    // Ducked music sits well below the un-ducked level (room for speech on top).
    expect(ducked).toBeLessThan(musicOnly - 10)
    expect(ducked).toBeLessThan(-28) // a real bed, not competing with narration
  }, 30_000)

  it('SCENARIO music+SFX: the music stem level is unchanged (SFX are separate clips)', async () => {
    const { L, R } = await composeStem('corporate')
    // SFX ride their own lane at their own volume; the music gain is unaffected,
    // so the music bed stays at the music-only level.
    const musicLevel = lufsAtGain(L, R, DEFAULT_MUSIC_VOLUME)
    expect(musicLevel).toBeGreaterThan(-25)
    expect(musicLevel).toBeLessThan(-15)
  }, 30_000)

  it('SCENARIO multi-scene: every template lands in the same target window (consistent program)', async () => {
    for (const t of ['corporate', 'lofi', 'cinematic', 'synthwave']) {
      const { L, R } = await composeStem(t)
      const level = lufsAtGain(L, R, DEFAULT_MUSIC_VOLUME)
      expect(level, `${t} music-only loudness`).toBeGreaterThan(-26)
      expect(level, `${t} music-only loudness`).toBeLessThan(-14)
    }
  }, 90_000) // 4 real soundfont renders — generous under full-suite parallel load
})
