/**
 * Three.js–only demo scenes — lighting, PBR, particles, instancing, physical materials.
 * Load via Settings → Dev → "Load Three.js showcase".
 */
import { v4 as uuidv4 } from 'uuid'
import type { Scene } from './types'

function base(): Omit<Scene, 'id' | 'name' | 'sceneType' | 'prompt'> {
  return {
    summary: '',
    svgContent: '',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    usage: null,
    duration: 10,
    bgColor: '#050508',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: { enabled: false, src: null, volume: 1, fadeIn: false, fadeOut: false, startOffset: 0 },
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'crossfade',
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {},
    cameraMotion: null,
    worldConfig: null,
  }
}

/** Timeline-scrubbed loop: u = seconds into scene */
function threeTickLoop(body: string): string {
  return `
function tick() {
  var u = window.__dreambyte ? window.__dreambyte.time() : 0;
${body}
  renderer.render(scene3, camera);
  if (u < DURATION) requestAnimationFrame(tick);
}
renderer.render(scene3, camera);
requestAnimationFrame(tick);
`.trim()
}

export function createCapabilityShowcaseScenes(): Scene[] {
  const scenes: Scene[] = []

  // 0 — Title card (CanvasTexture plane) + wireframe icosahedron
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 00 · Title (canvas texture)',
    sceneType: 'three',
    prompt: 'Three.js showcase opener — 2D canvas as WebGL texture',
    duration: 8,
    bgColor: '#030712',
    transition: 'none',
    sceneCode: `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x030712);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(0, 0.6, 7);
window.__threeCamera = camera;
scene3.add(new THREE.AmbientLight(0x404060, 0.8));
const spot = new THREE.SpotLight(0xffffff, 1.2, 40, 0.45, 0.3);
spot.position.set(4, 8, 6);
scene3.add(spot);
const cnv = document.createElement('canvas');
cnv.width = 1536; cnv.height = 384;
const ctx = cnv.getContext('2d');
ctx.fillStyle = '#0f172a';
ctx.fillRect(0, 0, 1536, 384);
ctx.strokeStyle = '#38bdf8';
ctx.lineWidth = 4;
ctx.strokeRect(8, 8, 1520, 368);
ctx.fillStyle = '#f1f5f9';
ctx.font = 'bold 96px system-ui, sans-serif';
ctx.textAlign = 'center';
ctx.fillText('Three.js on Dreambyte', 768, 160);
ctx.fillStyle = '#94a3b8';
ctx.font = '36px system-ui, sans-serif';
ctx.fillText('WebGL · scrub with the timeline', 768, 240);
const tex = new THREE.CanvasTexture(cnv);
tex.colorSpace = THREE.SRGBColorSpace;
const titlePlane = new THREE.Mesh(
  new THREE.PlaneGeometry(7.2, 1.8),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
);
titlePlane.position.set(0, 0.9, 0);
scene3.add(titlePlane);
const wire = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1.1, 0),
  new THREE.MeshBasicMaterial({ color: 0x6366f1, wireframe: true }),
);
wire.position.set(0, -0.85, 0);
scene3.add(wire);
${threeTickLoop(`
  titlePlane.position.y = 0.9 + Math.sin(u * 1.2) * 0.06;
  wire.rotation.x = u * 0.4;
  wire.rotation.y = u * 0.55;
  camera.position.x = Math.sin(u * 0.2) * 0.35;
  camera.lookAt(0, 0.2, 0);
`)}
`,
  })

  // 1 — PBR torus knot + studio lights + grid (__threeCamera)
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 01 · PBR + lights',
    sceneType: 'three',
    prompt: 'MeshStandardMaterial, key/fill, grid helper',
    duration: 12,
    bgColor: '#000010',
    sceneCode: `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x050510);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(0, 1.2, 5);
window.__threeCamera = camera;
scene3.add(new THREE.AmbientLight(0x404060, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(4, 6, 5);
scene3.add(key);
const fill = new THREE.DirectionalLight(0xa5b4fc, 0.35);
fill.position.set(-4, 2, -2);
scene3.add(fill);
const geo = new THREE.TorusKnotGeometry(0.85, 0.28, 120, 16);
const mat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0xe84545),
  metalness: 0.35,
  roughness: 0.4,
});
const mesh = new THREE.Mesh(geo, mat);
scene3.add(mesh);
const grid = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
grid.position.y = -1.35;
scene3.add(grid);
${threeTickLoop(`
  mesh.rotation.x = u * 0.55;
  mesh.rotation.y = u * 0.8;
  camera.position.x = Math.sin(u * 0.25) * 0.9;
  camera.lookAt(0, 0, 0);
