/**
 * Standard little-endian mono PCM WAV (16-bit), browser- and FFmpeg-friendly.
 */

export function encodeMonoWavPcm16(samples: number[], sampleRate: number): Buffer {
  const n = samples.length
  const dataSize = n * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < n; i++) {
    let s = samples[i]!
    const v = s < 1 ? (s * (1 << 15)) | 0 : (1 << 15) - 1
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 2)
  }

  return buffer
}
