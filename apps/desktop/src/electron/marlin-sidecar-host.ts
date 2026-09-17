/**
 * Marlin-2B sidecar host (Phase 2.3). Manages a persistent Python child process
 * that loads Marlin-2B once and answers caption/find requests over stdio
 * newline-delimited JSON-RPC. Mirrors `mediapipe-detector-host` lifecycle: lazy
 * boot on first request, reuse across calls (model load is the expensive part),
 * dispose on `before-quit`.
 *
 * Only spawned when a GPU host registers the Marlin understander; on failure
 * (Python missing, model not downloaded, non-zero exit) requests reject and the
 * caller degrades to an error analysis. `src/lib/` never imports this — it goes
 * through the injected `caption` fn in `createMarlinUnderstander`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createLogger } from '@/lib/logger'
import type { MarlinCaption } from '@/lib/services/marlin-understander'

const log = createLogger('marlin-sidecar')

/** Marlin inference can be slow (frames decode + 2B model). Generous per-call cap. */
const REQUEST_TIMEOUT_MS = 300_000

type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams

/** Python modules marlin_server.py imports (pip names in sidecars/marlin/requirements.txt). */
const REQUIRED_PYTHON_MODULES = ['torch', 'transformers', 'torchcodec', 'qwen_vl_utils', 'av', 'PIL']
/** Importing torch cold can take a while; the check runs in the background at boot. */
const RUNTIME_CHECK_TIMEOUT_MS = 60_000

export function defaultMarlinPython(): string {
  return process.env.DREAMBYTE_PYTHON || 'python3'
}

/**
 * Where marlin_server.py lives. Packaged builds ship it via electron-builder
 * `extraResources` to `<resources>/sidecars/marlin/` (Python can't read from
 * app.asar). In dev it's the repo's sidecars/marlin/, one level up from both
 * src/electron/ and the bundled dist-electron/.
 */
export function resolveMarlinScriptPath(opts: { isPackaged: boolean; resourcesPath: string; moduleDir: string }): string {
  const root = opts.isPackaged ? opts.resourcesPath : path.join(opts.moduleDir, '..')
  return path.join(root, 'sidecars', 'marlin', 'marlin_server.py')
}

export type MarlinRuntimeCheck = { ok: true } | { ok: false; reason: string }

/**
 * Can the sidecar actually run here? Checks the script exists and that the
 * interpreter imports every module the server needs. Never throws.
 */
export function checkMarlinRuntime(opts: {
  scriptPath: string
  pythonPath?: string
  spawnImpl?: SpawnFn
  timeoutMs?: number
}): Promise<MarlinRuntimeCheck> {
  const python = opts.pythonPath ?? defaultMarlinPython()
  const requirements = path.join(path.dirname(opts.scriptPath), 'requirements.txt')
  const setupHint = `install the Python dependencies with \`${python} -m pip install -r "${requirements}"\` (or point DREAMBYTE_PYTHON at an environment that has them), then restart Dreambyte`
  if (!fs.existsSync(opts.scriptPath)) {
    return Promise.resolve({ ok: false, reason: `Marlin sidecar script not found at ${opts.scriptPath}` })
  }
  const doSpawn = opts.spawnImpl ?? (spawn as unknown as SpawnFn)
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const done = (r: MarlinRuntimeCheck) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = doSpawn(python, ['-c', `import ${REQUIRED_PYTHON_MODULES.join(', ')}`])
    } catch (err) {
      resolve({ ok: false, reason: `Python not found (${python}): ${(err as Error).message}; ${setupHint}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      done({ ok: false, reason: `Timed out checking the Python environment (${python}); ${setupHint}` })
    }, opts.timeoutMs ?? RUNTIME_CHECK_TIMEOUT_MS)
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => done({ ok: false, reason: `Python not found (${python}): ${err.message}; ${setupHint}` }))
    child.on('close', (code) => {
      if (code === 0) return done({ ok: true })
      const missing = /No module named '([^']+)'/.exec(stderr)?.[1]
      done({
        ok: false,
        reason: `${missing ? `Python module "${missing}" is missing` : `Python environment check failed (exit ${code})`}; ${setupHint}`,
      })
    })
  })
}

export interface MarlinSidecarOptions {
  /** Python interpreter. Default: $DREAMBYTE_PYTHON or 'python3'. */
  pythonPath?: string
  /** Path to marlin_server.py. Default: repo sidecars/marlin/marlin_server.py (dev layout). */
  scriptPath?: string
  /** Injectable spawn (tests). Defaults to child_process.spawn. */
  spawnImpl?: SpawnFn
}

interface Pending {
  resolve: (v: MarlinCaption) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface MarlinSidecar {
  caption(source: string, opts?: { abortSignal?: AbortSignal }): Promise<MarlinCaption>
  dispose(): void
}

export function createMarlinSidecar(options: MarlinSidecarOptions = {}): MarlinSidecar {
  const python = options.pythonPath ?? defaultMarlinPython()
  // Dev default only; src/electron/main.ts passes resolveMarlinScriptPath(), which
  // handles the packaged resources location.
  const script = options.scriptPath ?? path.join(__dirname, '..', 'sidecars', 'marlin', 'marlin_server.py')
  const doSpawn = options.spawnImpl ?? (spawn as unknown as SpawnFn)

  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let stdoutBuf = ''
  // Decode across chunk boundaries so a multi-byte UTF-8 char (common in caption
  // text) split between two 'data' events doesn't corrupt the JSON line.
  const decoder = new StringDecoder('utf8')
  const pending = new Map<number, Pending>()

  const failAll = (err: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child && !child.killed) return child
    // Fresh process → drop any partial line left by a crashed predecessor so it
    // can't corrupt the new child's first JSON frame.
    stdoutBuf = ''
    const c = doSpawn(python, [script])
    child = c
    c.stdout.on('data', (d: Buffer) => {
      stdoutBuf += decoder.write(d)
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        let msg: { id?: number; ok?: boolean; result?: MarlinCaption; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          log.warn('non-JSON line from sidecar', { extra: { line: line.slice(0, 200) } })
          continue
        }
        if (typeof msg.id !== 'number') continue
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok && msg.result) p.resolve(msg.result)
        else p.reject(new Error(msg.error || 'Marlin sidecar returned an error'))
      }
    })
    c.stderr.on('data', (d: Buffer) => log.warn('sidecar stderr', { extra: { msg: d.toString().slice(0, 300) } }))
    c.on('error', (err) => {
      log.warn('sidecar spawn error', { error: err })
      child = null
      failAll(err instanceof Error ? err : new Error(String(err)))
    })
    c.on('close', (code) => {
      child = null
      failAll(new Error(`Marlin sidecar exited (code ${code})`))
    })
    return c
  }

  return {
    caption(source, opts = {}) {
      return new Promise<MarlinCaption>((resolve, reject) => {
        let c: ChildProcessWithoutNullStreams
        try {
          c = ensureChild()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error('Marlin sidecar timed out'))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        opts.abortSignal?.addEventListener('abort', () => {
          if (pending.delete(id)) {
            clearTimeout(timer)
            reject(new Error('aborted'))
          }
        })
        try {
          c.stdin.write(JSON.stringify({ id, op: 'caption', source }) + '\n')
        } catch (err) {
          if (pending.delete(id)) {
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })
    },
    dispose() {
      failAll(new Error('Marlin sidecar disposed'))
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      child = null
    },
  }
}