`)}
`,
  })

  // 2 — BufferGeometry points (starfield) + subtle camera drift
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 02 · Particles (Points)',
    sceneType: 'three',
    prompt: 'BufferGeometry + PointsMaterial',
    duration: 12,
    bgColor: '#000008',
    sceneCode: `
import * as THREE from 'three';
const mulberry32 = window.mulberry32;
const rand = mulberry32(91);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x000008);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, WIDTH / HEIGHT, 0.1, 500);
camera.position.set(0, 0, 14);
window.__threeCamera = camera;
const n = 8000;
const pos = new Float32Array(n * 3);
const col = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  const r = 8 + rand() * 42;
  pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  pos[i * 3 + 2] = r * Math.cos(phi);
  const t = 0.5 + rand() * 0.5;
  col[i * 3] = 0.4 + rand() * 0.6;
  col[i * 3 + 1] = 0.5 + rand() * 0.5;
  col[i * 3 + 2] = 0.9;
}
const g = new THREE.BufferGeometry();
g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
g.setAttribute('color', new THREE.BufferAttribute(col, 3));
const stars = new THREE.Points(g, new THREE.PointsMaterial({
  size: 0.12,
  vertexColors: true,
  transparent: true,
  opacity: 0.85,
  sizeAttenuation: true,
}));
scene3.add(stars);
const core = new THREE.Mesh(
  new THREE.SphereGeometry(0.35, 24, 24),
  new THREE.MeshBasicMaterial({ color: 0xfff1c2 }),
);
scene3.add(core);
${threeTickLoop(`
  stars.rotation.y = u * 0.08;
  stars.rotation.x = u * 0.03;
  core.scale.setScalar(1 + Math.sin(u * 2) * 0.08);
  camera.position.z = 14 + Math.sin(u * 0.15) * 1.2;
  camera.lookAt(0, 0, 0);
`)}
`,
  })

  // 3 — Low-poly shaded sphere + moon orbit (vertex colors, flat shading)
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 03 · Planet + moon',
    sceneType: 'three',
    prompt: 'IcosahedronGeometry, vertex colors, multiple meshes',
    duration: 14,
    bgColor: '#000010',
    sceneCode: `
import * as THREE from 'three';
const mulberry32 = window.mulberry32;
const rand = mulberry32(7);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x000008);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(0, 1.8, 9);
window.__threeCamera = camera;
scene3.add(new THREE.AmbientLight(0x1a1a3a, 0.45));
const sun = new THREE.DirectionalLight(0xfff0e0, 1.35);
sun.position.set(8, 4, 6);
scene3.add(sun);
const planetGeo = new THREE.IcosahedronGeometry(2.1, 2);
const pa = planetGeo.getAttribute('position');
const colors = new Float32Array(pa.count * 3);
for (let i = 0; i < pa.count; i++) {
  const h = (pa.getY(i) + 2.1) / 4.2;
  colors[i * 3] = 0.15 + rand() * 0.1 + h * 0.2;
  colors[i * 3 + 1] = 0.35 + h * 0.35;
  colors[i * 3 + 2] = 0.45 + (1 - h) * 0.4;
}
planetGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
planetGeo.computeVertexNormals();
const planet = new THREE.Mesh(planetGeo, new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.75,
  metalness: 0.08,
  flatShading: true,
}));
scene3.add(planet);
const moon = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.32, 1),
  new THREE.MeshStandardMaterial({ color: 0xc8c8d0, roughness: 0.85, flatShading: true }),
);
scene3.add(moon);
${threeTickLoop(`
  planet.rotation.y = u * 0.12;
  const a = u * 0.38;
  moon.position.set(Math.cos(a) * 4.8, Math.sin(a * 0.35) * 0.6, Math.sin(a) * 4.8);
  moon.rotation.y = u * 0.6;
  camera.position.x = Math.sin(u * 0.12) * 1.2;
  camera.lookAt(0, 0, 0);
