'use client'

import type { ZzfxSfxPreset } from '@/lib/audio/sfx-zzfx-presets'

// Lazy-load zzfx to avoid AudioContext instantiation during SSR/module evaluation
let _zzfxModule: typeof import('zzfx') | null = null
let _zzfxWavModule: typeof import('zzfx/wav.js') | null = null

async function getZzfx() {
  if (!_zzfxModule) _zzfxModule = await import('zzfx')
  return _zzfxModule
}

async function getZzfxWav() {
  if (!_zzfxWavModule) _zzfxWavModule = await import('zzfx/wav.js')
  return _zzfxWavModule
}

/** Copy params and freeze randomness so WAV export matches duration and is reproducible. */
export function zzfxDeterministicParams(params: number[]): number[] {
  const z = [...params]
  z[1] = 0
  return z
}

/**
 * Live preview (allows ZzFX randomness). Returns the AudioBufferSourceNode
 * zzfx() starts, so callers can stop it — without this, hover-preview ZzFX
 * bursts couldn't be cut and overlapped. Null on failure.
 */
export async function playZzfxPreview(preset: ZzfxSfxPreset): Promise<AudioBufferSourceNode | null> {
  try {
    const { zzfx } = await getZzfx()
    return (zzfx(...preset.zzfx) as AudioBufferSourceNode) ?? null
  } catch {
    return null
  }
}

export async function buildZzfxWavObjectUrl(preset: ZzfxSfxPreset): Promise<{
  url: string
  durationSec: number
  revoke: () => void
}> {
  const { ZZFX } = await getZzfx()
  const { buildWavURL } = await getZzfxWav()
  const samples = ZZFX.buildSamples(...zzfxDeterministicParams(preset.zzfx))
  const url = buildWavURL([samples], ZZFX.sampleRate) as string
  const durationSec = samples.length / ZZFX.sampleRate
  return {
    url,
    durationSec,
    revoke: () => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
    },
  }
}

export async function uploadAudioBlob(blob: Blob, filename: string): Promise<string> {
  const { uploadBlob } = await import('@/lib/upload')
  return uploadBlob(blob, filename)
}
