/**
 * Verifier preload script — runs in the offscreen verifier BrowserWindow
 * BEFORE any scene script tag executes. Installs:
 *
 *   window.__dreambyteVerify.ticks  — number of RAF callbacks observed
 *   window.__dreambyteVerify.error  — first uncaught error / unhandled rejection
 *
 * The main process polls these via webContents.executeJavaScript after
 * navigation completes. See src/lib/services/scene-verifier.ts.
 *
 * Design constraints:
 *  - The verifier window runs with contextIsolation:false and nodeIntegration:false
 *    so this preload can write directly to `window` without contextBridge.
 *  - This file MUST stay self-contained — no Node imports — because the
 *    verifier window has no Node integration.
 *  - Scene HTML often wraps requestAnimationFrame for its own export-mode
 *    frame stepping (see src/lib/sceneTemplate.ts). We install our wrapper
 *    BEFORE the document's inline scripts execute (preload runs first),
 *    so even if the scene later swaps `window.requestAnimationFrame`, our
 *    counter sits on the inner side of the chain and still increments.
 */

interface VerifierProbe {
  ticks: number
  error: VerifierProbeError | null
  installedAt: number
}

interface VerifierProbeError {
  kind: 'syntax' | 'runtime' | 'timeout' | 'asset' | 'unknown'
  message: string
  line?: number
  source?: string
}

;(function installProbe() {
  if (typeof window === 'undefined') return
  // Window expando access — the verifier window deliberately runs without
  // contextIsolation so we can write directly. TS doesn't model this; cast
  // through `unknown` to keep both this file and the consumer (`window.__dreambyteVerify`)
  // self-contained without a global .d.ts augmentation.
  const w = window as unknown as Record<string, unknown>
  if (w.__dreambyteVerify) return

  const probe: VerifierProbe = {
    ticks: 0,
    error: null,
    installedAt: Date.now(),
  }
  w.__dreambyteVerify = probe

  const originalRAF = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
    return originalRAF(function (time: number) {
      probe.ticks++
      try {
        cb(time)
      } catch (err) {
        recordError(err, 'runtime')
        throw err
      }
    })
  }

  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      if (probe.error) return
      // Cross-origin script errors arrive as `Script error.` with no detail.
      // We still report them so the user knows something failed.
      const isSyntax = /SyntaxError|Unexpected token|Unexpected identifier/.test(event.message ?? '')
      probe.error = {
        kind: isSyntax ? 'syntax' : 'runtime',
        message: event.message || 'Unknown script error',
        line: typeof event.lineno === 'number' ? event.lineno : undefined,
        source: typeof event.filename === 'string' ? event.filename : undefined,
      }
    },
    true,
  )

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    if (probe.error) return
    const reason = (event.reason ?? {}) as { message?: string; stack?: string }
    probe.error = {
      kind: 'runtime',
      message: reason.message ?? String(event.reason ?? 'Unhandled rejection'),
    }
  })

  function recordError(err: unknown, kind: VerifierProbeError['kind']) {
    if (probe.error) return
    const e = (err ?? {}) as { message?: string }
    probe.error = {
      kind,
      message: e.message ?? String(err ?? 'Unknown error'),
    }
  }
})()

export {}
