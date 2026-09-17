/**
 * ZzFX module instantiates `AudioContext` at load time. Install this stub before importing `zzfx`.
 */
export function installZzfxNodePolyfill(): void {
  const g = globalThis as Record<string, unknown>
  if (g.AudioContext != null) return
  g.AudioContext = class AudioContextStub {
    sampleRate = 44100
    destination = { connect: () => {} }
    createBuffer(_ch: number, len: number, rate: number) {
      return {
        getChannelData: () => new Float32Array(len),
        duration: len / rate,
      }
    }
    createBufferSource() {
      return {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        loop: false,
        connect: () => ({
          connect: () => ({ connect: () => {} }),
        }),
        start: () => {},
      }
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect: () => ({ connect: () => {} }),
      }
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node stub for zzfx side-effect import
  } as any
}

installZzfxNodePolyfill()
