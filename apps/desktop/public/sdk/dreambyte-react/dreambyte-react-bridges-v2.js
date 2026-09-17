/**
 * DreambyteReact Bridge Components — wrap imperative renderers in React components.
 *
 * Provides: Canvas2DLayer, ThreeJSLayer, D3Layer, SVGLayer, LottieLayer
 *
 * Each bridge uses useCurrentFrame() to drive per-frame updates via refs,
 * avoiding React re-renders for the heavy imperative work.
 *
 * Requires dreambyte-react-runtime.js to be loaded first.
 */
;(function () {
  'use strict'

  // Load-time sentinel — if the fresh bridge ran, this prints once per load.
  // Absence of this log in console means the browser is serving a cached
  // older bridge despite any ?v= busts in the script tag.
  console.log('[dreambyte-bridges] loaded v2-seek-aware', new Date().toISOString())

  var React = window.React
  var CR = window.DreambyteReact
  if (!CR) throw new Error('DreambyteReact bridges: dreambyte-react-runtime.js must be loaded first')

  var useCurrentFrame = CR.useCurrentFrame
  var useVideoConfig = CR.useVideoConfig

  // ── Canvas2DLayer ────────────────────────────────────────────────────────

  var Canvas2DLayer = React.memo(function Canvas2DLayer(props) {
    var canvasRef = React.useRef(null)
    var drawRef = React.useRef(props.draw)
    drawRef.current = props.draw

    var frame = useCurrentFrame()
    var config = useVideoConfig()
    var w = props.width || config.width
    var h = props.height || config.height

    React.useEffect(
      function () {
        var canvas = canvasRef.current
        if (!canvas) return
        var ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.clearRect(0, 0, w, h)
        ctx.save()
        try {
          if (drawRef.current) {
            drawRef.current(ctx, frame, {
              width: w,
              height: h,
              fps: config.fps,
              PALETTE: window.PALETTE,
              FONT: window.FONT,
              DURATION: window.DURATION,
            })
          }
        } catch (e) {
          console.error('Canvas2DLayer draw error:', e)
        } finally {
          ctx.restore()
        }
      },
      [frame, w, h, config.fps],
    )

    return React.createElement('canvas', {
      ref: canvasRef,
      width: w,
      height: h,
      style: Object.assign({ display: 'block', width: '100%', height: '100%' }, props.style || {}),
    })
  })

  // ── ThreeJSLayer ─────────────────────────────────────────────────────────

  var ThreeJSLayer = React.memo(function ThreeJSLayer(props) {
    var containerRef = React.useRef(null)
    var stateRef = React.useRef(null)
    var updateRef = React.useRef(props.update)
    updateRef.current = props.update
    // Track whether setup or update has thrown. A buggy scene that references
    // a missing variable (`cube.position.x = ...` with cube undefined; or
    // `new Color(...)` without destructuring THREE) throws on every frame;
    // logging on each throw turns the console into a firehose and eats the
    // interesting errors. Log once per mount; suppress the rest.
    var updateFailedRef = React.useRef(false)

    var frame = useCurrentFrame()
    var config = useVideoConfig()

    React.useEffect(function () {
      var THREE = window.THREE
      if (!THREE || !containerRef.current) {
        if (!THREE) console.warn('ThreeJSLayer: window.THREE not loaded')
        return
      }

      var w = config.width
      var h = config.height
      var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setSize(w, h)
      renderer.setPixelRatio(1)
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      containerRef.current.appendChild(renderer.domElement)

      var scene = new THREE.Scene()
      var camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000)
      camera.position.z = 5

      stateRef.current = { scene: scene, camera: camera, renderer: renderer }

      // Expose this ThreeJSLayer's camera/scene/renderer to DreambyteCamera helpers.
      // DreambyteCamera.orbit / dolly3D / rackFocus3D read window.__threeCamera
      // (see public/sdk/dreambyte-camera.js); without them callers get a silent
      // warn and no motion. Capturing the
      // previous values lets us restore them on unmount so the last-mounted
      // ThreeJSLayer doesn't leave globals pointing at a disposed renderer.
      var prevThreeCamera = window.__threeCamera
      var prevThreeScene = window.__threeScene
      var prevThreeRenderer = window.__threeRenderer
      window.__threeCamera = camera
      window.__threeScene = scene
      window.__threeRenderer = renderer

      if (props.setup) {
        try {
          // Support BOTH call styles:
          //   1. positional: setup={(THREE, scene, camera, renderer) => {...}} (canonical)
          //   2. destructured: setup={({ THREE, scene, camera, renderer }) => {...}}
          // LLMs occasionally write #2 by analogy with React props. Without
          // this shim, #2 makes `THREE` undefined inside setup, which throws
          // "Cannot read properties of undefined (reading 'AmbientLight')"
          // the moment the scene tries to construct anything. Function.length
          // is 1 when a single destructured param is declared, so we can
          // detect the intent and pass a compatible shape instead of failing.
          if (props.setup.length === 1) {
            props.setup({ THREE: THREE, scene: scene, camera: camera, renderer: renderer })
          } else {
            props.setup(THREE, scene, camera, renderer)
          }
        } catch (e) {
          // Scene author referenced something that doesn't exist (classic:
          // `new Color(...)` without destructuring THREE, or a typo'd mesh
          // name). Without this guard, the bridge would error again on the
          // very first update tick (missing variable still missing), then
          // again every frame. Dedupe up front: mark update as failed so the
          // render loop below never tries.
          updateFailedRef.current = true
          console.error('ThreeJSLayer setup error (further errors on this scene will be suppressed until remount):', e)
        }
      }

      return function () {
        // Dispose geometries, materials, AND textures to prevent GPU memory leaks
        var texKeys = [
          'map',
          'normalMap',
          'roughnessMap',
          'metalnessMap',
          'emissiveMap',
          'envMap',
          'aoMap',
          'bumpMap',
          'displacementMap',
          'lightMap',
          'alphaMap',
        ]
        if (stateRef.current && stateRef.current.scene) {
          stateRef.current.scene.traverse(function (obj) {
            if (obj.geometry) obj.geometry.dispose()
            if (obj.material) {
              var mats = Array.isArray(obj.material) ? obj.material : [obj.material]
              mats.forEach(function (m) {
                texKeys.forEach(function (key) {
                  if (m[key] && typeof m[key].dispose === 'function') m[key].dispose()
                })
                m.dispose()
              })
            }
          })
          // Dispose environment map if set on scene
          if (stateRef.current.scene.environment && typeof stateRef.current.scene.environment.dispose === 'function') {
            stateRef.current.scene.environment.dispose()
          }
        }
        renderer.dispose()
        if (renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement)
        }
        // Restore prior DreambyteCamera globals so the outer frame's camera
        // helpers don't keep pointing at a disposed renderer.
        if (window.__threeCamera === camera) window.__threeCamera = prevThreeCamera
        if (window.__threeScene === scene) window.__threeScene = prevThreeScene
        if (window.__threeRenderer === renderer) window.__threeRenderer = prevThreeRenderer
        stateRef.current = null
      }
    }, [])

    // Track the last rendered frame so we can compute delta-time for
    // AnimationMixer ticks. Scene authors who hand-roll a mixer and want it
    // ticked just set `obj.userData.mixer` and the bridge picks it up on its
    // scene.traverse below.
    var lastMixerFrameRef = React.useRef(-1)

    React.useEffect(
      function () {
        var s = stateRef.current
        if (!s) return
        if (!updateFailedRef.current) {
          try {
            if (updateRef.current) {
              var updateCfg = {
                fps: config.fps,
                width: config.width,
                height: config.height,
                PALETTE: window.PALETTE,
                DURATION: window.DURATION,
              }
              // Mirror the setup-style shim: accept destructured-object callers
              // whose signature is `({ scene, camera, frame, config }) => {...}`.
              // Function.length is 1 when a single destructured param is
              // declared, letting us tell the two shapes apart. Also expose
              // `time` (seconds) and `THREE` because agent-written scenes
              // commonly destructure those — without `time` they NaN out
              // (`time * x` propagates to rotation/position, gl_Position is
              // NaN, the whole scene goes black).
              if (updateRef.current.length === 1) {
                updateRef.current({
                  THREE: window.THREE,
                  scene: s.scene,
                  camera: s.camera,
                  renderer: s.renderer,
                  frame: frame,
                  time: frame / (config.fps || 30),
                  config: updateCfg,
                })
              } else {
                updateRef.current(s.scene, s.camera, frame, updateCfg)
              }
            }
          } catch (e) {
            updateFailedRef.current = true
            console.error(
              'ThreeJSLayer update error (further errors on this scene will be suppressed until remount):',
              e,
            )
          }
        }
        // Tick every AnimationMixer attached via obj.userData.mixer. Two
        // modes, picked per-object:
        //
        //  1. Deterministic (preferred) — if userData.seek is a function, the
        //     bridge calls `userData.seek(frame / fps)`. The scene author owns
        //     the state machine (clip chaining, crossfades). This guarantees
        //     scrubbing backward, rewinding, and re-rendering produce the same
        //     pose as forward playback — critical for frame-perfect export.
        //
        //  2. Fallback delta — legacy path. Uses mixer.setTime(frame/fps) for
        //     single-action rigs so scrubbing works (was: delta-only which
        //     froze the mixer on any backward scrub via Math.max(0, …)).
        //     setTime rewinds all actions to the given absolute time, which
        //     is correct for a single-clip looping avatar but breaks chained
        //     crossfades — scenes with sequences should provide userData.seek.
        var fps = config.fps || 30
        var sceneTimeSec = frame / fps
        lastMixerFrameRef.current = frame
        s.scene.traverse(function (obj) {
          if (!obj || !obj.userData) return
          if (typeof obj.userData.seek === 'function') {
            try {
              obj.userData.seek(sceneTimeSec, frame)
            } catch (_e) {
              /* swallow per-object */
            }
            return
          }
          if (obj.userData.mixer && typeof obj.userData.mixer.setTime === 'function') {
            try {
              obj.userData.mixer.setTime(sceneTimeSec)
            } catch (_e) {
              /* swallow per-object */
            }
          }
        })
        // Always render — even if update threw, the last-good state is still
        // viewable, and the ReferenceError doesn't corrupt the scene graph.
        // If the scene setup attached an EffectComposer (for bloom / DoF /
        // etc via enableBloom / applyPostFX), use it instead of the plain
        // renderer so post-processing actually takes effect every frame.
        var composer = s.scene.userData && s.scene.userData.__dreambyteComposer
        if (composer && typeof composer.render === 'function') {
          composer.render()
        } else {
          s.renderer.render(s.scene, s.camera)
        }
      },
      [frame],
    )

    return React.createElement('div', {
      ref: containerRef,
      style: Object.assign(
        {
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        },
        props.style || {},
      ),
    })
  })

  // ── D3Layer ──────────────────────────────────────────────────────────────

  var D3Layer = React.memo(function D3Layer(props) {
    var containerRef = React.useRef(null)
    var setupRef = React.useRef(props.setup)
    var updateRef = React.useRef(props.update)
    setupRef.current = props.setup
    updateRef.current = props.update

    var frame = useCurrentFrame()
    var config = useVideoConfig()
    var initDone = React.useRef(false)

    React.useEffect(function () {
      var d3 = window.d3
      if (!d3) {
        console.warn('D3Layer: window.d3 not loaded — include D3 CDN in your scene')
        return
      }
      if (!containerRef.current) return
      if (!initDone.current && setupRef.current) {
        try {
          setupRef.current(d3, containerRef.current, {
            fps: config.fps,
            width: config.width,
            height: config.height,
            PALETTE: window.PALETTE,
            DURATION: window.DURATION,
            DATA: window.DATA,
          })
        } catch (e) {
          console.error('D3Layer setup error:', e)
        }
        initDone.current = true
      }

      return function () {
        initDone.current = false
      }
    }, [])

    React.useEffect(
      function () {
        var d3 = window.d3
        if (!d3 || !containerRef.current || !initDone.current) return
        if (updateRef.current) {
          try {
            updateRef.current(d3, containerRef.current, frame, {
              fps: config.fps,
              width: config.width,
              height: config.height,
              PALETTE: window.PALETTE,
              DURATION: window.DURATION,
              DATA: window.DATA,
            })
          } catch (e) {
            console.error('D3Layer update error:', e)
          }
        }
      },
      [frame],
    )

    return React.createElement('div', {
      ref: containerRef,
      style: Object.assign({ width: '100%', height: '100%' }, props.style || {}),
    })
  })

  // ── SVGLayer ─────────────────────────────────────────────────────────────

  var SVGLayer = React.memo(function SVGLayer(props) {
    var svgRef = React.useRef(null)
    var config = useVideoConfig()
    var initDone = React.useRef(false)

    React.useEffect(function () {
      if (!svgRef.current || initDone.current) return
      if (props.setup) {
        try {
          props.setup(svgRef.current, window.anime || null, window.__tl || null)
        } catch (e) {
          console.error('SVGLayer setup error:', e)
        }
        initDone.current = true
      }

      return function () {
        initDone.current = false
      }
    }, [])

    return React.createElement(
      'svg',
      {
        ref: svgRef,
        viewBox: props.viewBox || '0 0 ' + config.width + ' ' + config.height,
        xmlns: 'http://www.w3.org/2000/svg',
        style: Object.assign(
          {
            width: '100%',
            height: '100%',
            display: 'block',
          },
          props.style || {},
        ),
      },
      props.children,
    )
  })

  // ── LottieLayer ──────────────────────────────────────────────────────────

  var LottieLayer = React.memo(function LottieLayer(props) {
    var containerRef = React.useRef(null)
    var animRef = React.useRef(null)

    var frame = useCurrentFrame()
    var config = useVideoConfig()

    React.useEffect(
      function () {
        var lottie = window.lottie
        if (!lottie) {
          console.warn('LottieLayer: window.lottie not loaded — include lottie-web CDN')
          return
        }
        if (!containerRef.current || !props.data) return

        var animData
        try {
          animData = typeof props.data === 'string' ? JSON.parse(props.data) : props.data
        } catch (e) {
          console.error('LottieLayer: Invalid JSON data', e)
          return
        }

        animRef.current = lottie.loadAnimation({
          container: containerRef.current,
          renderer: props.renderer || 'svg',
          loop: false,
          autoplay: false,
          animationData: animData,
        })

        return function () {
          if (animRef.current) {
            animRef.current.destroy()
            animRef.current = null
          }
        }
      },
      [props.data],
    )

    React.useEffect(
      function () {
        if (!animRef.current) return
        var totalFrames = animRef.current.totalFrames
        var lottieFps = animRef.current.frameRate || 30
        var time = frame / config.fps
        var lottieFrame = Math.max(0, Math.min(time * lottieFps, totalFrames - 1))
        animRef.current.goToAndStop(lottieFrame, true)
      },
      [frame, config.fps],
    )

    return React.createElement('div', {
      ref: containerRef,
      style: Object.assign({ width: '100%', height: '100%' }, props.style || {}),
    })
  })

  // ── Export ────────────────────────────────────────────────────────────────

  Object.assign(window.DreambyteReact, {
    Canvas2DLayer: Canvas2DLayer,
    ThreeJSLayer: ThreeJSLayer,
    D3Layer: D3Layer,
    SVGLayer: SVGLayer,
    LottieLayer: LottieLayer,
  })
})()
