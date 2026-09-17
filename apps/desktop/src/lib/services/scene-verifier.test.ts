// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setVerifierEnv, verifySceneUrl, type SceneOverflow, type SceneVerifyOutcome } from './scene-verifier'

/**
 * Tests for the offscreen scene verifier.
 *
 * Strategy: instead of dragging Electron in, we inject a synthetic
 * ElectronModule via the `setVerifierEnv` test seam. The fake exposes a
 * BrowserWindow that returns a controllable probe value from
 * executeJavaScript — letting us simulate every outcome (clean RAF, syntax
 * error, runtime error, timeout, CSS-only completion) without touching a
 * real Chromium process.
 */

interface FakeProbe {
  ticks: number
  error: SceneVerifyOutcome['error']
  readyState: 'loading' | 'interactive' | 'complete'
  installed: boolean
}

interface FakeListener {
  event: string
  handler: (...args: unknown[]) => void
}

class FakeWebContents {
  listeners: FakeListener[] = []
  destroyed = false
  probe: FakeProbe
  consoleEmissions: Array<[number, string, number, string]> = []
  failLoadEmission: [number, string, string, boolean] | null = null
  /**
   * Controllable result for the SECOND executeJavaScript call shape — the
   * overflow measurement probe (identified by the `getBoundingClientRect`
   * marker in its source). `undefined` simulates a measurement that threw
   * (the in-page try/catch would normally swallow to []; here we model the
   * outer executeJavaScript itself rejecting).
   */
  overflowResult: SceneOverflow[] | undefined | 'throw' = []

  constructor(probe: FakeProbe) {
    this.probe = probe
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.listeners.push({ event, handler })
    return this
  }
  off(event: string, handler: (...args: unknown[]) => void): this {
    this.listeners = this.listeners.filter((l) => !(l.event === event && l.handler === handler))
    return this
  }
  setAudioMuted(): void {}

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners) if (l.event === event) l.handler({}, ...args)
  }

  async executeJavaScript(script?: string): Promise<unknown> {
    // The overflow measurement probe is distinguishable from the verify-probe
    // by its layout-measurement marker.
    if (typeof script === 'string' && script.includes('getBoundingClientRect')) {
      if (this.overflowResult === 'throw') throw new Error('executeJavaScript failed')
      return this.overflowResult
    }
    return this.probe
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  webContents: FakeWebContents
  destroyed = false
  loadShouldFail: { code: number; description: string; url: string } | null = null
  onLoad: (() => void) | null = null

  constructor(_opts: unknown, probe: FakeProbe) {
    this.webContents = new FakeWebContents(probe)
    FakeBrowserWindow.instances.push(this)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }

  async loadURL(url: string): Promise<void> {
    if (this.loadShouldFail) {
      this.webContents.emit(
        'did-fail-load',
        this.loadShouldFail.code,
        this.loadShouldFail.description,
        this.loadShouldFail.url,
        true,
      )
      throw new Error(this.loadShouldFail.description)
    }
    if (this.onLoad) this.onLoad()
    void url
  }
}

function installFakeElectron(probeFactory: () => FakeProbe, overflowResult?: SceneOverflow[] | undefined | 'throw') {
  const probe = probeFactory()
  // The verifier-internal `createWindow` calls `new e.electron.BrowserWindow(opts)`
  // and reads no other Electron exports. We satisfy the type with a class
  // proxy that forwards the probe.
  const electronModule = {
    BrowserWindow: function (opts: unknown) {
      const w = new FakeBrowserWindow(opts, probe)
      w.webContents.overflowResult = overflowResult
      return w
    } as unknown as typeof import('electron').BrowserWindow,
  } as unknown as typeof import('electron')

  setVerifierEnv({
    electron: electronModule,
    preloadPath: '/fake/preload.js',
  })

  return { probe, getInstances: () => FakeBrowserWindow.instances }
}

beforeEach(() => {
  FakeBrowserWindow.instances = []
})

afterEach(() => {
  setVerifierEnv(null)
})

