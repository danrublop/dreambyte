/**
 * DreambyteMotion — anime.js-powered animation component library for Dreambyte.
 *
 * All functions add children to a provided anime.js timeline (opts.tl, usually
 * window.__tl) so the playback controller can seek to any frame and get the
 * correct state. Times are seconds (anime.engine.timeUnit = 's').
 *
 * Usage:
 *   const tl = window.__tl
 *   DreambyteMotion.textReveal('.title', { tl, delay: 0 })
 *   DreambyteMotion.countUp('#metric', { to: 42000, format: ',.0f', prefix: '$', tl, delay: 1 })
 */
;(function (global) {
  'use strict'

  // ── Utilities ────────────────────────────────────────────────────────────────

  function el(selector) {
    if (typeof selector === 'string') return document.querySelector(selector)
    return selector
  }

  function els(selector) {
    if (typeof selector === 'string') return Array.from(document.querySelectorAll(selector))
    if (selector instanceof NodeList) return Array.from(selector)
    if (Array.isArray(selector)) return selector
    return [selector]
  }

  // Seeded PRNG (mulberry32) — deterministic randomness for reproducible renders
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed)
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
      return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
  }
  // Old stagger `from` names -> anime.stagger names
  function staggerFrom(from) {
    if (from === 'start') return 'first'
    if (from === 'end') return 'last'
    return from || 'first'
  }

  // Percent range ('0%' = '0% 0%', '20% 80%', or fractions '0 1') -> anime draw value 'start end'
  function drawRange(v, def) {
    if (v == null) v = def
    var p = String(v).trim().split(/\s+/).map(function (s) {
      var n = parseFloat(s)
      return /%$/.test(s) ? n / 100 : n
    })
    return p.length === 1 ? '0 ' + p[0] : p[0] + ' ' + p[1]
  }

  // SI suffixes for formatNumber
  var SI = [
    { v: 1e12, s: 'T' },
    { v: 1e9, s: 'B' },
    { v: 1e6, s: 'M' },
    { v: 1e3, s: 'K' },
  ]

  /**
   * Lightweight number formatter.
   * Supports d3-style format strings:
   *   ','    — comma grouping (1000 → 1,000)
   *   '.Nf'  — fixed N decimals (1234.5 → 1234.50)
   *   ',.0f' — comma + integer
   *   '$,.2f'— dollar + comma + 2 decimals (prefix handled separately)
   *   '.Ns'  — SI notation (1200000 → 1.2M)
   *   '.N%'  — percentage (0.47 → 47.0%)
   */
  function formatNumber(value, fmt) {
    if (!fmt) return String(Math.round(value))

    // Percentage: multiply by 100
    var pctMatch = fmt.match(/\.(\d+)%/)
    if (pctMatch) {
      var pctDec = parseInt(pctMatch[1])
      return addCommas((value * 100).toFixed(pctDec), fmt) + '%'
    }

    // SI notation: .2s → 1.2M
    var siMatch = fmt.match(/\.(\d+)s/)
    if (siMatch) {
      var siDec = parseInt(siMatch[1])
      for (var i = 0; i < SI.length; i++) {
        if (Math.abs(value) >= SI[i].v) {
          return (value / SI[i].v).toFixed(siDec) + SI[i].s
        }
      }
      return value.toFixed(siDec)
    }

    // Fixed decimal: .2f
    var fixedMatch = fmt.match(/\.(\d+)f/)
    var str
    if (fixedMatch) {
      str = value.toFixed(parseInt(fixedMatch[1]))
    } else {
      str = String(Math.round(value))
    }

    return addCommas(str, fmt)
  }

  function addCommas(str, fmt) {
    if (fmt.indexOf(',') === -1) return str
    var parts = str.split('.')
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.join('.')
  }

  // ── Components ───────────────────────────────────────────────────────────────

  var DreambyteMotion = {

    // ── 1. textReveal ──────────────────────────────────────────────────────────
    /**
     * Animated text reveal using anime.text.split.
     * @param {string|Element} selector
     * @param {Object} opts
     * @param {string} opts.style — 'chars'|'words'|'lines'|'mask'|'typewriter'|'scatter'
     * @param {Timeline} opts.tl — anime.js timeline to add to
     * @param {number} [opts.delay=0]
     * @param {number} [opts.duration]
     * @param {number} [opts.stagger]
     * @param {string} [opts.ease]
     */
    textReveal: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target) return
      var tl = opts.tl
      if (!tl) return
      var style = opts.style || 'words'
      var delay = opts.delay || 0

      if (style === 'typewriter') {
        var typeChars = anime.text.split(target, { chars: true }).chars
        if (!typeChars.length) return
        var typeDuration = opts.duration || (typeChars.length * 0.04)
        anime.set(typeChars, { opacity: 0 })
        tl.add(typeChars, {
          opacity: [0, 1],
          duration: 0.01,
          delay: anime.stagger(typeDuration / typeChars.length),
          ease: 'linear',
        }, delay)
        return
      }

      if (style === 'mask') {
        // Cinematic masked reveal: each word slides up inside a clipping wrapper
        var maskWords = anime.text.split(target, { words: { wrap: 'clip' } }).words
        anime.set(maskWords, { y: '100%' })
        tl.add(maskWords, {
          y: '0%',
          duration: opts.duration || 0.8,
          delay: anime.stagger(opts.stagger || 0.06),
          ease: opts.ease || 'outQuart',
        }, delay)
        return
      }

      if (style === 'scatter') {
        var scatterChars = anime.text.split(target, { chars: true }).chars
        var rng = mulberry32(opts.seed || 42)
        scatterChars.forEach(function (c) {
          anime.set(c, {
            opacity: 0,
            x: (rng() - 0.5) * 400,
            y: (rng() - 0.5) * 300,
            rotate: (rng() - 0.5) * 90,
            scale: 0.3,
          })
        })
        tl.add(scatterChars, {
          opacity: 1, x: 0, y: 0, rotate: 0, scale: 1,
          duration: opts.duration || 0.8,
          delay: anime.stagger(opts.stagger || 0.02),
          ease: opts.ease || 'outBack(1.4)',
        }, delay)
        return
      }

      // chars, words, lines
      var defaultStagger = style === 'chars' ? 0.03 : style === 'lines' ? 0.12 : 0.08

      if (style === 'lines') {
        // Lines slide up from below. Line splitting waits for fonts, so the
        // children are added once the split is ready (synchronously if it already is).
        var linesAdded = false
        anime.text.split(target, { lines: true }).addEffect(function (split) {
          if (linesAdded) return
          linesAdded = true
          anime.set(split.lines, { opacity: 0, y: 50 })
          tl.add(split.lines, {
            opacity: 1, y: 0,
            duration: opts.duration || 0.7,
            delay: anime.stagger(opts.stagger || defaultStagger),
            ease: opts.ease || 'outQuart',
          }, delay)
        })
        return
      }

      var splitType = style === 'chars' ? 'chars' : 'words'
      var splitParams = {}
      splitParams[splitType] = true
      var targets = anime.text.split(target, splitParams)[splitType]

      if (style === 'chars') {
        anime.set(targets, { opacity: 0, y: 20, scale: 0.8 })
        tl.add(targets, {
          opacity: 1, y: 0, scale: 1,
          duration: opts.duration || 0.6,
          delay: anime.stagger(opts.stagger || defaultStagger),
          ease: opts.ease || 'outCubic',
        }, delay)
      } else {
        // words (default)
        anime.set(targets, { opacity: 0, y: 25 })
        tl.add(targets, {
          opacity: 1, y: 0,
          duration: opts.duration || 0.6,
          delay: anime.stagger(opts.stagger || defaultStagger),
          ease: opts.ease || 'outCubic',
        }, delay)
      }
    },

    // ── 2. fadeUp ──────────────────────────────────────────────────────────────
    fadeUp: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return
      anime.set(targets, { opacity: 0, y: opts.distance || 30 })
      opts.tl.add(targets, {
        opacity: 1, y: 0,
        duration: opts.duration || 0.8,
        delay: anime.stagger(opts.stagger || 0),
        ease: opts.ease || 'outQuart',
      }, opts.delay || 0)
    },

    // ── 3. staggerIn ──────────────────────────────────────────────────────────
    /**
     * @param {string} opts.from — 'first'|'last'|'center'|'random' (or an index)
     * @param {string} opts.direction — 'up'|'down'|'left'|'right'|'scale'
     */
    staggerIn: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return
      var dir = opts.direction || 'up'
      var fromVars = { opacity: 0 }

      if (dir === 'up') fromVars.y = 40
      else if (dir === 'down') fromVars.y = -40
      else if (dir === 'left') fromVars.x = -60
      else if (dir === 'right') fromVars.x = 60
      else if (dir === 'scale') { fromVars.scale = 0; fromVars.transformOrigin = '50% 50%' }

      anime.set(targets, fromVars)

      opts.tl.add(targets, {
        opacity: 1, x: 0, y: 0, scale: 1,
        duration: opts.duration || 0.6,
        // seed: deterministic order for from: 'random'
        delay: anime.stagger(opts.stagger || 0.1, { from: staggerFrom(opts.from), seed: true }),
        ease: opts.ease || 'outCubic',
      }, opts.delay || 0)
    },

    // ── 4. countUp ────────────────────────────────────────────────────────────
    countUp: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl) return
      var from = opts.from != null ? opts.from : 0
      var to = opts.to != null ? opts.to : 100
      var prefix = opts.prefix || ''
      var suffix = opts.suffix || ''
      var fmt = opts.format || null

      var proxy = { value: from }
      target.textContent = prefix + formatNumber(from, fmt) + suffix

      var step = 1
      if (fmt) {
        var m = fmt.match(/\.(\d+)f/)
        if (m) { var d = parseInt(m[1]); step = d > 0 ? Math.pow(10, -d) : 1 }
      }

      opts.tl.add(proxy, {
        value: [from, to],
        duration: opts.duration || 1.5,
        ease: opts.ease || 'outCubic',
        modifier: anime.utils.snap(step),
        onUpdate: function () {
          target.textContent = prefix + formatNumber(proxy.value, fmt) + suffix
        },
      }, opts.delay || 0)
    },

    // ── 5. drawPath ───────────────────────────────────────────────────────────
    /**
     * @param {string} [opts.from='0%'] — visible range at start ('0%', '20% 80%', or fractions '0 0')
     * @param {string} [opts.to='100%'] — visible range at end
     */
    drawPath: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return

      var drawables = anime.svg.createDrawable(targets)
      var fromDraw = drawRange(opts.from, '0%')
      anime.set(drawables, { draw: fromDraw })
      opts.tl.add(drawables, {
        draw: [fromDraw, drawRange(opts.to, '100%')],
        duration: opts.duration || 1.2,
        delay: anime.stagger(opts.stagger || 0),
        ease: opts.ease || 'inOutCubic',
      }, opts.delay || 0)
    },

    // ── 6. morphShape ─────────────────────────────────────────────────────────
    /**
     * @param {string|Element} opts.to — target shape (selector/element), or raw path data
     */
    morphShape: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl || !opts.to) return

      // note: raw path data is interpolated directly (needs matching point counts); selectors use morphTo
      var isPathData = typeof opts.to === 'string' && /^\s*[Mm]/.test(opts.to)
      opts.tl.add(target, {
        d: isPathData ? opts.to : anime.svg.morphTo(opts.to),
        duration: opts.duration || 1,
        ease: opts.ease || 'inOutCubic',
      }, opts.delay || 0)
    },

    // ── 7. scaleIn ────────────────────────────────────────────────────────────
    scaleIn: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return

      anime.set(targets, {
        scale: opts.from != null ? opts.from : 0,
        opacity: 0,
        transformOrigin: opts.transformOrigin || '50% 50%',
      })
      opts.tl.add(targets, {
        scale: 1, opacity: 1,
        duration: opts.duration || 0.6,
        delay: anime.stagger(opts.stagger || 0),
        ease: opts.ease || 'outBack(1.7)',
      }, opts.delay || 0)
    },

    // ── 8. slideIn ────────────────────────────────────────────────────────────
    slideIn: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl) return
      var from = opts.from || 'left'
      var dist = opts.distance || '100%'
      var unit = typeof dist === 'number' ? 0 : '0%'
      var startVars = { opacity: 0 }

      if (from === 'left') startVars.x = typeof dist === 'number' ? -dist : '-' + dist
      else if (from === 'right') startVars.x = dist
      else if (from === 'top') startVars.y = typeof dist === 'number' ? -dist : '-' + dist
      else if (from === 'bottom') startVars.y = dist

      anime.set(target, startVars)
      var toVars = {
        opacity: 1,
        duration: opts.duration || 0.8,
        ease: opts.ease || 'outQuart',
      }
      if (startVars.x != null) toVars.x = unit
      if (startVars.y != null) toVars.y = unit
      opts.tl.add(target, toVars, opts.delay || 0)
    },

    // ── 9. progressBar ────────────────────────────────────────────────────────
    progressBar: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl) return
      var to = opts.to != null ? opts.to : 100

      anime.set(target, { scaleX: 0, transformOrigin: '0% 50%' })
      if (opts.color) anime.set(target, { backgroundColor: opts.color })

      opts.tl.add(target, {
        scaleX: to / 100,
        duration: opts.duration || 1,
        ease: opts.ease || 'outCubic',
      }, opts.delay || 0)
    },

    // ── 10. highlightReveal ───────────────────────────────────────────────────
    /**
     * @param {string} opts.style — 'underline'|'background'|'box'
     * @param {string} opts.color — highlight color
     */
    highlightReveal: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl) return

      var hlStyle = opts.style || 'background'
      var color = opts.color || '#FFE066'

      // Ensure target is positioned for the highlight
      var computed = getComputedStyle(target)
      if (computed.position === 'static') target.style.position = 'relative'
      if (computed.display === 'inline') target.style.display = 'inline-block'

      var highlight = document.createElement('span')
      highlight.setAttribute('aria-hidden', 'true')

      if (hlStyle === 'underline') {
        highlight.style.cssText =
          'position:absolute;bottom:0;left:0;right:0;height:4px;background:' + color +
          ';transform-origin:left;pointer-events:none;'
      } else if (hlStyle === 'box') {
        highlight.style.cssText =
          'position:absolute;inset:-4px -6px;border:3px solid ' + color +
          ';border-radius:4px;transform-origin:left;pointer-events:none;'
      } else {
        // background (default)
        highlight.style.cssText =
          'position:absolute;inset:0;z-index:-1;background:' + color +
          ';opacity:0.35;transform-origin:left;pointer-events:none;border-radius:3px;'
      }

      target.appendChild(highlight)
      anime.set(highlight, { scaleX: 0 })

      opts.tl.add(highlight, {
        scaleX: 1,
        duration: opts.duration || 0.6,
        ease: opts.ease || 'inOutCubic',
      }, opts.delay || 0)
    },

    // ── 11. floatIn ───────────────────────────────────────────────────────────
    floatIn: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return
      var dir = opts.direction || 'up'
      var dist = opts.distance || 60
      var startVars = { opacity: 0 }

      if (dir === 'up') startVars.y = dist
      else if (dir === 'down') startVars.y = -dist
      else if (dir === 'left') startVars.x = -dist
      else if (dir === 'right') startVars.x = dist

      anime.set(targets, startVars)
      opts.tl.add(targets, {
        x: 0, y: 0, opacity: 1,
        duration: opts.duration || 1,
        delay: anime.stagger(opts.stagger || 0),
        ease: opts.ease || 'outBack(1.4)',
      }, opts.delay || 0)
    },

    // ── 12. pathFollow ────────────────────────────────────────────────────────
    pathFollow: function (selector, opts) {
      opts = opts || {}
      var target = el(selector)
      if (!target || !opts.tl || !opts.path) return

      var motion = anime.svg.createMotionPath(opts.path)
      var autoRotate = opts.align != null ? opts.align : (opts.autoRotate != null ? opts.autoRotate : true)
      if (!autoRotate) delete motion.rotate

      // Center the element on the path (element's own box, independent of the transform)
      if (target instanceof SVGElement) target.style.transformBox = 'fill-box'
      anime.set(target, { transformOrigin: '50% 50%' })
      target.style.translate = '-50% -50%'

      var params = {
        duration: opts.duration || 2,
        ease: opts.ease || 'inOutQuad',
      }
      for (var k in motion) params[k] = motion[k]
      opts.tl.add(target, params, opts.delay || 0)
    },

    // ── 13. flipReveal ────────────────────────────────────────────────────────
    flipReveal: function (selector, opts) {
      opts = opts || {}
      var targets = els(selector)
      if (!targets.length || !opts.tl) return
      var axis = (opts.axis || 'Y').toUpperCase()
      var prop = axis === 'X' ? 'rotateX' : 'rotateY'
      var setVars = { perspective: 800, opacity: 0 }
      setVars[prop] = -90

      anime.set(targets, setVars)

      var toVars = {
        opacity: 1,
        duration: opts.duration || 0.8,
        delay: anime.stagger(opts.stagger || 0),
        ease: opts.ease || 'outQuart',
      }
      toVars[prop] = 0

      opts.tl.add(targets, toVars, opts.delay || 0)
    },

    // ── 14. lottieSync ────────────────────────────────────────────────────────
    /**
     * Loads a Lottie animation and syncs it to the timeline via a proxy tween.
     * Seeking works because the timeline fires onUpdate at any seeked time,
     * which calls anim.goToAndStop(frame, true) — perfect frame accuracy.
     *
     * @param {string|Element} selector — container element
     * @param {Object} opts
     * @param {string} opts.src — lottie.host URL (or any JSON URL)
     * @param {Object} [opts.animationData] — inline Lottie JSON (alternative to src)
     * @param {Timeline} opts.tl — anime.js timeline to add to
     * @param {number} [opts.delay=0]
     * @param {number} [opts.duration] — playback duration (default: Lottie's natural duration)
     * @param {string} [opts.renderer='svg']
     */
    lottieSync: function (selector, opts) {
      opts = opts || {}
      var container = el(selector)
      if (!container || !opts.tl) return
      if (typeof lottie === 'undefined') {
        console.warn('[DreambyteMotion] lottie-web not loaded — lottieSync skipped')
        return
      }

      var animConfig = {
        container: container,
        renderer: opts.renderer || 'svg',
        loop: false,
        autoplay: false,
      }
      if (opts.src) animConfig.path = opts.src
      else if (opts.animationData) animConfig.animationData = opts.animationData
      else return

      var anim = lottie.loadAnimation(animConfig)
      var delay = opts.delay || 0
      var tl = opts.tl
      var estDuration = opts.duration || (typeof DURATION !== 'undefined' ? DURATION : 8)

      // Drive Lottie via a normalized progress proxy (0→1).
      // The tween is placed on the timeline immediately so the controller sees
      // the correct time slot even before the Lottie JSON finishes loading.
      // Once DOMLoaded fires we store totalFrames and onUpdate starts
      // calling goToAndStop with the real frame number.
      var state = { progress: 0, totalFrames: 0, loaded: false }
      tl.add(state, {
        progress: [0, 1],
        duration: estDuration,
        ease: 'linear',
        onUpdate: function () {
          if (state.loaded) {
            anim.goToAndStop(state.progress * (state.totalFrames - 1), true)
          }
        },
      }, delay)

      anim.addEventListener('DOMLoaded', function () {
        state.totalFrames = anim.totalFrames || 1
        state.loaded = true
        anim.goToAndStop(0, true)
      })
    },
  }

  // ── Easing Presets ─────────────────────────────────────────────────────────
  // Named easing presets as anime.js ease strings. Generated scene code can
  // reference DreambyteMotion.easing.entrance.premium instead of magic strings.

  DreambyteMotion.easing = {
    entrance: {
      playful:    'outBack(1.4)',
      premium:    'outQuart',
      corporate:  'inOutCubic',
      energetic:  'outBack(2)',
    },
    exit: {
      playful:    'inBack(1.4)',
      premium:    'inCubic',
      corporate:  'inCubic',
      energetic:  'inQuart',
    },
    emphasis: {
      playful:    'outBack(1.7)',
      premium:    'outExpo',
      corporate:  'outExpo',
      energetic:  'outBack(2.5)',
    },
    ambient: {
      playful:    'inOutSine',
      premium:    'inOutSine',
      corporate:  'inOutSine',
      energetic:  'inOutSine',
    },
    // Standard curves as CSS cubic-bezier strings (for CSS transitions; in anime use
    // anime.cubicBezier(...) with the same numbers)
    css: {
      dreambyteEntrance: 'cubic-bezier(0.16, 1, 0.3, 1)',
      dreambyteExit:     'cubic-bezier(0.7, 0, 0.84, 0)',
      md3Standard:   'cubic-bezier(0.2, 0, 0, 1)',
      md3Emphasized: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
      apple:         'cubic-bezier(0.28, 0, 0.1, 1)',
    },
  }

  global.DreambyteMotion = DreambyteMotion
})(typeof window !== 'undefined' ? window : globalThis)
