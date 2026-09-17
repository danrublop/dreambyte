/**
 * Built-in Canvas2D motion templates: scrub-friendly backgrounds and ambient loops.
 * Used by the avatar-showcase scenes and the QA/test scripts. The agent tool that
 * used to string-build these into a scene (`apply_canvas_motion_template`) was cut —
 * the model writes a starfield or a particle field directly through Canvas2DLayer.
 */

const ID_RE = /^[a-z0-9-]+$/

export interface CanvasMotionTemplateMeta {
  id: string
  name: string
  description: string
  tags: string[]
  /** Scene bgColor hint when applying (canvas clears to its own colors; this matches mood) */
  suggestedBgColor: string
}

export const CANVAS_MOTION_TEMPLATES: CanvasMotionTemplateMeta[] = [
  {
    id: 'particle-burst',
    name: 'Particle burst',
    description: 'Radial burst from center',
    tags: ['background', 'energy', 'dark'],
    suggestedBgColor: '#111827',
  },
  {
    id: 'starfield',
    name: 'Starfield',
    description: 'Hyperspace-style stars',
    tags: ['background', 'space', 'dark'],
    suggestedBgColor: '#020617',
  },
  {
    id: 'audio-visualizer',
    name: 'Audio visualizer',
    description: 'EQ-style bars',
    tags: ['background', 'music', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'fluid-wave',
    name: 'Fluid waves',
    description: 'Layered sine waves',
    tags: ['background', 'calm', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'fire-smoke',
    name: 'Fire & smoke',
    description: 'Rising embers and haze',
    tags: ['background', 'warm', 'dark'],
    suggestedBgColor: '#1f2937',
  },
  {
    id: 'rain-snow',
    name: 'Rain & snow',
    description: 'Mixed precipitation',
    tags: ['background', 'weather', 'dark'],
    suggestedBgColor: '#0b1020',
  },
  {
    id: 'bouncing-balls',
    name: 'Bouncing balls',
    description: 'Playful bouncing balls',
    tags: ['background', 'playful', 'dark'],
    suggestedBgColor: '#111827',
  },
  {
    id: 'cloth-flag',
    name: 'Pixel flag',
    description: 'Waving grid banner',
    tags: ['background', 'abstract', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'cursor-trails',
    name: 'Orbital trails',
    description: 'Swirling orbit particles',
    tags: ['background', 'motion', 'dark'],
    suggestedBgColor: '#020617',
  },
  {
    id: 'drawing-brush',
    name: 'Drawing brush',
    description: 'Animated stroke on light field',
    tags: ['background', 'minimal', 'light'],
    suggestedBgColor: '#f8fafc',
  },
  {
    id: 'pixel-sprite',
    name: 'Pixel sprite (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'sprite-sheet-runner',
    name: 'Sprite runner (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'bar-chart-race',
    name: 'Bar race (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'data', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'heatmap',
    name: 'Heatmap (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'data', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'network-graph',
    name: 'Network (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'timeline-scrub',
    name: 'Timeline (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'typewriter-glitch',
    name: 'Typewriter (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'morph-loader',
    name: 'Morph loader (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'minimap-radar',
    name: 'Radar (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'boids-flocking',
    name: 'Boids (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'image-reveal',
    name: 'Image reveal (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
  {
    id: 'frame-exporter',
    name: 'Frame export (demo)',
    description: 'Placeholder progress demo',
    tags: ['demo', 'dark'],
    suggestedBgColor: '#0f172a',
  },
]

/** Escape a template id for embedding in generated scene JavaScript as a single-quoted string literal */
function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export type CanvasAnimationLayout = 'fixed' | 'fill'

/**
 * Full canvas layer code: timeline-driven renderAt(t), window.draw for seek.
 * - `fixed`: CSS size matches 1920×1080 (Canvas2D-only scenes with scaled body).
 * - `fill`: CSS width/height 100% so the bitmap fills #scene-camera (motion/d3/svg backgrounds).
 */
export function buildCanvasAnimationCode(kind: string, opts?: { layout?: CanvasAnimationLayout }): string {
  if (!ID_RE.test(kind)) {
    throw new Error(`Invalid canvas motion template id: ${kind}`)
  }
  const q = escapeJsString(kind)
  const layout = opts?.layout ?? 'fixed'

  const canvasSetup =
    layout === 'fill'
      ? `canvas.style.position = 'absolute'
canvas.style.left = '0'; canvas.style.top = '0'
canvas.style.width = '100%'; canvas.style.height = '100%'
canvas.style.border = 'none'
canvas.style.margin = '0'; canvas.style.padding = '0'
const tex = document.getElementById('texture-canvas')
if (tex) {
  tex.width = W; tex.height = H
  tex.style.position = 'absolute'
  tex.style.left = '0'; tex.style.top = '0'
  tex.style.width = '100%'; tex.style.height = '100%'
  tex.style.margin = '0'; tex.style.padding = '0'
  tex.style.border = 'none'
}
const cam = document.getElementById('scene-camera')
if (cam) {
  cam.style.overflow = 'hidden'
  cam.style.width = '100%'
  cam.style.height = '100%'
}`
      : `canvas.style.position = 'absolute'
canvas.style.left = '0'; canvas.style.top = '0'
canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
canvas.style.border = 'none'
canvas.style.margin = '0'; canvas.style.padding = '0'
const tex = document.getElementById('texture-canvas')
if (tex) {
  tex.width = W; tex.height = H
  tex.style.position = 'absolute'
  tex.style.left = '0'; tex.style.top = '0'
  tex.style.width = W + 'px'; tex.style.height = H + 'px'
  tex.style.margin = '0'; tex.style.padding = '0'
  tex.style.border = 'none'
}
const cam = document.getElementById('scene-camera')
if (cam) { cam.style.overflow = 'hidden'; cam.style.width = W + 'px'; cam.style.height = H + 'px' }`

  return `
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')
const W = WIDTH || 1920
const H = HEIGHT || 1080
canvas.width = W; canvas.height = H
${canvasSetup}

const TAU = Math.PI * 2
function h(i) { return Math.abs(Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1 }
function clear(bg, a = 1) {
  ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); ctx.restore()
}

function renderAt(t) {
  switch ('${q}') {
    case 'particle-burst': {
      clear('#111827')
      for (let i = 0; i < 220; i++) {
        const ang = h(i) * TAU + t * (1 + h(i + 3) * 2)
        const r = (h(i + 7) * 640 + t * 220 * (0.4 + h(i + 5))) % 540
        const x = W * 0.5 + Math.cos(ang) * r
        const y = H * 0.5 + Math.sin(ang) * r * 0.6
        const life = 1 - r / 540
        ctx.globalAlpha = Math.max(0.08, life)
        ctx.fillStyle = life > 0.5 ? '#f59e0b' : '#ef4444'
        ctx.beginPath(); ctx.arc(x, y, 1.5 + h(i + 11) * 3, 0, TAU); ctx.fill()
      }
      break
    }
    case 'starfield': {
      clear('#020617')
      ctx.save(); ctx.translate(W * 0.5, H * 0.5)
      for (let i = 0; i < 400; i++) {
        const z = ((h(i + 2) + t * 0.08) % 1) * 1.3 + 0.08
        const x = ((h(i) - 0.5) * 2 * W) / z
        const y = ((h(i + 1) - 0.5) * 2 * H) / z
        ctx.fillStyle = '#dbeafe'
        // z runs to ~1.38, so (1.35 - z) goes slightly negative for the farthest
        // stars — and ctx.arc() throws IndexSizeError on a negative radius, which
        // crashes the whole frame in continuous playback. Clamp at 0 (far stars
        // shrink to invisible, which is the intent).
        ctx.beginPath(); ctx.arc(x, y, Math.max(0, (1.35 - z) * 2), 0, TAU); ctx.fill()
      }
      ctx.restore()
      break
    }
    case 'audio-visualizer': {
      clear('#0f172a')
      const bars = 96, bw = W / bars
      for (let i = 0; i < bars; i++) {
        const n = Math.sin(t * 3 + i * 0.23) * 0.5 + Math.sin(t * 6.5 + i * 0.09) * 0.5
        const hh = (Math.abs(n) * 0.8 + 0.2) * H * 0.55
        ctx.fillStyle = i % 3 === 0 ? '#22d3ee' : (i % 3 === 1 ? '#a78bfa' : '#34d399')
        ctx.fillRect(i * bw + 2, H - hh - 40, bw - 4, hh)
      }
      break
    }
    case 'fluid-wave': {
      clear('#0f172a')
      for (let k = 0; k < 4; k++) {
        ctx.beginPath()
        for (let x = 0; x <= W; x += 8) {
          const y = H * (0.25 + k * 0.16) + Math.sin(x * 0.01 + t * (1 + k * 0.4)) * (30 + k * 14)
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath()
        ctx.globalAlpha = 0.25 + k * 0.12
        ctx.fillStyle = ['#38bdf8', '#22d3ee', '#a78bfa', '#34d399'][k]
        ctx.fill()
      }
      ctx.globalAlpha = 1
      break
    }
    case 'fire-smoke': {
      clear('#1f2937')
      for (let i = 0; i < 180; i++) {
        const p = (h(i + 4) * 2 + t * (0.7 + h(i + 8))) % 1
        const x = W * 0.5 + (h(i + 1) - 0.5) * (100 + p * 280)
        const y = H * 0.84 - p * H * 0.7
        const r = 4 + (1 - p) * 16
        const g = ctx.createRadialGradient(x, y, 1, x, y, r)
        g.addColorStop(0, 'rgba(251,146,60,0.75)'); g.addColorStop(1, 'rgba(148,163,184,0)')
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill()
      }
      break
    }
    case 'rain-snow': {
      clear('#0b1020')
      for (let i = 0; i < 320; i++) {
        const x = h(i) * W
        const y = ((h(i + 2) * H * 2 + t * (380 + h(i + 7) * 420)) % (H + 80)) - 40
        const len = 8 + h(i + 5) * 14
        if (i % 3 === 0) { ctx.strokeStyle = 'rgba(125,211,252,0.7)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 8, y + len); ctx.stroke() }
        else { ctx.fillStyle = 'rgba(226,232,240,0.8)'; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill() }
      }
      break
    }
    case 'bouncing-balls': {
      clear('#111827')
      for (let i = 0; i < 18; i++) {
        const r = 18 + h(i + 9) * 24
        const x = r + ((h(i + 3) * 500 + t * (120 + h(i + 8) * 180)) % (W - 2 * r))
        const y = H - r - Math.abs(Math.sin(t * (1.3 + h(i + 4) * 0.7) + i * 0.6)) * (H * 0.7 - r)
        ctx.fillStyle = '#60a5fa'; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill()
      }
      break
    }
    case 'cloth-flag': {
      clear('#0f172a')
      const cols = 30, rows = 14, sx = 240, sy = 220, ww = 1320, hh = 460
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const u = x / (cols - 1), v = y / (rows - 1)
        const px = sx + u * ww
        const py = sy + v * hh + Math.sin(t * 3 + u * 8 + v * 5) * 16 * (u * 1.3)
        ctx.fillStyle = y % 2 ? '#38bdf8' : '#0ea5e9'; ctx.fillRect(px, py, 8, 8)
      }
      break
    }
    case 'cursor-trails': {
      clear('#020617')
      const mx = W * 0.5 + Math.cos(t * 0.9) * W * 0.25
      const my = H * 0.5 + Math.sin(t * 1.2) * H * 0.22
      for (let i = 0; i < 220; i++) {
        const a = (i / 220) * TAU + t * 1.6
        const rr = 90 + (i % 20) * 2
        const x = mx + Math.cos(a) * rr, y = my + Math.sin(a) * rr
        ctx.fillStyle = i % 2 ? '#22d3ee' : '#a78bfa'; ctx.beginPath(); ctx.arc(x, y, 2 + (i % 3), 0, TAU); ctx.fill()
      }
      break
    }
    case 'drawing-brush': {
      clear('#f8fafc')
      ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.beginPath()
      for (let i = 0; i < 160; i++) {
        const x = (i / 159) * W
        const y = H * 0.5 + Math.sin(t * 2 + i * 0.16) * 120 + Math.sin(t * 5 + i * 0.03) * 16
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      break
    }
    case 'pixel-sprite': case 'sprite-sheet-runner': case 'bar-chart-race': case 'heatmap':
    case 'network-graph': case 'timeline-scrub': case 'typewriter-glitch': case 'morph-loader':
    case 'minimap-radar': case 'boids-flocking': case 'image-reveal': case 'frame-exporter': {
      clear('#0f172a')
      const label = '${q}'.replace(/-/g, ' ')
      const p = (Math.sin(t * 0.9) * 0.5 + 0.5)
      ctx.fillStyle = '#334155'; ctx.fillRect(220, H - 120, W - 440, 10)
      ctx.fillStyle = '#22d3ee'; ctx.fillRect(220, H - 120, (W - 440) * p, 10)
      ctx.fillStyle = '#f59e0b'; ctx.fillRect(260 + p * (W - 520), H * 0.42, 120, 120)
      ctx.fillStyle = '#e2e8f0'; ctx.font = '56px sans-serif'; ctx.fillText(label, 220, 180)
      break
    }
    default: {
      clear('#111827')
      ctx.fillStyle = '#e5e7eb'; ctx.font = '64px sans-serif'
      ctx.fillText('Unknown canvas template', 120, H * 0.5)
    }
  }
}

renderAt(0)
if (window.__tl) {
  const state = { t: 0 }
  window.__tl.add(state, { t: [0, DURATION], duration: DURATION, ease: 'linear', onUpdate: function() { renderAt(state.t) } }, 0)
  window.draw = function(sec) { renderAt(sec || 0) }
} else {
  const start = performance.now()
  function tick(now) { renderAt((now - start) / 1000); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}
`.trim()
}