describe('verifySceneUrl', () => {
  it('returns "verified" when probe ticks within the warmup window', async () => {
    const probe: FakeProbe = {
      ticks: 0,
      error: null,
      readyState: 'complete',
      installed: true,
    }
    installFakeElectron(() => probe)

    // Simulate the page advancing one frame ~50ms in.
    setTimeout(() => {
      probe.ticks = 1
    }, 50)

    const outcome = await verifySceneUrl('dreambyte://scenes/abc.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 250,
    })
    expect(outcome.status).toBe('verified')
    expect(outcome.error).toBeNull()
  })

  it('returns "verified" for CSS-only scenes (no RAF, readyState complete past rafWait)', async () => {
    const probe: FakeProbe = {
      ticks: 0,
      error: null,
      readyState: 'complete',
      installed: true,
    }
    installFakeElectron(() => probe)

    const outcome = await verifySceneUrl('dreambyte://scenes/css-only.html', {
      timeoutMs: 1500,
      rafWaitMs: 250,
      warmupMs: 1000,
    })
    expect(outcome.status).toBe('verified')
  })

  it('returns "errored" with kind=syntax when the probe captures a SyntaxError', async () => {
    const probe: FakeProbe = {
      ticks: 0,
      error: null,
      readyState: 'complete',
      installed: true,
    }
    installFakeElectron(() => probe)

    setTimeout(() => {
      probe.error = {
        kind: 'syntax',
        message: 'SyntaxError: Unexpected token <',
        line: 12,
      }
    }, 30)

    const outcome = await verifySceneUrl('dreambyte://scenes/broken.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 500,
    })
    expect(outcome.status).toBe('errored')
    expect(outcome.error?.kind).toBe('syntax')
    expect(outcome.error?.line).toBe(12)
  })

  it('returns "errored" with kind=runtime for an unhandled rejection', async () => {
    const probe: FakeProbe = {
      ticks: 0,
      error: null,
      readyState: 'complete',
      installed: true,
    }
    installFakeElectron(() => probe)

    setTimeout(() => {
      probe.error = { kind: 'runtime', message: 'Cannot read properties of undefined' }
    }, 40)

    const outcome = await verifySceneUrl('dreambyte://scenes/runtime.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 500,
    })
    expect(outcome.status).toBe('errored')
    expect(outcome.error?.kind).toBe('runtime')
  })

  it('returns "errored" with kind=timeout when neither error nor tick fires before deadline', async () => {
    const probe: FakeProbe = {
      ticks: 0,
      error: null,
      readyState: 'loading', // never completes — simulates a hang
      installed: true,
    }
    installFakeElectron(() => probe)

    const outcome = await verifySceneUrl('dreambyte://scenes/hang.html', {
      timeoutMs: 250,
      rafWaitMs: 100,
      warmupMs: 200,
    })
    expect(outcome.status).toBe('errored')
    expect(outcome.error?.kind).toBe('timeout')
    expect(FakeBrowserWindow.instances[0].destroyed).toBe(true)
  })

  it('returns "unknown" when Electron is unavailable', async () => {
    setVerifierEnv({ electron: null, preloadPath: null })
    const outcome = await verifySceneUrl('dreambyte://scenes/x.html')
    expect(outcome.status).toBe('unknown')
    expect(outcome.error).toBeNull()
  })
})

describe('verifySceneUrl — layout-overflow advisory', () => {
  it('carries overflows on a verified scene when the page reports them', async () => {
    const probe: FakeProbe = { ticks: 0, error: null, readyState: 'complete', installed: true }
    const overflows: SceneOverflow[] = [
      { id: 'h1:"The Big Title…"', edges: ['right', 'bottom'], overflowPx: 42 },
    ]
    installFakeElectron(() => probe, overflows)

    setTimeout(() => {
      probe.ticks = 1
    }, 50)

    const outcome = await verifySceneUrl('dreambyte://scenes/overflow.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 250,
    })

    // Status is unaffected — overflow is advisory, the scene still verified.
    expect(outcome.status).toBe('verified')
    expect(outcome.overflows).toEqual(overflows)
  })

  it('reports an empty overflows array when the page finds none (still verified)', async () => {
    const probe: FakeProbe = { ticks: 0, error: null, readyState: 'complete', installed: true }
    installFakeElectron(() => probe, [])

    setTimeout(() => {
      probe.ticks = 1
    }, 50)

    const outcome = await verifySceneUrl('dreambyte://scenes/clean.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 250,
    })

    expect(outcome.status).toBe('verified')
    expect(outcome.overflows).toEqual([])
  })

  it('omits overflows (undefined) when the measurement throws — status unchanged', async () => {
    const probe: FakeProbe = { ticks: 0, error: null, readyState: 'complete', installed: true }
    installFakeElectron(() => probe, 'throw')

    setTimeout(() => {
      probe.ticks = 1
    }, 50)

    const outcome = await verifySceneUrl('dreambyte://scenes/measure-fail.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 250,
    })

    expect(outcome.status).toBe('verified')
    expect(outcome.overflows).toBeUndefined()
  })

  it('does NOT measure (no overflows) for an errored scene', async () => {
    const probe: FakeProbe = { ticks: 0, error: null, readyState: 'complete', installed: true }
    installFakeElectron(() => probe, [{ id: 'p:"x"', edges: ['top'], overflowPx: 99 }])

    setTimeout(() => {
      probe.error = { kind: 'runtime', message: 'boom' }
    }, 30)

    const outcome = await verifySceneUrl('dreambyte://scenes/broken.html', {
      timeoutMs: 1000,
      rafWaitMs: 200,
      warmupMs: 500,
    })

    expect(outcome.status).toBe('errored')
    expect(outcome.overflows).toBeUndefined()
  })
})
