/**
 * GPU-probe seam (premium backends).
 *
 * Premium video understanding (Marlin-2B) needs an NVIDIA/CUDA GPU. Detecting
 * one means shelling out to `nvidia-smi`, which only the Electron main process
 * should do — so `src/lib/` declares the seam and Electron registers the real probe
 * at boot (`setGpuProbe`). Default returns false (no CUDA), which is correct for
 * this Mac, headless test runs, and any host without the probe wired.
 *
 * Result is cached after the first call (GPU presence doesn't change within a
 * session); `resetGpuProbeCache()` exists for tests.
 */

export type GpuProbe = () => Promise<boolean>

let probe: GpuProbe | null = null
let cached: boolean | null = null

export function setGpuProbe(fn: GpuProbe | null): void {
  probe = fn
  cached = null
}

/** True when a CUDA GPU is available. Cached per session; never throws. */
export async function detectCuda(): Promise<boolean> {
  if (cached !== null) return cached
  if (!probe) {
    cached = false
    return false
  }
  try {
    cached = await probe()
  } catch {
    cached = false
  }
  return cached
}

/** Test-only: clear the cached result (and probe) between cases. */
export function resetGpuProbeCache(): void {
  cached = null
}
