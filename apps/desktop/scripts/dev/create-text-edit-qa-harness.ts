/**
 * Seed a local Dreambyte project that exercises EVERY text-edit pathway in the
 * layer stack across every scene type. Pair with docs/editable-text-from-
 * layer-stack.md — each scene's name encodes which row of the capability
 * matrix it covers.
 *
 * Run:
 *   npx tsx scripts/dev/create-text-edit-qa-harness.ts
 *
 * Then open the desktop app and pick the project named
 *   "Text-edit QA harness - YYYY-MM-DD HH:MM"
 *
 * What to verify per scene:
 *   1. Open Layers tab — every text-bearing row from the matrix is present.
 *   2. Click each row — the right body opens (typography panel vs content-only
 *      vs placeholder).
 *   3. Edit content — source / DB field updates, canvas reflects it.
 *   4. Edit a typography prop — rendered text changes; Reset to original
 *      restores the snapshot (including Tailwind / CSS-file values).
 *   5. Double-click matching elements in the canvas — inline contentEditable
 *      activates where it should.
 *   6. Save (Cmd-S), reopen — change persists.
 */
process.env.DREAMBYTE_APP_URL_BASE = 'dreambyte://app/'

import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

import { generateSceneHTML } from '../../src/lib/sceneTemplate'
import { createDefaultScene } from '../../src/lib/store/helpers'
import type { Scene, GlobalStyle, D3ChartLayer, InteractionElement, SceneType } from '../../src/lib/types'

// ── DB / scene-dir discovery ───────────────────────────────────────────────

const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'dreambyte')
const USER_DB = path.join(USER_DATA, 'dreambyte.db')
const DEV_DB = path.join(process.cwd(), 'dev.db')
const SCENE_DIRS = [path.join(USER_DATA, 'scenes'), path.join(process.cwd(), 'public', 'scenes')]

const dbPaths = [USER_DB, DEV_DB].filter((p) => fs.existsSync(p))
if (dbPaths.length === 0) {
  console.error('FATAL: no Dreambyte database found. Open the desktop app once, then rerun this script.')
  process.exit(1)
}
for (const dir of SCENE_DIRS) fs.mkdirSync(dir, { recursive: true })

const nowSec = Math.floor(Date.now() / 1000)
const projectId = randomUUID()
const projectName = `Text-edit QA harness - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

const style: GlobalStyle = {
  presetId: null,
  palette: ['#101418', '#e7ecf2', '#ff4f5e', '#35d0ba', '#ffcc66'],
  font: 'Inter',
  paletteOverride: ['#101418', '#e7ecf2', '#ff4f5e', '#35d0ba'],
  bgColorOverride: null,
  fontOverride: null,
  bodyFontOverride: null,
  strokeColorOverride: null,
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sceneBase(name: string, sceneType: SceneType, bgColor: string, duration = 8): Scene {
  return {
    ...createDefaultScene(name),
    id: randomUUID(),
    name,
    duration,
    bgColor,
    sceneType,
    transition: 'crossfade',
    styleOverride: {
      palette: ['#101418', '#e7ecf2', '#ff4f5e', '#35d0ba'],
      font: 'Inter',
      bodyFont: 'Inter',
      bgColor,
    },
  }
}

// ── 01: react — every JSX kind ─────────────────────────────────────────────

function makeReactEveryKindScene(): Scene {
  const s = sceneBase('01 react — every JSX kind', 'react', '#101418', 9)
  s.reactCode = `
