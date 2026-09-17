declare module 'zzfx' {
  export function zzfx(...parameters: number[]): unknown
  export const ZZFX: {
    volume: number
    sampleRate: number
    audioContext: AudioContext
    play(...parameters: number[]): unknown
    playSamples(sampleChannels: number[][], volumeScale?: number, rate?: number, pan?: number, loop?: boolean): unknown
    buildSamples(...parameters: number[]): number[]
  }
}

declare module 'zzfx/wav.js' {
  export function buildWavURL(sampleChannels: number[][], sampleRate?: number): string
}
