/**
 * CUDA GPU detection (Phase 2.3). Backs the GPU-probe seam so the capability
 * registry can offer the premium Marlin backend only on NVIDIA hosts.
 *
 * Probe: spawn `nvidia-smi -L` (lists GPUs). Exit 0 with at least one "GPU"
 * line = CUDA present. Any failure (binary missing, non-zero exit, timeout) =
 * no CUDA. macOS never has nvidia-smi, so this is always false here.
 */

import { spawn } from 'node:child_process'

const PROBE_TIMEOUT_MS = 4000

export function detectCudaGpu(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let out = ''
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('nvidia-smi', ['-L'])
    } catch {
      done(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      done(false)
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      done(false) // ENOENT — nvidia-smi not installed
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 && /\bGPU\s+\d+/i.test(out))
    })
  })
}