function Scene() {
  return (
    <AbsoluteFill style={{ background: '#101418', color: '#e7ecf2', fontFamily: FONT, padding: 60 }}>
      <h1 style={{ fontSize: 88, margin: 0 }}>H1 heading</h1>
      <h2 style={{ fontSize: 56, margin: '8px 0' }}>H2 subheading</h2>
      <h3 style={{ fontSize: 40, margin: '8px 0', color: '#35d0ba' }}>H3 sub-sub</h3>
      <p style={{ fontSize: 28, lineHeight: 1.4 }}>A paragraph row — content + typography editable.</p>
      <p style={{ fontSize: 22, color: '#ffcc66' }}>Another paragraph, different color.</p>
      <button style={{ marginTop: 18, fontSize: 24, padding: '12px 22px', border: 0, borderRadius: 12, background: '#35d0ba', color: '#101418', fontWeight: 800 }}>Button text</button>
      <ul style={{ fontSize: 24, marginTop: 18 }}>
        <li>List item one</li>
        <li>List item two</li>
        <li>List item three</li>
      </ul>
      <div style={{ fontSize: 22, marginTop: 12, color: '#b9c2ce' }}>Plain div text — addressable as rx:div</div>
      <span style={{ fontSize: 22, marginTop: 6, color: '#b9c2ce' }}>Plain span text — addressable as rx:span</span>
      <svg viewBox="0 0 800 100" style={{ width: 800, marginTop: 22 }}>
        <text x="20" y="60" fontSize="44" fontWeight="800" fill="#ff4f5e">SVG text inside JSX</text>
      </svg>
    </AbsoluteFill>
  );
}
export default Scene;
`.trim()
  return s
}

// ── 02: react — mixed-content gap ──────────────────────────────────────────

function makeReactMixedContentScene(): Scene {
  const s = sceneBase('02 react — mixed-content GAP', 'react', '#1a1024', 9)
  // None of these should produce rx:* rows for the inner text runs. The
  // iframe enumerates them as :tN sub-slots but the layer stack stays empty
  // for them. Source persistence (updateMixedContentText) primitive exists
  // but is not wired here.
  s.reactCode = `
function Scene() {
  return (
    <AbsoluteFill style={{ background: '#1a1024', color: '#f4e8ff', fontFamily: FONT, padding: 60 }}>
      <h1 style={{ fontSize: 72 }}>
        Hello <em style={{ color: '#ffcc66' }}>world</em>, friend.
      </h1>
      <p style={{ fontSize: 28 }}>
        This paragraph has a <strong>bold run</strong> in the middle and a
        <span style={{ color: '#35d0ba' }}> coloured tail</span>.
      </p>
      <div style={{ fontSize: 26 }}>
        Plain prefix <em>italic part</em> plain suffix.
      </div>
    </AbsoluteFill>
  );
}
export default Scene;
`.trim()
  return s
}

// ── 03: motion — JSX literals through the motion bridge ────────────────────

function makeMotionScene(): Scene {
  const s = sceneBase('03 motion — JSX literals', 'motion', '#0f1822', 8)
  s.sceneCode = `
window.__tl.add('#m-title', { duration: 1, opacity: 1, y: [20, 0], ease: 'outQuart' }, 0);
window.__tl.add('#m-sub',   { duration: 1, opacity: 1, y: [20, 0], ease: 'outQuart' }, 0.2);
`.trim()
  s.sceneHTML = `
<div id="m-title" style="position:absolute;left:60px;top:120px;font-size:88px;color:#fff;opacity:0;transform:translateY(20px);">Motion heading</div>
<p id="m-sub" style="position:absolute;left:60px;top:240px;font-size:28px;color:#b9c2ce;opacity:0;transform:translateY(20px);">Motion paragraph below.</p>
<button id="m-btn" style="position:absolute;left:60px;top:330px;font-size:24px;background:#35d0ba;color:#101418;border:0;border-radius:10px;padding:10px 18px;">Motion button</button>
`.trim()
  return s
}

// ── 04: svg — multi-text + svgObject (double-listing) ──────────────────────

function makeSvgScene(): Scene {
  const s = sceneBase('04 svg — multi-text + svgObject', 'svg', '#0a1422', 8)
  s.svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#0a1422"/>
  <text id="t1" x="120" y="240" font-size="96" font-weight="800" fill="#fff" font-family="Inter">Main SVG title</text>
  <text id="t2" x="120" y="360" font-size="40" fill="#35d0ba" font-family="Inter">Secondary line under title</text>
  <text id="t3" x="120" y="900" font-size="28" fill="#b9c2ce" font-family="Inter">Footer caption text</text>
</svg>
`.trim()
  const objId = randomUUID()
  s.svgObjects = [
    {
      id: objId,
      prompt: 'SVG object with its own <text>',
      svgContent:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 140"><rect x="6" y="6" width="308" height="128" rx="32" fill="#ff4f5e"/><text x="160" y="86" text-anchor="middle" font-family="Inter,Arial" font-size="42" font-weight="800" fill="#fff">OBJECT TEXT</text></svg>',
      x: 58,
      y: 60,
      width: 30,
      opacity: 1,
      zIndex: 5,
    },
  ]
  return s
}

