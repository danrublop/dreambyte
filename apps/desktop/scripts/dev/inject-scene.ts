#!/usr/bin/env node
/**
 * inject-scene.ts
 *
 * Wraps generated scene code in the correct Dreambyte HTML template and writes
 * the result to public/scenes/{id}.html.
 *
 * Usage:
 *   npx tsx scripts/dev/inject-scene.ts \
 *     --type svg \
 *     --code /path/to/scene.svg \
 *     [--id my-scene-001] \
 *     [--name "My Scene"] \
 *     [--duration 8] \
 *     [--bg "#181818"] \
 *     [--d3data /path/to/data.json]
 *
 * For D3/Three/Motion scenes, --code should point to a .json file matching
 * the expected shape for that type.
 *
 * Supported types:
 *   svg       Raw <svg> element
 *   canvas2d  Raw JavaScript (Canvas 2D animation)
 *   d3        JSON: { styles, sceneCode, suggestedData }
 *   three     JSON: { sceneCode }
 *   motion    JSON: { styles, htmlContent, sceneCode }
 */

import fs from 'fs'
import path from 'path'

// ── Arg parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`)
  return idx >= 0 ? argv[idx + 1] : undefined
}

function requireArg(name: string): string {
  const v = getArg(name)
  if (!v) {
    console.error(`Error: --${name} is required`)
    printUsage()
    process.exit(1)
  }
  return v
}

function printUsage() {
  console.error(
    `
Usage: npx tsx scripts/dev/inject-scene.ts \\
  --type <svg|canvas2d|d3|three|motion> \\
  --code <path-to-code-file> \\
  [--id <scene-id>] \\
  [--name "<Scene Name>"] \\
  [--duration <seconds>] \\
  [--bg "<hex-color>"] \\
  [--d3data <path-to-json>]  # override D3 data (d3 type only)
`.trim(),
  )
}

const sceneType = getArg('type') || 'svg'
const codeFile = requireArg('code')
const id = getArg('id') || `scene-${Date.now()}`
const name = getArg('name') || 'Untitled'
const duration = parseInt(getArg('duration') || '8', 10)
const bgColor = getArg('bg') || '#181818'
const d3dataFile = getArg('d3data')

// Validate ID (must be alphanumeric + hyphens, matching the API's validation)
if (!/^[a-zA-Z0-9\-]+$/.test(id)) {
  console.error(`Error: --id must be alphanumeric with hyphens only. Got: "${id}"`)
  process.exit(1)
}

// Validate type
const VALID_TYPES = ['svg', 'canvas2d', 'd3', 'three', 'motion', 'zdog'] as const
type SceneType = (typeof VALID_TYPES)[number]

if (!VALID_TYPES.includes(sceneType as SceneType)) {
  console.error(`Error: --type must be one of: ${VALID_TYPES.join(', ')}. Got: "${sceneType}"`)
  process.exit(1)
}

// ── Read code file ───────────────────────────────────────────────────────────

if (!fs.existsSync(codeFile)) {
  console.error(`Error: code file not found: ${codeFile}`)
  process.exit(1)
}

const rawCode = fs.readFileSync(codeFile, 'utf-8').trim()

// ── HTML builders ────────────────────────────────────────────────────────────

