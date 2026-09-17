/**
 * PCM decoder seam.
 *
 * Decoding an audio file to a Float32Array of mono PCM is platform-specific
 * (ffmpeg on Electron main, WebAudio in the renderer, fixtures in tests).
 * We define the interface here so the silence orchestrator stays pure;
 * the real ffmpeg-backed decoder lands in `src/electron/ipc/edit-ai.ts` in a
 * follow-up iteration.
 *
 * Resolution rules:
 *   - `setPcmDecoder(decoder)` swaps the active decoder. Pass `null` to
 *     reset to the default "no decoder configured" throwing stub.
 *   - Tests inject a synthetic decoder + assert the orchestrator builds
 *     the right action plan without touching ffmpeg or the filesystem.
 *
 * Concurrency: there's exactly one active decoder per process. That
 * matches how the renderer + main each have one PCM path; multi-decoder
 * fan-out is a future concern.
 */

export interface DecodedPcm {
  /** Mono float32 samples, range roughly [-1, 1]. */
  samples: Float32Array
  /** Hz; e.g. 48000 / 44100. */
  sampleRate: number
}

/**
 * `source` shape is left intentionally loose because callers route various
 * inputs through the same decoder:
 *   - file path on disk (Electron main with ffmpeg)
 *   - `dreambyte://uploads/<file>` URL (renderer with WebAudio decode)
 *   - asset id (the decoder resolves via the project asset store)
 *
 * Implementations document what they accept; the seam doesn't care.
 */
export interface PcmDecoder {
  decode(source: string): Promise<DecodedPcm>
}

const throwingStub: PcmDecoder = {
  async decode(source: string): Promise<DecodedPcm> {
    throw new Error(
      `PCM decoder not configured. Call setPcmDecoder(...) before invoking auto-cut-silence. (tried to decode: ${source})`,
    )
  },
}

let active: PcmDecoder = throwingStub

export function setPcmDecoder(decoder: PcmDecoder | null): void {
  active = decoder ?? throwingStub
}

export function getPcmDecoder(): PcmDecoder {
  return active
}
