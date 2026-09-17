// @vitest-environment node
//
// Behavioral test of the host seek contract on the real anime.js bundle + the
// real playback controller, in jsdom: window.__clock.seek(t) must render the
// scene frame-exactly regardless of the previous time (export seeks forward,
// scrubs jump backward, the first frame is t=0 on a fresh timeline).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { PLAYBACK_CONTROLLER } from './playback-controller'

const ANIME = readFileSync(path.join(__dirname, '../../../public/vendor/animejs/anime.umd.min.js'), 'utf8')

function bootScene(sceneCode: string) {
  const dom = new JSDOM(
    `<!DOCTYPE html><body><div id="box"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div></body>`,
    { runScripts: 'outside-only', pretendToBeVisual: true },
  )
  const w = dom.window as unknown as Window & { eval: (s: string) => unknown; [k: string]: any }
  w.eval(ANIME)
  w.eval(`anime.engine.timeUnit = 's'; var SCENE_ID = 's1'; var DURATION = 6;`)
  w.eval(PLAYBACK_CONTROLLER)
  w.eval(sceneCode)
  return w
}

const SCENE = `
  var tl = window.__tl;
  var state = { t: 0 };
  window.__renders = [];
  tl.add(state, { t: [0, 4], duration: 4, ease: 'linear', onUpdate: function () { window.__renders.push(state.t); } }, 0);
  tl.add('#box', { opacity: [0, 1], x: [100, 0], duration: 1, ease: 'linear' }, 2);
  tl.add('#box', { opacity: 0, duration: 1, ease: 'linear' }, 4);
  tl.add('.dot', { opacity: [0, 1], duration: 0.5, ease: 'linear', delay: anime.stagger(0.5) }, 1);
`

function frame(w: any) {
  const box = w.document.getElementById('box')
  const dots = [...w.document.querySelectorAll('.dot')].map((d: any) => d.style.opacity)
  return { box: `${box.style.opacity}|${box.style.transform}`, dots: dots.join(','), t: w.__dreambyte.time() }
}

describe('window.__clock (host seek contract on anime.js)', () => {
  it('exposes the host API and counts scene-registered children', () => {
    const w = bootScene(SCENE)
    expect(typeof w.__clock.seek).toBe('function')
    expect(w.__clock.duration()).toBe(6)
    expect(w.__clock.childCount()).toBe(4) // proxy + 2 box tweens + 1 staggered multi-target tween
    expect(w.__clock.isActive()).toBe(false)
  })

  it('renders the initial state at t=0 on a fresh timeline (later tweens show their from-values)', () => {
    const w = bootScene(SCENE)
    w.__clock.seek(0)
    const f = frame(w)
    expect(f.box).toBe('0|translateX(100px)')
    expect(f.dots).toBe('0,0,0')
  })

  it('is frame-exact and independent of seek order (forward, backward, repeated)', () => {
    const times = [0, 1.25, 2.5, 3, 4.5, 5.9, 6]
    const forward = bootScene(SCENE)
    const expected = times.map((t) => (forward.__clock.seek(t), frame(forward)))

    // Spot-check real values at 2.5s: box halfway in, all dots done.
    expect(expected[2].box).toBe('0.5|translateX(50px)')
    expect(expected[2].dots).toBe('1,1,1')
    // 1.25s: first dot half in, second not started
    expect(expected[1].dots).toBe('0.5,0,0')
    // 4.5s: box fading out (from its end value 1)
    expect(expected[4].box.startsWith('0.5|')).toBe(true)

    // Reverse order and shuffled/repeated seeks on a fresh scene must match.
    const reverse = bootScene(SCENE)
    const reversed = [...times]
      .reverse()
      .map((t) => (reverse.__clock.seek(t), frame(reverse)))
      .reverse()
    expect(reversed).toEqual(expected)

    const jumpy = bootScene(SCENE)
    for (const i of [6, 2, 2, 0, 5, 1, 4, 3, 3]) {
      jumpy.__clock.seek(times[i])
      expect(frame(jumpy)).toEqual(expected[i])
    }
  })

  it('re-renders at the same time (seek to the current time is not a no-op)', () => {
    const w = bootScene(SCENE)
    w.__clock.seek(1)
    const n = w.__renders.length
    w.__clock.seek(1)
    expect(w.__renders.length).toBeGreaterThan(n)
  })

  it('proxy onUpdate redraws when scrubbing back to t=0 (anime fires no callbacks at exactly 0)', () => {
    const w = bootScene(SCENE)
    w.__clock.seek(3)
    w.__renders.length = 0
    w.__clock.seek(0)
    expect(w.__renders.length).toBeGreaterThan(0)
    expect(w.__renders[w.__renders.length - 1]).toBeLessThan(0.001)
  })

  it('proxy callbacks redraw when a jump lands outside their active range', () => {
    const w = bootScene(`
      window.__draws = [];
      var late = { v: 0 };
      window.__tl.add(late, { v: [10, 20], duration: 1, ease: 'linear', onUpdate: function () { window.__draws.push(late.v); } }, 3);
    `)
    w.__clock.seek(5) // after the proxy's end → draws its end value
    expect(w.__draws[w.__draws.length - 1]).toBe(20)
    w.__clock.seek(1) // before its start → must redraw the from value, not keep 20
    expect(w.__draws[w.__draws.length - 1]).toBe(10)
  })

  it('fires onTick subscribers with the seek time and clamps to DURATION', () => {
    const w = bootScene(SCENE)
    const ticks: number[] = []
    w.__dreambyte.onTick((t: number) => ticks.push(t))
    expect(w.__clock.seek(3.5)).toBe(3.5)
    expect(w.__clock.seek(99)).toBe(6)
    expect(ticks).toEqual([3.5, 6])
    expect(w.__dreambyte.time()).toBe(6)
  })

  it('children added after a seek (late module scripts) are primed on the next seek', () => {
    const w = bootScene(SCENE)
    w.__clock.seek(2.5)
    w.eval(`window.__tl.add('.dot', { x: [0, 40], duration: 1, ease: 'linear' }, 5)`)
    w.__clock.seek(2.5)
    const dot: any = w.document.querySelector('.dot')
    expect(dot.style.transform).toBe('translateX(0px)')
    w.__clock.seek(5.5)
    expect(dot.style.transform).toBe('translateX(20px)')
  })
})