function buildSVGHTML(svgContent: string, bg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bg}; }

    #svg-layer { position: absolute; inset: 0; z-index: 2; }
    #svg-layer svg { width: 100%; height: 100%; }

    /* ── Animation classes ──────────────────────────────────── */
    .stroke {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: var(--len, 1000);
      stroke-dashoffset: var(--len, 1000);
      animation: draw var(--dur, 1s) ease-in-out var(--delay, 0s) forwards;
    }
    .fadein {
      opacity: 0;
      animation: pop var(--dur, 0.4s) ease var(--delay, 0s) forwards;
    }
    .scale {
      opacity: 0;
      transform-origin: center center;
      animation: scaleIn var(--dur, 0.4s) ease var(--delay, 0s) forwards;
    }
    .slide-up {
      opacity: 0;
      animation: slideUp var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }
    .slide-left {
      opacity: 0;
      animation: slideLeft var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }
    .bounce {
      opacity: 0;
      transform-origin: center center;
      animation: bounceIn var(--dur, 0.6s) cubic-bezier(0.34, 1.56, 0.64, 1) var(--delay, 0s) forwards;
    }
    .rotate {
      opacity: 0;
      transform-origin: center center;
      animation: rotateIn var(--dur, 0.5s) ease var(--delay, 0s) forwards;
    }

    @keyframes draw      { to { stroke-dashoffset: 0; } }
    @keyframes pop       { to { opacity: 1; } }
    @keyframes scaleIn   { from { opacity: 0; transform: scale(0); }     to { opacity: 1; transform: scale(1); } }
    @keyframes slideUp   { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideLeft { from { opacity: 0; transform: translateX(50px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes bounceIn  { 0% { opacity: 0; transform: scale(0); } 60% { opacity: 1; transform: scale(1.15); } 100% { opacity: 1; transform: scale(1); } }
    @keyframes rotateIn  { from { opacity: 0; transform: rotate(-15deg); } to { opacity: 1; transform: rotate(0deg); } }
  </style>
</head>
<body>

  <div id="svg-layer">
    ${svgContent}
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      // Auto-calculate stroke-dasharray lengths
      document.querySelectorAll('.stroke').forEach(el => {
        if (el.getTotalLength) el.style.setProperty('--len', el.getTotalLength());
      });

      // Scrub support: offset animation delays by -t seconds
      const t = parseFloat(new URLSearchParams(location.search).get('t') || '0');
      if (t > 0) {
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);
          if (s.animationName && s.animationName !== 'none') {
            const delay = parseFloat(s.animationDelay) || 0;
            el.style.animationDelay = (delay - t) + 's';
          }
        });
      }
    });
  </script>

</body>
</html>`
}

function buildCanvasHTML(canvasCode: string, bg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bg}; }
    canvas { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <canvas id="c" width="1920" height="1080"></canvas>

  <script>
    // Pause/resume stubs — overwritten by generated code below
    window.__animFrame = null;
    window.__pause  = () => { cancelAnimationFrame(window.__animFrame); };
    window.__resume = () => {};
  </script>

  <script>
${canvasCode}
  </script>

</body>
</html>`
}

function buildD3HTML(sceneCode: string, styles: string, d3Data: unknown, bg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bg}; }
    #chart { width: 100%; height: 100%; }
    ${styles}
  </style>
</head>
<body>
  <div id="chart"></div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
  <script src="/sdk/dreambyte-charts.js"></script>
  <script>
    const DATA = ${JSON.stringify(d3Data, null, 2)};
    const WIDTH = 1920, HEIGHT = 1080;
    window.__pause  = () => {};
    window.__resume = () => {};

    ${sceneCode}
  </script>

</body>
</html>`
}

function buildThreeHTML(sceneCode: string, bg: string, dur: number): string {
  const palette = JSON.stringify(['#181818', '#121212', '#e84545', '#151515', '#f0ece0'])

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.183.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.183.0/examples/jsm/"
    }
  }
  </script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bg}; }
    canvas { width: 100% !important; height: 100% !important; display: block; }
  </style>
</head>
<body>
  <div id="three-layer"></div>
  <script type="module">
    import * as THREE from 'three';

    const WIDTH = 1920, HEIGHT = 1080;
    const PALETTE = ${palette};
    const DURATION = ${dur};
    const LAYER_ID = 'three-layer';

    const MATERIALS = {
      plastic: (c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.6, metalness: 0 }),
      metal: (c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.2, metalness: 0.9 }),
      glass: (c) => new THREE.MeshPhysicalMaterial({ color: new THREE.Color(c), transparent: true, opacity: 0.3, roughness: 0, transmission: 0.9 }),
      matte: (c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 1, metalness: 0 }),
      glow: (c) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), emissive: new THREE.Color(c), emissiveIntensity: 0.8 }),
    };

    function mulberry32(seed) {
      return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      }
    }

    window.__animFrame = null;
    window.__pause  = () => { cancelAnimationFrame(window.__animFrame); };
    window.__resume = () => {};

    ${sceneCode}
  </script>
</body>
</html>`
}