`)}
`,
  })

  // 4 — InstancedMesh wave field
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 04 · InstancedMesh',
    sceneType: 'three',
    prompt: 'InstancedMesh + per-instance matrix updates',
    duration: 12,
    bgColor: '#0a0a12',
    sceneCode: `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x0a0a12);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 200);
camera.position.set(10, 9, 12);
camera.lookAt(0, 0, 0);
window.__threeCamera = camera;
scene3.add(new THREE.HemisphereLight(0x8899ff, 0x222233, 0.9));
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(5, 10, 7);
scene3.add(dir);
const cols = 28, rows = 18;
const count = cols * rows;
const mesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.35, 0.35, 0.35),
  new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.25, roughness: 0.45 }),
  count,
);
const m = new THREE.Matrix4();
const c = new THREE.Color();
let idx = 0;
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    m.makeTranslation((i - cols / 2) * 0.55, 0, (j - rows / 2) * 0.55);
    mesh.setMatrixAt(idx, m);
    c.setHSL((i / cols + j / rows) * 0.25 + 0.55, 0.65, 0.55);
    mesh.setColorAt(idx, c);
    idx++;
  }
}
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
mesh.instanceMatrix.needsUpdate = true;
if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
scene3.add(mesh);
${threeTickLoop(`
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i - cols / 2) * 0.55;
      const z = (j - rows / 2) * 0.55;
      const y = Math.sin(x * 0.9 + u * 1.8) * Math.cos(z * 0.7 + u * 1.2) * 0.65;
      m.makeTranslation(x, y, z);
      mesh.setMatrixAt(k++, m);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  camera.position.x = 10 + Math.sin(u * 0.2) * 1.5;
  camera.lookAt(0, 0, 0);
`)}
`,
  })

  // 5 — MeshPhysicalMaterial glass + colored spheres
  scenes.push({
    ...base(),
    id: uuidv4(),
    name: 'Three · 05 · Transmission (physical)',
    sceneType: 'three',
    prompt: 'MeshPhysicalMaterial transmission + backdrop',
    duration: 12,
    bgColor: '#0c0a14',
    sceneCode: `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.setClearColor(0x0c0a14);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, WIDTH / HEIGHT, 0.1, 100);
camera.position.set(0, 1.2, 6.5);
window.__threeCamera = camera;
scene3.add(new THREE.AmbientLight(0x404060, 0.35));
const k1 = new THREE.PointLight(0xff99cc, 1.2, 20);
k1.position.set(-3, 2, 4);
scene3.add(k1);
const k2 = new THREE.PointLight(0x66eeff, 1.0, 20);
k2.position.set(4, 1, 3);
scene3.add(k2);
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(20, 32, 24),
  new THREE.MeshBasicMaterial({ color: 0x1a1030, side: THREE.BackSide }),
);
scene3.add(backdrop);
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.05,
  transmission: 0.92,
  thickness: 0.65,
  ior: 1.45,
  transparent: true,
});
const glass = new THREE.Mesh(new THREE.SphereGeometry(0.95, 64, 48), glassMat);
glass.position.set(0, 0.4, 0);
scene3.add(glass);
const orbA = new THREE.Mesh(
  new THREE.SphereGeometry(0.35, 32, 24),
  new THREE.MeshStandardMaterial({ color: 0xe84545, emissive: 0x440000, emissiveIntensity: 0.4 }),
);
orbA.position.set(-1.8, -0.2, 1);
scene3.add(orbA);
const orbB = new THREE.Mesh(
  new THREE.SphereGeometry(0.28, 32, 24),
  new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x002200, emissiveIntensity: 0.35 }),
);
orbB.position.set(1.6, 0.5, -0.8);
scene3.add(orbB);
${threeTickLoop(`
  glass.rotation.y = u * 0.35;
  glass.rotation.x = Math.sin(u * 0.4) * 0.15;
  orbA.position.x = -1.8 + Math.sin(u * 1.1) * 0.25;
  orbB.position.y = 0.5 + Math.cos(u * 0.9) * 0.2;
  camera.position.z = 6.5 + Math.sin(u * 0.18) * 0.4;
  camera.lookAt(0, 0.2, 0);
`)}
`,
  })

  return scenes
}
