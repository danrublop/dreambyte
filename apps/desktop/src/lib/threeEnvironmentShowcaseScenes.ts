/**
 * One Three.js scene per Dreambyte stage environment — dev gallery.
 * Settings → Dev → "Load Three env gallery".
 */
import { v4 as uuidv4 } from 'uuid'
import type { Scene } from './types'
import { DREAMBYTE_THREE_ENVIRONMENTS } from './three-environments/registry'

export const THREE_ENV_GALLERY_SCENE_COUNT = DREAMBYTE_THREE_ENVIRONMENTS.length

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
    duration: 8,
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

/** Minimal hero mesh + timeline-driven env update (same pattern as agent-generated three scenes). */
export function buildThreeEnvironmentShowcaseSceneCode(envId: string): string {
  const idLit = JSON.stringify(envId)
  const skipHero = envId === 'track_rolling_topdown'
  const loopForever = envId === 'track_rolling_topdown'
  const heroBlock = skipHero
    ? ''
    : `
var hero = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.5, 1),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(typeof PALETTE !== 'undefined' && PALETTE[0] ? PALETTE[0] : '#e84545'),
    metalness: 0.35,
    roughness: 0.42,
  })
);
hero.castShadow = true;
hero.position.set(2.2, 1.5, 0.5);
scene.add(hero);
`
  const heroAnimate = skipHero
    ? ''
    : `
  hero.rotation.x = t * 0.35;
  hero.rotation.y = t * 0.5;
  hero.position.y = 1.5 + Math.sin(t * 0.9) * 0.1;
`
  const durationCheck = loopForever ? '' : '\n  if (t > DURATION) return;'
  const timeSource =
    "window.__dreambyte && typeof window.__dreambyte.time === 'function' ? window.__dreambyte.time() : (performance.now() - startTime) / 1000"
  // For environments with self-driving render loops (track_rolling_topdown),
  // the environment's applyDreambyteThreeEnvironment already starts its own RAF loop.
  // Scene code only needs to set up the renderer/scene/camera and call apply.
  if (loopForever) {
    return `
import * as THREE from 'three';
const { WIDTH, HEIGHT, PALETTE, DURATION, applyDreambyteThreeEnvironment } = window;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 500);
camera.position.set(0, 2.4, 10);
camera.lookAt(0, 0.9, 0);
window.__threeCamera = camera;

applyDreambyteThreeEnvironment("track_rolling_topdown", scene, renderer, camera);
`.trim()
  }
  return `
import * as THREE from 'three';
const { WIDTH, HEIGHT, PALETTE, DURATION, applyDreambyteThreeEnvironment, updateDreambyteThreeEnvironment } = window;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 500);
camera.position.set(0, 2.4, 10);
camera.lookAt(0, 0.9, 0);
window.__threeCamera = camera;

applyDreambyteThreeEnvironment(${idLit}, scene, renderer, camera);
${heroBlock}
var startTime = performance.now();
function animate() {
  var t = ${timeSource};${durationCheck}
  updateDreambyteThreeEnvironment(t);${heroAnimate}
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
renderer.render(scene, camera);
requestAnimationFrame(animate);
`.trim()
}

export function createThreeEnvironmentShowcaseScenes(): Scene[] {
  return DREAMBYTE_THREE_ENVIRONMENTS.map((meta, idx) => ({
    ...base(),
    id: uuidv4(),
    name: `Env gallery · ${String(idx + 1).padStart(2, '0')} · ${meta.id}`,
    sceneType: 'three' as const,
    prompt: `Dreambyte stage environment: ${meta.name} (${meta.id})`,
    threeEnvironmentPresetId: meta.id,
    sceneCode: buildThreeEnvironmentShowcaseSceneCode(meta.id),
  }))
}
