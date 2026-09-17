/**
 * DreambyteReact Runtime — frame-based React API for Dreambyte scenes.
 *
 * Provides: DreambyteComposition, useCurrentFrame, useVideoConfig,
 *           interpolate, spring, Sequence, AbsoluteFill
 *
 * Exposed on window.DreambyteReact (IIFE, no module bundler needed).
 * Requires React 18+ and the scene runtime (window.__dreambyte.onTick) to be loaded first.
 */
;(function () {
  'use strict'

  var React = window.React
  if (!React) throw new Error('DreambyteReact: React 18+ must be loaded before dreambyte-react-runtime.js')

  // ── Context ──────────────────────────────────────────────────────────────

  var FrameContext = React.createContext({ frame: 0, fps: 30, width: 1920, height: 1080, durationInFrames: 240 })

  function useCurrentFrame() {
    return React.useContext(FrameContext).frame
  }

  function useVideoConfig() {
    var ctx = React.useContext(FrameContext)
    return { fps: ctx.fps, width: ctx.width, height: ctx.height, durationInFrames: ctx.durationInFrames }
  }

  // ── DreambyteComposition ─────────────────────────────────────────────────────

  function DreambyteComposition(props) {
    var fps = props.fps || 30
    var width = props.width || 1920
    var height = props.height || 1080
    var durationInFrames = props.durationInFrames || Math.round((window.DURATION || 8) * fps)

    var frameRef = React.useRef(0)
    var _a = React.useState(0), frame = _a[0], setFrame = _a[1]

    React.useEffect(function () {
      function updateFrame(f) {
        if (f !== frameRef.current) {
          frameRef.current = f
          setFrame(f)
        }
      }

      // Bridge from the scene clock (every rendered frame: play, seek, export) -> React frame
      var offTick = null
      function hookTimeline() {
        var db = window.__dreambyte
        if (!db || typeof db.onTick !== 'function') return false
        offTick = db.onTick(function (t) { updateFrame(Math.round(t * fps)) })
        return true
      }

      // Try immediately; if the runtime isn't ready yet, poll briefly
      var poll = null
      if (!hookTimeline()) {
        var attempts = 0
        poll = setInterval(function () {
          attempts++
          if (hookTimeline() || attempts > 50) { clearInterval(poll); poll = null }
        }, 50)
      }

      // Direct frame control for Puppeteer export
      window.__dreambyteSetFrame = function (f) { updateFrame(f) }

      // Also subscribe to the scrub registry so a PAUSED scrub always updates the
      // frame (same belt-and-braces useDreambyteTime uses).
      var offSeek = (window.__dreambyte && typeof window.__dreambyte.onSeek === 'function')
        ? window.__dreambyte.onSeek(function (t) { updateFrame(Math.round(t * fps)) })
        : null

      // Hook into __advanceFrame (virtual time export mode)
      var origAdvance = window.__advanceFrame
      window.__advanceFrame = function (ms) {
        if (origAdvance) origAdvance(ms)
        updateFrame(Math.round((ms / 1000) * fps))
      }

      return function () {
        delete window.__dreambyteSetFrame
        if (origAdvance) window.__advanceFrame = origAdvance
        if (offSeek) try { offSeek() } catch (e) {}
        if (poll) clearInterval(poll)
        if (offTick) try { offTick() } catch (e) {}
      }
    }, [fps])

    var ctx = React.useMemo(function () {
      return { frame: frame, fps: fps, width: width, height: height, durationInFrames: durationInFrames }
    }, [frame, fps, width, height, durationInFrames])

    return React.createElement(FrameContext.Provider, { value: ctx }, props.children)
  }

  // ── interpolate ──────────────────────────────────────────────────────────

  function interpolate(value, inputRange, outputRange, options) {
    if (inputRange.length !== outputRange.length) {
      throw new Error('interpolate: inputRange and outputRange must have the same length')
    }
    if (inputRange.length < 2) {
      throw new Error('interpolate: ranges must have at least 2 values')
    }

    var opts = options || {}
    var extrapolateLeft = opts.extrapolateLeft || 'clamp'
    var extrapolateRight = opts.extrapolateRight || 'clamp'
    var easing = opts.easing || function (t) { return t }

    // Find the correct segment
    var segIdx = inputRange.length - 2 // default to last segment
    for (var i = 1; i < inputRange.length; i++) {
      if (value <= inputRange[i]) { segIdx = i - 1; break }
    }

    var inMin = inputRange[segIdx]
    var inMax = inputRange[segIdx + 1]
    var outMin = outputRange[segIdx]
    var outMax = outputRange[segIdx + 1]

    // Normalize to 0-1 (guard against identical input values)
    var t = inMax === inMin ? 1 : (value - inMin) / (inMax - inMin)

    // Clamping
    if (t < 0) t = extrapolateLeft === 'clamp' ? 0 : t
    if (t > 1) t = extrapolateRight === 'clamp' ? 1 : t

    // Apply easing only within 0-1 range
    var easedT = (t >= 0 && t <= 1) ? easing(t) : t

    return outMin + (outMax - outMin) * easedT
  }

  // ── spring ───────────────────────────────────────────────────────────────

  // The 0→1 spring progress at time t seconds (the physics only). Extracted so
  // spring() and measureSpring() share ONE implementation.
  function springProgress(t, damping, mass, stiffness, overshootClamping) {
    if (t <= 0) return 0
    var omega0 = Math.sqrt(stiffness / mass)
    var zeta = damping / (2 * Math.sqrt(stiffness * mass))

    var value
    if (zeta < 1 - 1e-8) {
      // Underdamped (with epsilon guard against floating-point edge)
      var omega1 = omega0 * Math.sqrt(1 - zeta * zeta)
      value = 1 - Math.exp(-zeta * omega0 * t) * (
        Math.cos(omega1 * t) + (zeta * omega0 / omega1) * Math.sin(omega1 * t)
      )
    } else if (zeta < 1 + 1e-8) {
      // Critically damped (covers floating-point zone around zeta=1)
      value = 1 - Math.exp(-omega0 * t) * (1 + omega0 * t)
    } else {
      // Overdamped
      var disc = Math.sqrt(zeta * zeta - 1)
      var s1 = -omega0 * (zeta - disc)
      var s2 = -omega0 * (zeta + disc)
      var denom = s2 - s1
      if (Math.abs(denom) < 1e-10) {
        value = 1 - Math.exp(-omega0 * t) * (1 + omega0 * t)
      } else {
        value = 1 - (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / denom
      }
    }

    if (overshootClamping) value = Math.min(Math.max(value, 0), 1)
    return value
  }

  function springConfig(config) {
    return {
      damping: config.damping !== undefined ? config.damping : 10,
      mass: config.mass !== undefined ? config.mass : 1,
      stiffness: config.stiffness !== undefined ? config.stiffness : 100,
      overshootClamping: config.overshootClamping || false,
    }
  }

  // The frame at which the spring has settled within `threshold` of its rest
  // value. Lets scenes time downstream events to when a spring stops moving, and
  // powers spring({durationInFrames}) below. Scans up to 20s then gives up.
  function measureSpring(opts) {
    opts = opts || {}
    var fps = opts.fps || 30
    var c = springConfig(opts.config || {})
    var threshold = opts.threshold !== undefined ? opts.threshold : 0.005
    var cap = Math.ceil(fps * 20)
    for (var f = 1; f <= cap; f++) {
      if (Math.abs(1 - springProgress(f / fps, c.damping, c.mass, c.stiffness, c.overshootClamping)) < threshold) {
        return f
      }
    }
    return cap
  }

  function spring(params) {
    var frame = params.frame
    var fps = params.fps || 30
    var from = params.from !== undefined ? params.from : 0
    var to = params.to !== undefined ? params.to : 1
    var c = springConfig(params.config || {})
    var delay = params.delay || 0
    var reverse = params.reverse || false

    var f = frame - delay
    // Before the (delayed) start: at rest. reverse rests at `to`, forward at `from`.
    if (f < 0) return reverse ? to : from

    // durationInFrames rescales the time axis so the spring settles in EXACTLY N
    // frames — the agent says "pop in over 12 frames" instead of guessing physics.
    var t
    if (params.durationInFrames) {
      var natural = measureSpring({ fps: fps, config: params.config, threshold: params.durationRestThreshold })
      t = (f * (natural / params.durationInFrames)) / fps
    } else {
      t = f / fps
    }

    var value = springProgress(t, c.damping, c.mass, c.stiffness, c.overshootClamping)
    if (reverse) value = 1 - value
    return from + (to - from) * value
  }

  // ── Sequence ─────────────────────────────────────────────────────────────

  function Sequence(props) {
    var parentFrame = useCurrentFrame()
    var parentConfig = useVideoConfig()

    var from = Math.max(0, props.from || 0) // No negative from
    var durationInFrames = props.durationInFrames || Infinity

    var localFrame = parentFrame - from
    if (localFrame < 0 || (durationInFrames !== Infinity && localFrame >= durationInFrames)) return null

    var localCtx = {
      frame: localFrame,
      fps: parentConfig.fps,
      width: parentConfig.width,
      height: parentConfig.height,
      durationInFrames: durationInFrames === Infinity ? parentConfig.durationInFrames - from : durationInFrames,
    }

    return React.createElement(
      FrameContext.Provider,
      { value: localCtx },
      props.children
    )
  }

  // ── AbsoluteFill ─────────────────────────────────────────────────────────

  function AbsoluteFill(props) {
    var baseStyle = {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
    }

    var mergedStyle = props.style ? Object.assign({}, baseStyle, props.style) : baseStyle

    return React.createElement(
      'div',
      { style: mergedStyle, className: props.className || '' },
      props.children
    )
  }

  // ── Easing helpers ───────────────────────────────────────────────────────

  function _bounce(t) {
    if (t < 1 / 2.75) return 7.5625 * t * t
    if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75 }
    if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375 }
    t -= 2.625 / 2.75
    return 7.5625 * t * t + 0.984375
  }
  // Full Remotion-compatible Easing surface. The model reaches for the standard
  // Remotion API (Easing.out(Easing.cubic), Easing.elastic(), Easing.bounce, …);
  // a missing member throws "Easing.X is not a function" at runtime and the whole
  // scene renders broken (no animation). Existing keys kept for back-compat.
  var Easing = {
    linear: function (t) { return t },
    ease: function (t) { return t * t * (3 - 2 * t) }, // legacy smoothstep (kept)
    easeIn: function (t) { return t * t },
    easeOut: function (t) { return t * (2 - t) },
    easeInOut: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t },
    quad: function (t) { return t * t },
    cubic: function (t) { return t * t * t },
    poly: function (n) { return function (t) { return Math.pow(t, n) } },
    sin: function (t) { return 1 - Math.cos((t * Math.PI) / 2) },
    circle: function (t) { return 1 - Math.sqrt(1 - t * t) },
    exp: function (t) { return Math.pow(2, 10 * (t - 1)) },
    elastic: function (bounciness) {
      var p = (bounciness === undefined ? 1 : bounciness) * Math.PI
      return function (t) { return 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p) }
    },
    back: function (s) {
      var v = s === undefined ? 1.70158 : s
      return function (t) { return t * t * ((v + 1) * t - v) }
    },
    bounce: function (t) { return _bounce(t) },
    step0: function (t) { return t > 0 ? 1 : 0 },
    step1: function (t) { return t >= 1 ? 1 : 0 },
    // Composers — take an easing fn, return an eased-in / -out / -in-out variant.
    in: function (easing) { return easing },
    out: function (easing) { return function (t) { return 1 - easing(1 - t) } },
    inOut: function (easing) {
      return function (t) { return t < 0.5 ? easing(t * 2) / 2 : 1 - easing((1 - t) * 2) / 2 }
    },
    bezier: function (x1, y1, x2, y2) {
      return function (t) {
        // Clamp t for bezier (only valid in 0-1)
        var ct = Math.max(0, Math.min(1, t))
        var lo = 0, hi = 1, mid
        for (var i = 0; i < 20; i++) {
          mid = (lo + hi) / 2
          var x = 3 * (1 - mid) * (1 - mid) * mid * x1 + 3 * (1 - mid) * mid * mid * x2 + mid * mid * mid
          if (x < ct) lo = mid; else hi = mid
        }
        return 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid
      }
    },
  }

  // ── Spring config presets ─────────────────────────────────────────────────

  spring.config = {
    default: { damping: 10, mass: 1, stiffness: 100 },
    gentle: { damping: 15, mass: 1, stiffness: 80 },
    wobbly: { damping: 8, mass: 1, stiffness: 120 },
    stiff: { damping: 20, mass: 1, stiffness: 200 },
    molasses: { damping: 25, mass: 1, stiffness: 60 },
    snappy: { damping: 12, mass: 0.8, stiffness: 160 },
  }

  // ── Variable Context ──────────────────────────────────────────────────────

  var VariableContext = React.createContext({})

  // ── useVariable ──────────────────────────────────────────────────────────
  // Reactive state synced with parent via postMessage.
  // Usage: var [count, setCount] = useVariable('count', 0)

  function useVariable(name, defaultValue) {
    var initial = (window.__DREAMBYTE_VARIABLES && window.__DREAMBYTE_VARIABLES[name] !== undefined)
      ? window.__DREAMBYTE_VARIABLES[name]
      : defaultValue
    var _s = React.useState(initial), value = _s[0], _setValue = _s[1]

    // Listen for parent pushing variable updates
    React.useEffect(function () {
      function onChanged(e) {
        if (e.detail && e.detail.name === name) {
          _setValue(e.detail.value)
        }
      }
      window.addEventListener('dreambyte:variable-changed', onChanged)
      return function () { window.removeEventListener('dreambyte:variable-changed', onChanged) }
    }, [name])

    var setValue = React.useCallback(function (newValue) {
      // Resolve function updaters
      var resolved = typeof newValue === 'function' ? newValue(value) : newValue
      _setValue(resolved)
      // Persist to global store
      if (!window.__DREAMBYTE_VARIABLES) window.__DREAMBYTE_VARIABLES = {}
      window.__DREAMBYTE_VARIABLES[name] = resolved
      // Notify parent
      if (window.__dreambytePostToParent) {
        window.__dreambytePostToParent({ type: 'variable_changed', name: name, value: resolved })
      }
    }, [name, value])

    return [value, setValue]
  }

  // ── useInteraction ───────────────────────────────────────────────────────
  // Returns event handler props for interactive elements.
  // Usage: var btn = useInteraction('my-button')
  //        <div {...btn.handlers} style={{ opacity: btn.isHovered ? 1 : 0.7 }}>

  function useInteraction(elementId) {
    var _h = React.useState(false), isHovered = _h[0], setHovered = _h[1]
    var _c = React.useState(false), isClicked = _c[0], setClicked = _c[1]

    var notify = React.useCallback(function (type, data) {
      if (window.__dreambytePostToParent) {
        window.__dreambytePostToParent({ type: type, elementId: elementId, data: data || {} })
      }
    }, [elementId])

    var handlers = React.useMemo(function () {
      return {
        onClick: function (e) {
          setClicked(true)
          notify('element_clicked', { x: e?.clientX, y: e?.clientY })
          // Reset click state after animation
          setTimeout(function () { setClicked(false) }, 300)
        },
        onMouseEnter: function () {
          setHovered(true)
          notify('element_hovered', { hovered: true })
        },
        onMouseLeave: function () {
          setHovered(false)
          notify('element_hovered', { hovered: false })
        },
        onTouchStart: function () {
          setHovered(true)
        },
        onTouchEnd: function () {
          setHovered(false)
          setClicked(true)
          notify('element_clicked')
          setTimeout(function () { setClicked(false) }, 300)
        },
        style: { cursor: 'pointer' },
      }
    }, [notify])

    return {
      handlers: handlers,
      isHovered: isHovered,
      isClicked: isClicked,
      // Convenience: spread these directly on an element
      onClick: handlers.onClick,
      onMouseEnter: handlers.onMouseEnter,
      onMouseLeave: handlers.onMouseLeave,
      onTouchStart: handlers.onTouchStart,
      onTouchEnd: handlers.onTouchEnd,
    }
  }

  // ── useTrigger ───────────────────────────────────────────────────────────
  // Named events that cross the iframe boundary.
  // Usage: var details = useTrigger('show-details')
  //        details.fire({ itemId: 42 })
  //        details.onFired(function(payload) { ... })

  function useTrigger(name) {
    var callbackRef = React.useRef(null)

    // Listen for triggers from parent
    React.useEffect(function () {
      function onTrigger(e) {
        if (e.detail && e.detail.name === name && callbackRef.current) {
          callbackRef.current(e.detail.payload)
        }
      }
      window.addEventListener('dreambyte:trigger', onTrigger)
      return function () { window.removeEventListener('dreambyte:trigger', onTrigger) }
    }, [name])

    var fire = React.useCallback(function (payload) {
      if (window.__dreambytePostToParent) {
        window.__dreambytePostToParent({ type: 'interaction_event', name: name, payload: payload })
      }
    }, [name])

    var onFired = React.useCallback(function (cb) {
      callbackRef.current = cb
    }, [])

    return { fire: fire, onFired: onFired }
  }

  // ── useDreambyteSeek ─────────────────────────────────────────────────────────
  // Fires on every timeline seek/scrub with the target time in seconds.
  // Use this for React components that animate outside the master timeline
  // and need to reflect the scrubbed position.
  // Usage: useDreambyteSeek(function(t) { setPosition(t * 100) })

  function useDreambyteSeek(cb) {
    var cbRef = React.useRef(cb)
    React.useEffect(function () { cbRef.current = cb }, [cb])
    React.useEffect(function () {
      if (!window.__dreambyte || typeof window.__dreambyte.onSeek !== 'function') return
      var off = window.__dreambyte.onSeek(function (t) {
        if (cbRef.current) cbRef.current(t)
      })
      return off
    }, [])
  }

  // ── useDreambyteTime ─────────────────────────────────────────────────────────
  // Returns current scene time in seconds, kept in sync with playback AND scrub.
  // Subscribes to window.__dreambyte.onTick (fires on play ticks AND seeks) and
  // also to explicit seek events for safety.
  // Usage: var t = useDreambyteTime(); var x = interpolate(t, [0, 1, 2], [0, 50, 100])

  function useDreambyteTime() {
    var _s = React.useState(function () {
      return window.__dreambyte && typeof window.__dreambyte.time === 'function' ? window.__dreambyte.time() : 0
    })
    var time = _s[0]
    var setTime = _s[1]
    var timeRef = React.useRef(time)

    React.useEffect(function () {
      // `mounted` guards against a late tick/seek after unmount
      // (prevents "setState on unmounted component").
      var mounted = true
      function update(t) {
        if (!mounted) return
        if (t === timeRef.current) return
        timeRef.current = t
        setTime(t)
      }

      // Subscribe to the scene clock (covers play + seek)
      var offTick = null
      function hookTimeline() {
        var db = window.__dreambyte
        if (!db || typeof db.onTick !== 'function') return false
        offTick = db.onTick(update)
        return true
      }
      var pollId = null
      if (!hookTimeline()) {
        var attempts = 0
        pollId = setInterval(function () {
          attempts++
          if (hookTimeline() || attempts > 50) {
            clearInterval(pollId)
            pollId = null
          }
        }, 50)
      }

      // Also subscribe to the scrub registry
      var off = (window.__dreambyte && typeof window.__dreambyte.onSeek === 'function')
        ? window.__dreambyte.onSeek(update)
        : null

      return function () {
        mounted = false
        if (pollId) clearInterval(pollId)
        if (offTick) offTick()
        if (off) off()
      }
    }, [])

    return time
  }

  // ── Enhanced DreambyteComposition (wraps with VariableContext) ───────────────

  var _OriginalComposition = DreambyteComposition
  DreambyteComposition = function DreambyteCompositionWithVariables(props) {
    var varsRef = React.useRef(window.__DREAMBYTE_VARIABLES || {})
    return React.createElement(
      VariableContext.Provider,
      { value: varsRef.current },
      React.createElement(_OriginalComposition, props)
    )
  }

  // ── Export ────────────────────────────────────────────────────────────────

  // ── random ─────────────────────────────────────────────────────────────────
  // Deterministic [0,1) for a given seed — the seeded RNG scenes MUST use instead
  // of Math.random() (frame-stable across export). Same seed → same value.

  function hashString(str) {
    var h = 0
    for (var i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
    return h
  }

  function random(seed) {
    var s = typeof seed === 'number' ? seed : hashString(String(seed === undefined || seed === null ? 'seed' : seed))
    var a = s >>> 0
    a = (a + 0x6d2b79f5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // ── interpolateColors ────────────────────────────────────────────────────────
  // Like interpolate() but outputRange is an array of CSS colors → returns an
  // rgba() string. Correct channel-wise color transitions (vs hand-lerping hex).

  function parseColor(c) {
    if (typeof c !== 'string') return [0, 0, 0, 1]
    c = c.trim()
    if (c[0] === '#') {
      var hex = c.slice(1)
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
      if (hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
      var n = parseInt(hex.slice(0, 6), 16)
      var a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
    }
    var m = c.match(/rgba?\(([^)]+)\)/)
    if (m) {
      var p = m[1].split(',').map(function (x) { return parseFloat(x) })
      return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] === undefined ? 1 : p[3]]
    }
    return [0, 0, 0, 1]
  }

  function interpolateColors(value, inputRange, outputRange) {
    var cols = outputRange.map(parseColor)
    var r = interpolate(value, inputRange, cols.map(function (c) { return c[0] }))
    var g = interpolate(value, inputRange, cols.map(function (c) { return c[1] }))
    var b = interpolate(value, inputRange, cols.map(function (c) { return c[2] }))
    var a = interpolate(value, inputRange, cols.map(function (c) { return c[3] }))
    return 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + a + ')'
  }

  // ── Series ───────────────────────────────────────────────────────────────────
  // Sequential beats with NO manual `from=` frame math. Each <Series.Sequence
  // durationInFrames={n} offset={m}> starts where the previous ended (+offset,
  // negative overlaps). Kills the #1 timing-arithmetic bug in chained Sequences.

  function SeriesSequence() { return null } // marker only — laid out by Series

  function Series(props) {
    var kids = React.Children.toArray(props.children)
    var cursor = 0
    var out = []
    kids.forEach(function (child, i) {
      if (!child || !child.props) return
      cursor += child.props.offset || 0
      var dur = child.props.durationInFrames
      out.push(React.createElement(Sequence, { from: cursor, durationInFrames: dur, key: i }, child.props.children))
      if (dur && dur !== Infinity) cursor += dur
    })
    return React.createElement(React.Fragment, null, out)
  }
  Series.Sequence = SeriesSequence

  // ── Loop ─────────────────────────────────────────────────────────────────────

  function Loop(props) {
    var frame = useCurrentFrame()
    var cfg = useVideoConfig()
    var dur = props.durationInFrames
    if (!dur || dur <= 0) return props.children
    var times = props.times === undefined ? Infinity : props.times
    var iteration = Math.floor(frame / dur)
    if (iteration >= times) return null
    var localCtx = {
      frame: frame - iteration * dur,
      fps: cfg.fps, width: cfg.width, height: cfg.height, durationInFrames: dur,
    }
    return React.createElement(FrameContext.Provider, { value: localCtx }, props.children)
  }

  // ── Freeze ───────────────────────────────────────────────────────────────────

  function Freeze(props) {
    var cfg = useVideoConfig()
    var localCtx = {
      frame: props.frame || 0,
      fps: cfg.fps, width: cfg.width, height: cfg.height, durationInFrames: cfg.durationInFrames,
    }
    return React.createElement(FrameContext.Provider, { value: localCtx }, props.children)
  }

  // ── measureText / fitText ─────────────────────────────────────────────────────
  // Text auto-fit — kills the #1 slop defect (headlines overflowing/clipping the
  // frame). measureText returns the rendered box; fitText returns the font size
  // that makes text fill a width. Measured in a detached span in the SCENE document
  // (natural scene px; the host scales the whole scene, not this element).

  var __measureEl = null
  function measureText(o) {
    o = o || {}
    if (!__measureEl) {
      __measureEl = document.createElement('span')
      var s = __measureEl.style
      s.position = 'absolute'; s.visibility = 'hidden'; s.whiteSpace = 'nowrap'
      s.top = '-9999px'; s.left = '-9999px'; s.pointerEvents = 'none'
      document.body.appendChild(__measureEl)
    }
    var st = __measureEl.style
    st.fontFamily = o.fontFamily || 'sans-serif'
    st.fontSize = (o.fontSize || 16) + 'px'
    st.fontWeight = o.fontWeight === undefined ? 'normal' : o.fontWeight
    st.fontStyle = o.fontStyle || 'normal'
    st.letterSpacing = o.letterSpacing === undefined ? 'normal'
      : (typeof o.letterSpacing === 'number' ? o.letterSpacing + 'px' : o.letterSpacing)
    st.textTransform = o.textTransform || 'none'
    __measureEl.textContent = o.text || ''
    var r = __measureEl.getBoundingClientRect()
    return { width: r.width, height: r.height }
  }

  function fitText(o) {
    o = o || {}
    var within = o.withinWidth || 100
    var ref = 100 // width scales ~linearly with font-size, so one measure suffices
    var w = measureText({
      text: o.text, fontFamily: o.fontFamily, fontSize: ref, fontWeight: o.fontWeight,
      letterSpacing: o.letterSpacing, textTransform: o.textTransform,
    }).width
    var size = w > 0 ? (within * ref) / w : ref
    if (o.fontSizeLimit !== undefined) size = Math.min(size, o.fontSizeLimit)
    return { fontSize: size }
  }

  window.DreambyteReact = {
    DreambyteComposition: DreambyteComposition,
    useCurrentFrame: useCurrentFrame,
    useVideoConfig: useVideoConfig,
    interpolate: interpolate,
    interpolateColors: interpolateColors,
    spring: spring,
    measureSpring: measureSpring,
    random: random,
    Sequence: Sequence,
    Series: Series,
    Loop: Loop,
    Freeze: Freeze,
    AbsoluteFill: AbsoluteFill,
    Easing: Easing,
    measureText: measureText,
    fitText: fitText,
    // Interactivity hooks
    useVariable: useVariable,
    useInteraction: useInteraction,
    useTrigger: useTrigger,
    // Scrub hooks
    useDreambyteSeek: useDreambyteSeek,
    useDreambyteTime: useDreambyteTime,
    // Internal contexts
    _FrameContext: FrameContext,
    _VariableContext: VariableContext,
  }
})()
