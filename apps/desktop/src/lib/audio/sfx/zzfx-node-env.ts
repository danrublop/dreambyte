/**
 * Native SFX synth — Node environment shim.
 *
 * The `zzfx` module instantiates `AudioContext` at load time, which Node lacks.
 * Import THIS module (for its side effect) BEFORE importing `zzfx/ZzFX.js` so the
 * stub is installed first. We only use ZZFX.buildSamples (pure DSP → number[]),
 * never playback, so the stub never needs to do anything real.
 *
 * (Mirrors scripts/assets/zzfx-node-polyfill.ts, owned under src/lib/ so lib doesn't depend
 * on scripts/.)
 */
const g = globalThis as Record<string, unknown>
if (g.AudioContext == null) {
  g.AudioContext = class AudioContextStub {
    sampleRate = 44100
    destination = { connect: () => {} }
    createBuffer(_ch: number, len: number, rate: number) {
      return { getChannelData: () => new Float32Array(len), duration: len / rate }
    }
    createBufferSource() {
      return {
        buffer: null as unknown,
        playbackRate: { value: 1 },
        loop: false,
        connect: () => ({ connect: () => ({ connect: () => {} }) }),
        start: () => {},
      }
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => ({ connect: () => {} }) }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node stub for zzfx side-effect import
  } as any
}
