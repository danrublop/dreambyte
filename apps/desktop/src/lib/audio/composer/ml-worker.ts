/**
 * Native music composer — shared ML worker plumbing.
 *
 * Spawn + path/checkpoint resolution shared by the melody (ImprovRNN) and drums
 * (GrooVAE) generators, so the child-process boilerplate lives in ONE place. The
 * model-specific request/response shaping stays in ml-melody.ts / ml-drums.ts.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Spawn a magenta worker (.cjs), write ONE JSON request to its stdin, resolve its
 * ONE JSON response payload. The worker redirects banners to stderr, so stdout is
 * just the JSON object; we still extract defensively. Rejects on timeout, a
 * `{ok:false}` payload, or unparseable output — every caller treats a rejection as
 * "fall back to the deterministic path".
 */
export function spawnMagentaWorker(
  workerPath: string,
  req: Record<string, unknown>,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE lets the Electron binary run the worker as plain Node;
    // harmless under a real `node` (tests).
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
      try {
        const parsed = JSON.parse(jsonStr)
        if (!parsed.ok) return reject(new Error(parsed.error || `${label} failed`))
        resolve(parsed)
      } catch {
        reject(new Error(`${label} produced no parseable output${err ? `: ${err.slice(0, 200)}` : ''}`))
      }
    })
    child.stdin.write(JSON.stringify(req))
    child.stdin.end()
  })
}

/**
 * Resolve a bundled magenta checkpoint dir across dev + packaged Electron. Next
 * copies public/ → out/, shipped inside the asar, so the packaged dir lives at
 * <resources>/app.asar/out/magenta/<name>/. The DREAMBYTE_MAGENTA_DIR override
 * points directly at the ImprovRNN dir (melody) and is ignored for other names.
 */
export function resolveMagentaCheckpoint(name = 'chord_pitches_improv'): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const rel = join('magenta', name)
  const candidates = [
    name === 'chord_pitches_improv' ? process.env.DREAMBYTE_MAGENTA_DIR : undefined,
    join(process.cwd(), 'public', rel),
    join(process.cwd(), 'out', rel),
    resourcesPath ? join(resourcesPath, 'app.asar', 'out', rel) : undefined,
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'out', rel) : undefined,
    resourcesPath ? join(resourcesPath, 'app', 'out', rel) : undefined,
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(join(p, 'weights_manifest.json'))) ?? null
}

/** Resolve a worker .cjs (ml-melody-worker.cjs / ml-drums-worker.cjs) co-located in
 *  dev/tests or copied into dist-electron for the packaged app. */
export function resolveMagentaWorker(filename: string): string | null {
  let here = ''
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    /* CJS bundle — fall back below */
  }
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    here ? join(here, filename) : undefined,
    join(process.cwd(), 'src', 'lib', 'audio', 'composer', filename),
    join(process.cwd(), 'dist-electron', filename),
    resourcesPath ? join(resourcesPath, 'app.asar', 'dist-electron', filename) : undefined,
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p)) ?? null
}
