// Iframe scene renderer

import type { PublishedScene } from './types'
import type { VariableStore } from './variables'

export class Renderer {
  private iframe: HTMLIFrameElement
  private container: HTMLElement
  private variables: VariableStore

  constructor(container: HTMLElement, variables: VariableStore) {
    this.container = container
    this.variables = variables
    this.iframe = document.createElement('iframe')
    this.iframe.style.cssText = `
      width: 1920px; height: 1080px;
      border: none; background: #000;
      position: absolute; top: 0; left: 0;
    `
    this.iframe.sandbox.add('allow-scripts')
    this.iframe.sandbox.add('allow-same-origin')
    this.container.appendChild(this.iframe)
  }

  async loadScene(scene: PublishedScene): Promise<void> {
    let html: string

    if (scene.htmlContent) {
      html = scene.htmlContent
    } else {
      try {
        const res = await fetch(scene.htmlUrl)
        html = await res.text()
      } catch {
        html = `<html><body style="background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <p>Failed to load scene</p></body></html>`
      }
    }

    // Variable interpolation
    html = this.variables.interpolate(html)

    return new Promise((resolve) => {
      this.iframe.onload = () => resolve()
      this.iframe.srcdoc = html
    })
  }

  pause(): void {
    try {
      const doc = this.iframe.contentDocument
      if (!doc) return
      let s = doc.getElementById('__ppctrl') as HTMLStyleElement | null
      if (!s) {
        s = doc.createElement('style')
        s.id = '__ppctrl'
        doc.head?.appendChild(s)
      }
      s.textContent = '*, *::before, *::after { animation-play-state: paused !important; }'
      doc.querySelectorAll<SVGSVGElement>('svg').forEach((svg) => (svg as any).pauseAnimations?.())
      doc.querySelectorAll<HTMLVideoElement>('video').forEach((v) => v.pause())
      ;(this.iframe.contentWindow as any)?.__pause?.()
    } catch {
      /* cross-origin iframe access may throw */
    }
  }

  resume(): void {
    try {
      const doc = this.iframe.contentDocument
      if (!doc) return
      let s = doc.getElementById('__ppctrl') as HTMLStyleElement | null
      if (!s) {
        s = doc.createElement('style')
        s.id = '__ppctrl'
        doc.head?.appendChild(s)
      }
      s.textContent = '*, *::before, *::after { animation-play-state: running !important; }'
      doc.querySelectorAll<SVGSVGElement>('svg').forEach((svg) => (svg as any).unpauseAnimations?.())
      doc.querySelectorAll<HTMLVideoElement>('video').forEach((v) => v.play().catch(() => {}))
      ;(this.iframe.contentWindow as any)?.__resume?.()
    } catch {
      /* cross-origin iframe access may throw */
    }
  }

  /** Seek the currently loaded scene to `time` seconds. Routed to the
   * scene's playback-controller via postMessage so the anime.js master timeline,
   * lottie, and scrub-registered callbacks all pick up the new position. */
  seek(time: number): void {
    try {
      this.iframe.contentWindow?.postMessage({ target: 'dreambyte-scene', type: 'seek', time }, '*')
      // Nudge SVG/media that don't listen on postMessage
      const doc = this.iframe.contentDocument
      if (doc) {
        doc.querySelectorAll<SVGSVGElement>('svg').forEach((svg) => {
          try {
            ;(svg as any).setCurrentTime?.(time)
          } catch {}
        })
        doc.querySelectorAll<HTMLMediaElement>('audio, video').forEach((m) => {
          try {
            m.currentTime = time
          } catch {}
        })
      }
    } catch {
      /* cross-origin iframe access may throw */
    }
  }

  destroy(): void {
    this.iframe.remove()
  }
}
