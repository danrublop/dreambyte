// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { setGpuProbe, detectCuda, resetGpuProbeCache } from './gpu-probe'

afterEach(() => {
  setGpuProbe(null)
  resetGpuProbeCache()
})

describe('gpu-probe seam', () => {
  it('defaults to false with no probe registered', async () => {
    expect(await detectCuda()).toBe(false)
  })

  it('returns the registered probe result', async () => {
    setGpuProbe(async () => true)
    expect(await detectCuda()).toBe(true)
  })

  it('degrades to false when the probe throws', async () => {
    setGpuProbe(async () => {
      throw new Error('nvidia-smi blew up')
    })
    expect(await detectCuda()).toBe(false)
  })

  it('caches the first result (probe called once)', async () => {
    let calls = 0
    setGpuProbe(async () => {
      calls++
      return true
    })
    await detectCuda()
    await detectCuda()
    expect(calls).toBe(1)
  })
})