function buildMotionHTML(sceneCode: string, styles: string, htmlContent: string, bg: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100vh; overflow: hidden; background: ${bg}; }
    ${styles}
  </style>
</head>
<body>

  ${htmlContent}

  <script src="https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.2/anime.min.js"></script>
  <script type="module">
    import { animate, stagger } from "https://esm.sh/motion@11";

    window.__pause  = () => {
      document.querySelectorAll('*').forEach(el => {
        const s = getComputedStyle(el);
        if (s.animationName && s.animationName !== 'none') {
          el.style.animationPlayState = 'paused';
        }
      });
    };
    window.__resume = () => {
      document.querySelectorAll('*').forEach(el => {
        const s = getComputedStyle(el);
        if (s.animationName && s.animationName !== 'none') {
          el.style.animationPlayState = 'running';
        }
      });
    };

    ${sceneCode}
  </script>

</body>
</html>`
}

// ── Build HTML ───────────────────────────────────────────────────────────────

let html: string

switch (sceneType as SceneType) {
  case 'svg': {
    // Expect raw SVG element
    if (!rawCode.trimStart().startsWith('<svg')) {
      console.warn('Warning: code does not appear to start with <svg>. Proceeding anyway.')
    }
    html = buildSVGHTML(rawCode, bgColor)
    break
  }

  case 'canvas2d': {
    // Expect raw JavaScript
    html = buildCanvasHTML(rawCode, bgColor)
    break
  }

  case 'd3': {
    // Expect JSON: { styles, sceneCode, suggestedData }
    let parsed: { styles?: string; sceneCode?: string; suggestedData?: unknown }
    try {
      parsed = JSON.parse(rawCode)
    } catch (e) {
      console.error('Error: --code file must be valid JSON for d3 type')
      console.error((e as Error).message)
      process.exit(1)
    }

    // Allow external d3data override
    let d3Data: unknown = parsed.suggestedData ?? null
    if (d3dataFile) {
      if (!fs.existsSync(d3dataFile)) {
        console.error(`Error: --d3data file not found: ${d3dataFile}`)
        process.exit(1)
      }
      d3Data = JSON.parse(fs.readFileSync(d3dataFile, 'utf-8'))
    }

    html = buildD3HTML(parsed.sceneCode ?? '', parsed.styles ?? '', d3Data, bgColor)
    break
  }

  case 'three': {
    // Expect JSON: { sceneCode }
    let parsed: { sceneCode?: string }
    try {
      parsed = JSON.parse(rawCode)
    } catch (e) {
      console.error('Error: --code file must be valid JSON for three type')
      console.error((e as Error).message)
      process.exit(1)
    }
    html = buildThreeHTML(parsed.sceneCode ?? '', bgColor, duration)
    break
  }

  case 'motion': {
    // Expect JSON: { styles, htmlContent, sceneCode }
    let parsed: { styles?: string; htmlContent?: string; sceneCode?: string }
    try {
      parsed = JSON.parse(rawCode)
    } catch (e) {
      console.error('Error: --code file must be valid JSON for motion type')
      console.error((e as Error).message)
      process.exit(1)
    }
    html = buildMotionHTML(parsed.sceneCode ?? '', parsed.styles ?? '', parsed.htmlContent ?? '', bgColor)
    break
  }

  default: {
    console.error(`Unsupported type: ${sceneType}`)
    process.exit(1)
  }
}

// ── Write output ─────────────────────────────────────────────────────────────

const outDir = path.join(process.cwd(), 'public', 'scenes')
fs.mkdirSync(outDir, { recursive: true })

const outPath = path.join(outDir, `${id}.html`)
fs.writeFileSync(outPath, html, 'utf-8')

console.log(`Scene written to ${outPath}`)
console.log(`  id:       ${id}`)
console.log(`  name:     ${name}`)
console.log(`  type:     ${sceneType}`)
console.log(`  duration: ${duration}s`)
console.log(`  bg:       ${bgColor}`)
console.log(`  size:     ${(html.length / 1024).toFixed(1)} KB`)
console.log(`  preview:  http://localhost:3000/scenes/${id}.html`)