// ── 05: lottie — text in SVG source ────────────────────────────────────────

function makeLottieScene(): Scene {
  const s = sceneBase('05 lottie — text in SVG source', 'lottie', '#15121f', 8)
  // Lottie scenes that use svgContent fallback behave like svg scenes.
  s.svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#15121f"/>
  <text x="120" y="260" font-size="84" font-weight="800" fill="#ffcc66" font-family="Inter">Lottie scene heading</text>
  <text x="120" y="380" font-size="32" fill="#e7ecf2" font-family="Inter">Editable line under heading</text>
</svg>
`.trim()
  s.lottieSource = ''
  return s
}

// ── 06: canvas2d — fillText literals ───────────────────────────────────────

function makeCanvas2dScene(): Scene {
  const s = sceneBase('06 canvas2d — fillText literals', 'canvas2d', '#101418', 8)
  s.canvasCode = `
const t = (performance.now() - startWall) / 1000;
ctx.clearRect(0, 0, WIDTH, HEIGHT);
ctx.fillStyle = '#101418';
ctx.fillRect(0, 0, WIDTH, HEIGHT);
ctx.fillStyle = '#fff';
ctx.font = 'bold 96px Inter';
ctx.fillText('Canvas heading', 120, 240);
ctx.fillStyle = '#35d0ba';
ctx.font = '32px Inter';
ctx.fillText('Subtitle in canvas', 120, 320);
ctx.strokeStyle = '#ff4f5e';
ctx.lineWidth = 2;
ctx.strokeText('Outlined caption', 120, 400);
`.trim()
  return s
}

// ── 07: d3 — chart title + JSX text ────────────────────────────────────────

function makeD3Scene(): Scene {
  const s = sceneBase('07 d3 — chart title + JSX text', 'd3', '#f6f1e8', 10)
  const chartId = randomUUID()
  const charts: D3ChartLayer[] = [
    {
      id: chartId,
      name: 'Revenue bars',
      chartType: 'bar',
      data: [
        { label: 'A', value: 34 },
        { label: 'B', value: 58 },
        { label: 'C', value: 46 },
        { label: 'D', value: 72 },
      ],
      config: { title: 'Editable chart title', colors: ['#ff4f5e'], showValues: true },
      layout: { x: 8, y: 32, width: 60, height: 50 },
      timing: { startAt: 0.2, duration: 6, animated: true },
    },
  ]
  s.chartLayers = charts
  s.sceneCode = `
const root = document.getElementById('react-root');
const heading = document.createElement('div');
heading.style.cssText = 'position:absolute;left:60px;top:60px;font-size:60px;color:#101418;font-family:Inter,Arial;font-weight:800;';
heading.textContent = 'D3 heading above the chart';
root.appendChild(heading);
`.trim()
  return s
}

// ── 08: three — TextGeometry literals ──────────────────────────────────────

function makeThreeScene(): Scene {
  const s = sceneBase('08 three — TextGeometry literals', 'three', '#080814', 8)
  s.sceneCode = `
// Pseudo Three.js scene — rx:text:* should surface the TextGeometry literals.
// Style edits should be disabled with "edit in Code tab" placeholder.
const fontLoader = new THREE.FontLoader();
fontLoader.load('https://example/font.json', (font) => {
  const g1 = new TextGeometry('Three.js heading', { font, size: 72 });
  const g2 = new TextGeometry('Sub-label', { font, size: 32 });
  // ... not actually rendering — this scene exists only to verify the layer
  // stack lists both literals.
});
`.trim()
  return s
}

// ── 09: zdog — sceneCode text ──────────────────────────────────────────────

function makeZdogScene(): Scene {
  const s = sceneBase('09 zdog — sceneCode text', 'zdog', '#0d1a1f', 8)
  s.sceneCode = `
const illo = new Zdog.Illustration({ element: '#zdog-stage', dragRotate: true });
new Zdog.Text({ addTo: illo, value: 'Zdog heading text', fontSize: 48 });
new Zdog.Text({ addTo: illo, value: 'Zdog sub-label',    fontSize: 24 });
illo.updateRenderGraph();
`.trim()
  return s
}

// ── 11: avatar_scene — JSX overlays + avatar ───────────────────────────────

function makeAvatarScene(): Scene {
  const s = sceneBase('11 avatar_scene — JSX overlays', 'avatar_scene', '#101820', 8)
  s.sceneCode = `
const root = document.getElementById('react-root');
const wrap = document.createElement('div');
wrap.style.cssText = 'position:absolute;left:60px;top:60px;font-family:Inter,Arial;color:#fff;';
const h = document.createElement('h1');
h.style.cssText = 'font-size:72px;margin:0;';
h.textContent = 'Avatar overlay heading';
const p = document.createElement('p');
p.style.cssText = 'font-size:24px;color:#b9c2ce;';
p.textContent = 'Caption beneath avatar.';
wrap.appendChild(h);
wrap.appendChild(p);
root.appendChild(wrap);
`.trim()
  return s
}

// ── 12: 3d_world — JSX overlays + world config ─────────────────────────────

function make3dWorldScene(): Scene {
  const s = sceneBase('12 3d_world — JSX overlays', '3d_world', '#06121a', 10)
  s.worldConfig = {
    environment: 'studio_room',
    objects: [],
    panel: null,
    avatar: null,
    cameraKeyframes: [],
  } as unknown as Scene['worldConfig']
  s.sceneCode = `
const root = document.getElementById('react-root');
const wrap = document.createElement('div');
wrap.style.cssText = 'position:absolute;left:60px;top:60px;font-family:Inter,Arial;color:#fff;';
const h = document.createElement('h1');
h.style.cssText = 'font-size:72px;margin:0;';
h.textContent = '3D world heading';
const p = document.createElement('p');
p.style.cssText = 'font-size:24px;color:#b9c2ce;';
p.textContent = 'World caption.';
wrap.appendChild(h);
wrap.appendChild(p);
root.appendChild(wrap);
`.trim()
  return s
}

// ── 13: universal — textOverlays + interactions ────────────────────────────

function makeUniversalScene(): Scene {
  const s = sceneBase('13 universal — overlays + interactions', 'react', '#181028', 12)
  s.reactCode = `
function Scene() {
  return (
    <AbsoluteFill style={{ background: '#181028', color: '#f4e8ff', fontFamily: FONT, padding: 60 }}>
      <h1 style={{ fontSize: 64 }}>Universal layers</h1>
      <p style={{ fontSize: 24, color: '#b9c2ce' }}>The text overlays + interactions on this scene are addressable from the stack regardless of scene type.</p>
    </AbsoluteFill>
  );
}
export default Scene;
`.trim()
  s.textOverlays = [
    {
      id: randomUUID(),
      content: 'Overlay one — fade in',
      font: 'Inter',
      size: 44,
      color: '#ffcc66',
      x: 60,
      y: 22,
      animation: 'fade-in',
      duration: 1,
      delay: 0.2,
      weight: 700,
    },
    {
      id: randomUUID(),
      content: 'Overlay two — slide up',
      font: 'Inter',
      size: 32,
      color: '#35d0ba',
      x: 60,
      y: 34,
      animation: 'slide-up',
      duration: 1,
      delay: 1.0,
    },
    {
      id: randomUUID(),
      content: 'Overlay three — typewriter',
      font: 'Inter',
      size: 28,
      color: '#ff4f5e',
      x: 60,
      y: 46,
      animation: 'typewriter',
      duration: 2,
      delay: 1.8,
    },
  ]
  const interactions: InteractionElement[] = [
    {
      id: randomUUID(),
      type: 'hotspot',
      x: 16,
      y: 70,
      width: 14,
      height: 14,
      appearsAt: 0.5,
      hidesAt: null,
      entranceAnimation: 'pop',
      label: 'Hotspot label',
      shape: 'pill',
      style: 'glow',
      color: '#35d0ba',
      triggersEdgeId: null,
      jumpsToSceneId: null,
    },
    {
      id: randomUUID(),
      type: 'choice',
      x: 40,
      y: 70,
      width: 36,
      height: 22,
      appearsAt: 1,
      hidesAt: null,
      entranceAnimation: 'fade',
      question: 'Choice question text — editable',
      layout: 'horizontal',
      options: [
        { id: randomUUID(), label: 'Option A', icon: null, jumpsToSceneId: '', color: null },
        { id: randomUUID(), label: 'Option B', icon: null, jumpsToSceneId: '', color: null },
      ],
    },
    {
      id: randomUUID(),
      type: 'quiz',
      x: 16,
      y: 86,
      width: 60,
      height: 12,
      appearsAt: 2,
      hidesAt: null,
      entranceAnimation: 'fade',
      question: 'Quiz question text — editable',
      options: [
        { id: 'q-a', label: 'Quiz A' },
        { id: 'q-b', label: 'Quiz B' },
      ],
      correctOptionId: 'q-a',
      onCorrect: 'continue',
      onCorrectSceneId: null,
      onWrong: 'retry',
      onWrongSceneId: null,
      explanation: 'Quiz explanation — editable',
    },
  ] as InteractionElement[]
  s.interactions = interactions
  return s
}

// ── Assemble ───────────────────────────────────────────────────────────────

const scenes: Scene[] = [
  makeReactEveryKindScene(),
  makeReactMixedContentScene(),
  makeMotionScene(),
  makeSvgScene(),
  makeLottieScene(),
  makeCanvas2dScene(),
  makeD3Scene(),
  makeThreeScene(),
  makeZdogScene(),
  makeAvatarScene(),
  make3dWorldScene(),
  makeUniversalScene(),
]
scenes.forEach((scene, index) => {
  scene.order = index
  ;(scene as Scene & { updatedAt?: number }).updatedAt = Date.now()
})

const sceneGraph = {
  nodes: scenes.map((scene, index) => ({ id: scene.id, position: { x: 160 + index * 220, y: 120 } })),
  edges: scenes.slice(0, -1).map((scene, index) => ({
    id: randomUUID(),
    fromSceneId: scene.id,
    toSceneId: scenes[index + 1].id,
    label: index === 0 ? 'next' : null,
  })),
  startSceneId: scenes[0].id,
}

for (const scene of scenes) {
  const html = generateSceneHTML(scene, style, null, null)
  for (const dir of SCENE_DIRS) {
    fs.writeFileSync(path.join(dir, `${scene.id}.html`), html, 'utf-8')
  }
}

async function insertProject(dbPath: string) {
  const db = createClient({ url: `file:${dbPath}` })
  await db.execute({
    sql: `INSERT INTO projects
            (id, user_id, workspace_id, name, description, output_mode, storage_mode,
             global_style, scene_graph_start_scene_id, created_at, updated_at)
          VALUES (?, NULL, NULL, ?, ?, 'mp4', 'local', ?, ?, ?, ?)`,
    args: [
      projectId,
      projectName,
      JSON.stringify({ scenes, sceneGraph, timeline: null }),
      JSON.stringify(style),
      scenes[0].id,
      nowSec,
      nowSec,
    ],
  })
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    await db.execute({
      sql: `INSERT INTO scenes
              (id, project_id, name, position, duration, bg_color,
               style_override, transition, audio_layer, video_layer,
               thumbnail_url, grid_config, camera_motion, world_config,
               scene_blob, avatar_config_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)`,
      args: [
        scene.id,
        projectId,
        scene.name,
        i,
        scene.duration,
        scene.bgColor,
        JSON.stringify(scene.styleOverride ?? {}),
        JSON.stringify(scene.transition ?? 'none'),
        JSON.stringify(scene.audioLayer ?? null),
        JSON.stringify(scene.videoLayer ?? null),
        scene.cameraMotion ? JSON.stringify(scene.cameraMotion) : null,
        scene.worldConfig ? JSON.stringify(scene.worldConfig) : null,
        JSON.stringify(scene),
        nowSec,
        nowSec,
      ],
    })
  }
  await db.close()
}

async function main() {
  for (const dbPath of dbPaths) {
    try {
      await insertProject(dbPath)
      console.log(`Inserted "${projectName}" into ${dbPath}`)
    } catch (err) {
      // dev.db is often held by `npm run dev` / Electron; dreambyte.db is the
      // canonical desktop store. Skip the locked one and keep going.
      const msg = (err as Error).message || String(err)
      if (/SQLITE_BUSY|database is locked/.test(msg)) {
        console.warn(`Skipped ${dbPath} — locked by another process (${msg}).`)
        continue
      }
      throw err
    }
  }
  console.log(`Wrote ${scenes.length} scene HTML files to:`)
  for (const dir of SCENE_DIRS) console.log(`  - ${dir}`)
  console.log('')
  console.log(`Project: ${projectName}`)
  console.log(`Project ID: ${projectId}`)
  for (const scene of scenes) console.log(`  - ${scene.name} (${scene.sceneType}, ${scene.duration}s)`)
  console.log('')
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
