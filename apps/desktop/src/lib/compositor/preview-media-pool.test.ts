import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PreviewMediaPool } from './preview-media-pool'
import type { CompositeLayer } from '@/lib/timeline/composite-frame'

const mediaLayer = (
  over: Partial<CompositeLayer> & { layerKey: string; kind: 'video' | 'image'; src: string },
): CompositeLayer => ({
  sceneId: '',
  clipId: over.layerKey,
  localT: 0,
  z: 1,
  opacity: 1,
  scaleX: 1,
  scaleY: 1,
  posX: 0,
  posY: 0,
  rotation: 0,
  filterCss: '',
  blendMode: '',
  ...over,
})

// jsdom doesn't implement <video> playback; make `paused` writable + stub play so
// the playing-path drift logic is testable deterministically.
function makePlayable(v: HTMLVideoElement) {
  let paused = true
  Object.defineProperty(v, 'paused', { get: () => paused, configurable: true })
  v.play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  })
  v.pause = vi.fn(() => {
    paused = true
  })
}

describe('PreviewMediaPool', () => {
  let container: HTMLElement
  let pool: PreviewMediaPool

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    pool = new PreviewMediaPool(container)
  })

  it('mounts a <video> for a video layer and an <img> for an image layer, keyed by clipId', () => {
    pool.sync(
      [
        mediaLayer({ layerKey: 'v', kind: 'video', src: '/uploads/a.mp4' }),
        mediaLayer({ layerKey: 'i', kind: 'image', src: '/uploads/p.png' }),
      ],
      false,
    )
    expect(container.querySelectorAll('video')).toHaveLength(1)
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(pool.size).toBe(2)
    expect(container.querySelector('video')?.getAttribute('src')).toBe('/uploads/a.mp4')
    expect((container.querySelector('video') as HTMLVideoElement).muted).toBe(true)
  })

  it('applies the shared element style (transform/filter/blend/opacity/z)', () => {
    pool.sync(
      [
        mediaLayer({
          layerKey: 'v',
          kind: 'video',
          src: '/u/a.mp4',
          scaleX: 0.5,
          scaleY: 0.5,
          posX: 40,
          posY: 80,
          rotation: 15,
          filterCss: 'blur(2px)',
          blendMode: 'multiply',
          opacity: 0.8,
          z: 3,
        }),
      ],
      false,
    )
    const v = container.querySelector('video') as HTMLVideoElement
    expect(v.style.transform).toBe('translate(40px,80px) rotate(15deg) scale(0.5,0.5)')
    expect(v.style.filter).toBe('blur(2px)')
    expect(v.style.mixBlendMode).toBe('multiply')
    expect(v.style.opacity).toBe('0.8')
    expect(v.style.zIndex).toBe('3')
  })

  it('does NOT remount the same clip across syncs (stable element)', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4' })], false)
    const first = container.querySelector('video')
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 2 })], false)
    expect(container.querySelector('video')).toBe(first)
    expect(pool.size).toBe(1)
  })

  it('evicts inactive media (removed from DOM + pool)', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4' })], false)
    expect(pool.size).toBe(1)
    pool.sync([], false) // clip no longer active
    expect(pool.size).toBe(0)
    expect(container.querySelectorAll('video')).toHaveLength(0)
  })

  it('SCRUB (isPlaying=false): seeks currentTime to the playhead + pauses', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 0 })], false)
    const v = container.querySelector('video') as HTMLVideoElement
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 3.5 })], false)
    expect(v.currentTime).toBeCloseTo(3.5)
  })

  it('PLAYING: DEBOUNCED drift-correct — reseek only after 2 consecutive >50ms samples', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 0 })], true)
    const v = container.querySelector('video') as HTMLVideoElement
    makePlayable(v)

    // In sync (<50ms drift): never corrected.
    v.currentTime = 1.0
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.02 })], true)
    expect(v.currentTime).toBeCloseTo(1.0) // not corrected (20ms < 50ms)

    // Drift >50ms, sample 1: NOT yet corrected (debounce).
    v.currentTime = 1.0
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.2 })], true)
    expect(v.currentTime).toBeCloseTo(1.0) // 1 sample only

    // Drift >50ms, sample 2 (consecutive): reseek to expected.
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.2 })], true)
    expect(v.currentTime).toBeCloseTo(1.2) // corrected on the 2nd consecutive sample

    // An in-sync sample resets the counter (no thrash).
    v.currentTime = 1.2
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.21 })], true)
    expect(v.currentTime).toBeCloseTo(1.2) // 10ms < 50ms → not corrected, counter reset
  })

  it('applies the shared element style to <img> too (transform + filter), not just <video>', () => {
    pool.sync(
      [mediaLayer({ layerKey: 'i', kind: 'image', src: '/u/p.png', posX: 10, posY: 20, filterCss: 'grayscale(1)' })],
      false,
    )
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.style.transform).toBe('translate(10px,20px)')
    expect(img.style.filter).toBe('grayscale(1)')
  })

  it('PLAYING: a NON-consecutive drift does NOT correct (an in-sync tick resets the counter)', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 0 })], true)
    const v = container.querySelector('video') as HTMLVideoElement
    makePlayable(v)
    // drift >50ms, sample 1 — not corrected (debounce)
    v.currentTime = 1.0
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.2 })], true)
    expect(v.currentTime).toBeCloseTo(1.0)
    // an in-sync tick (0 drift) resets the consecutive counter
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.0 })], true)
    expect(v.currentTime).toBeCloseTo(1.0)
    // drift again, but only ONE sample since the reset → must NOT reseek
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', localT: 1.3 })], true)
    expect(v.currentTime).toBeCloseTo(1.0) // single post-reset sample, no correction
  })

  it('eviction PAUSES the <video> and CLEARS its src (no leaked decoder — export F2 lesson)', () => {
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4' })], true)
    const v = container.querySelector('video') as HTMLVideoElement
    makePlayable(v)
    pool.sync([], true) // clip no longer active → evict
    expect(v.pause).toHaveBeenCalled()
    expect(v.getAttribute('src')).toBe(null)
    expect(pool.size).toBe(0)
  })

  it('webgl-tier grade with no WebGL2 (jsdom) FALLS BACK to styling the raw element (no dead canvas overlay)', () => {
    const grade = {
      tier: 'webgl' as const,
      filterCss: '',
      svgFilterMarkup: '',
      svgFilterId: 'clip-grade-v',
      vignette: 0,
      raw: { hueCurves: { targets: [{ targetHue: 30, hueShift: 12 }] } },
    }
    pool.sync([mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4', filterCss: 'blur(1px)', grade })], false)
    const v = container.querySelector('video') as HTMLVideoElement
    // jsdom has no WebGL2 → the element stays visible + styled, and no <canvas> is mounted.
    expect(container.querySelectorAll('canvas')).toHaveLength(0)
    expect(v.style.visibility).toBe('visible')
    expect(v.style.filter).toBe('blur(1px)')
  })

  it('dispose() tears down all elements', () => {
    pool.sync(
      [
        mediaLayer({ layerKey: 'v', kind: 'video', src: '/u/a.mp4' }),
        mediaLayer({ layerKey: 'i', kind: 'image', src: '/u/p.png' }),
      ],
      false,
    )
    pool.dispose()
    expect(pool.size).toBe(0)
    expect(container.children).toHaveLength(0)
  })
})
