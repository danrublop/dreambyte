/**
 * React showcase — every animation type inside the React framework.
 * Load via Settings → Dev → "Load React showcase".
 *
 * Scene 1: Pure React — interpolate, spring, Sequence, stagger
 * Scene 2: Canvas2DLayer — procedural particles & hand-drawn
 * Scene 3: SVG paths animated by frame inside React
 * Scene 4: All bridge types composited in one scene
 */
import { v4 as uuidv4 } from 'uuid'
import type { Scene } from './types'

function base(): Omit<Scene, 'id' | 'name' | 'sceneType' | 'prompt' | 'reactCode'> {
  return {
    summary: '',
    svgContent: '',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    usage: null,
    duration: 10,
    bgColor: '#0a0a1a',
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
    styleOverride: { palette: ['#0a0a1a', '#00ff88', '#ff0080', '#00cfff'] },
    cameraMotion: null,
    worldConfig: null,
    chartLayers: [],
  }
}

// ── Scene 1: Pure React Animation ────────────────────────────────────────────
// Demonstrates: interpolate, spring, Sequence, Easing, stagger, AbsoluteFill

const SCENE_1_PURE_REACT = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{
      background: 'linear-gradient(135deg, #0a0a1a 0%, #1a0030 100%)',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* Background grid pulse */}
      <AbsoluteFill style={{ zIndex: 0, opacity: 0.15 }}>
        {Array.from({ length: 12 }).map(function(_, i) {
          var pulse = Math.sin(frame * 0.04 + i * 0.5) * 0.5 + 0.5;
          return (
            <div key={'h'+i} style={{
              position: 'absolute', top: (i * 90) + 'px', left: 0, right: 0,
              height: 1, background: 'rgba(0,255,136,' + (pulse * 0.3) + ')',
            }} />
          );
        })}
        {Array.from({ length: 20 }).map(function(_, i) {
          var pulse = Math.sin(frame * 0.04 + i * 0.7) * 0.5 + 0.5;
          return (
            <div key={'v'+i} style={{
              position: 'absolute', left: (i * 96) + 'px', top: 0, bottom: 0,
              width: 1, background: 'rgba(0,207,255,' + (pulse * 0.2) + ')',
            }} />
          );
        })}
      </AbsoluteFill>

      {/* Title with spring entrance */}
      <Sequence from={0} durationInFrames={280}>
        <TitleSection />
      </Sequence>

      {/* Staggered feature cards */}
      <Sequence from={40}>
        <FeatureCards />
      </Sequence>

      {/* Animated counter */}
      <Sequence from={90}>
        <CounterRow />
      </Sequence>
    </AbsoluteFill>
  );
}

function TitleSection() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var scale = spring({ frame: frame, fps: fps, config: { damping: 10, stiffness: 60 } });
  var opacity = interpolate(frame, [0, 20], [0, 1]);
  var subtitleY = interpolate(frame, [15, 40], [40, 0], { easing: Easing.easeOut });
  var subtitleOpacity = interpolate(frame, [15, 35], [0, 1]);

  return (
    <AbsoluteFill style={{ zIndex: 1, justifyContent: 'flex-start', alignItems: 'center', paddingTop: 80 }}>
      <div style={{
        fontSize: 88, fontWeight: 800, letterSpacing: -2,
        background: 'linear-gradient(90deg, #00ff88, #00cfff)',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        transform: 'scale(' + scale + ')', opacity: opacity,
      }}>
        Pure React Animation
      </div>
      <div style={{
        fontSize: 32, color: 'rgba(255,255,255,0.5)', marginTop: 16,
        opacity: subtitleOpacity,
        transform: 'translateY(' + subtitleY + 'px)',
      }}>
        interpolate + spring + Sequence + Easing
      </div>
    </AbsoluteFill>
  );
}

function FeatureCards() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var items = [
    { label: 'interpolate()', color: '#00ff88', desc: 'Frame-to-value mapping' },
    { label: 'spring()', color: '#00cfff', desc: 'Spring-based motion' },
    { label: '<Sequence>', color: '#ff0080', desc: 'Temporal composition' },
    { label: 'Easing.*', color: '#fbbf24', desc: 'Bezier & preset curves' },
    { label: '<AbsoluteFill>', color: '#a855f7', desc: 'Layer stacking' },
  ];

  return (
    <AbsoluteFill style={{ zIndex: 2, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1600, padding: '0 60px' }}>
        {items.map(function(item, i) {
          var delay = i * 10;
          var s = spring({ frame: frame - delay, fps: fps, config: { damping: 12, stiffness: 100 } });
          var o = interpolate(frame, [delay, delay + 15], [0, 1]);
          var hover = Math.sin(frame * 0.03 + i * 1.2) * 4;

          return (
            <div key={i} style={{
              width: 280, padding: '32px 24px', borderRadius: 16,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid ' + item.color + '30',
              transform: 'scale(' + s + ') translateY(' + hover + 'px)',
              opacity: o, textAlign: 'center',
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: item.color, fontFamily: 'monospace' }}>{item.label}</div>
              <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.4)', marginTop: 8 }}>{item.desc}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function CounterRow() {
  var frame = useCurrentFrame();
  var stats = [
    { value: 6, label: 'Renderers', color: '#00ff88' },
    { value: 30, label: 'FPS', color: '#00cfff' },
    { value: 1080, label: 'Resolution', color: '#ff0080' },
  ];

  return (
    <AbsoluteFill style={{ zIndex: 3, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 80 }}>
      <div style={{ display: 'flex', gap: 80 }}>
        {stats.map(function(stat, i) {
          var delay = i * 12;
          var progress = interpolate(frame, [delay, delay + 50], [0, 1]);
          var val = Math.round(stat.value * Math.min(progress, 1));
          var opacity = interpolate(frame, [delay, delay + 10], [0, 1]);

          return (
            <div key={i} style={{ textAlign: 'center', opacity: opacity }}>
              <div style={{ fontSize: 64, fontWeight: 800, color: stat.color }}>{val}</div>
              <div style={{ fontSize: 18, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>{stat.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
`

// ── Scene 2: Canvas2DLayer ───────────────────────────────────────────────────
// Demonstrates: Canvas2DLayer bridge, procedural drawing, particles, hand-drawn

const SCENE_2_CANVAS2D = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var titleOpacity = interpolate(frame, [0, 25], [0, 1]);
  var titleY = interpolate(frame, [0, 25], [30, 0], { easing: Easing.easeOut });

  return (
    <AbsoluteFill style={{
      background: '#0a0a1a',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* Canvas2D: Particle system */}
      <Canvas2DLayer draw={function(ctx, f, config) {
        var w = config.width, h = config.height;
        var t = f / 30;

        // Seeded random for determinism
        function rand(seed) {
          var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
          return x - Math.floor(x);
        }

        // Particle field
        for (var i = 0; i < 150; i++) {
          var baseX = rand(i * 1.1) * w;
          var baseY = rand(i * 2.3) * h;
          var speed = 0.3 + rand(i * 3.7) * 0.7;
          var radius = 2 + rand(i * 5.1) * 6;

          var x = baseX + Math.sin(t * speed + i) * 80;
          var y = baseY + Math.cos(t * speed * 0.7 + i * 0.5) * 60;

          // Color cycling
          var hue = (i * 37 + f * 0.5) % 360;
          var alpha = 0.15 + Math.sin(t * 2 + i) * 0.1;

          // Fade in particles over time
          var fadeIn = Math.min(1, f / (10 + i * 0.5));
          alpha *= fadeIn;

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fillStyle = 'hsla(' + hue + ', 80%, 60%, ' + alpha + ')';
          ctx.fill();

          // Glow effect for larger particles
          if (radius > 5) {
            ctx.beginPath();
            ctx.arc(x, y, radius * 3, 0, Math.PI * 2);
            var grad = ctx.createRadialGradient(x, y, 0, x, y, radius * 3);
            grad.addColorStop(0, 'hsla(' + hue + ', 90%, 70%, ' + (alpha * 0.3) + ')');
            grad.addColorStop(1, 'transparent');
            ctx.fillStyle = grad;
            ctx.fill();
          }
        }

        // Connecting lines between nearby particles
        ctx.strokeStyle = 'rgba(0, 255, 136, 0.04)';
        ctx.lineWidth = 1;
        for (var a = 0; a < 40; a++) {
          for (var b = a + 1; b < 40; b++) {
            var ax = rand(a * 1.1) * w + Math.sin(t * (0.3 + rand(a * 3.7) * 0.7) + a) * 80;
            var ay = rand(a * 2.3) * h + Math.cos(t * (0.3 + rand(a * 3.7) * 0.7) * 0.7 + a * 0.5) * 60;
            var bx = rand(b * 1.1) * w + Math.sin(t * (0.3 + rand(b * 3.7) * 0.7) + b) * 80;
            var by = rand(b * 2.3) * h + Math.cos(t * (0.3 + rand(b * 3.7) * 0.7) * 0.7 + b * 0.5) * 60;
            var dist = Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
            if (dist < 150) {
              ctx.globalAlpha = (1 - dist / 150) * 0.15 * Math.min(1, f / 30);
              ctx.beginPath();
              ctx.moveTo(ax, ay);
              ctx.lineTo(bx, by);
              ctx.stroke();
            }
          }
        }
        ctx.globalAlpha = 1;

        // Wave at bottom
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (var wx = 0; wx <= w; wx += 4) {
          var wy = h - 100 + Math.sin(wx * 0.005 + t * 1.5) * 30 + Math.sin(wx * 0.01 + t * 0.8) * 15;
          ctx.lineTo(wx, wy);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        var waveGrad = ctx.createLinearGradient(0, h - 130, 0, h);
        waveGrad.addColorStop(0, 'rgba(0, 207, 255, 0.08)');
        waveGrad.addColorStop(1, 'rgba(0, 207, 255, 0.02)');
        ctx.fillStyle = waveGrad;
        ctx.fill();
      }} style={{ zIndex: 0 }} />

      {/* React text overlay on top of canvas */}
      <AbsoluteFill style={{ zIndex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <div style={{
          opacity: titleOpacity,
          transform: 'translateY(' + titleY + 'px)',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 80, fontWeight: 800, color: 'white',
            textShadow: '0 0 80px rgba(0,255,136,0.4)',
          }}>
            Canvas2DLayer
          </div>
          <div style={{ fontSize: 28, color: 'rgba(255,255,255,0.5)', marginTop: 16 }}>
            150 particles + connecting lines + wave — all in draw(ctx, frame)
          </div>
          <div style={{
            fontSize: 18, color: '#00ff88', marginTop: 32, fontFamily: 'monospace',
            opacity: interpolate(frame, [40, 55], [0, 1]),
          }}>
            {'frame: ' + frame + ' / ' + (30 * DURATION)}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
`

// ── Scene 3: SVG inside React ────────────────────────────────────────────────
// Demonstrates: Inline SVG driven by useCurrentFrame, animated paths, morphing

const SCENE_3_SVG = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var t = frame / fps;

  // Animated SVG circle positions
  var circles = [];
  for (var i = 0; i < 8; i++) {
    var angle = (i / 8) * Math.PI * 2 + t * 0.5;
    var radius = 250 + Math.sin(t * 1.5 + i * 0.8) * 80;
    var cx = 960 + Math.cos(angle) * radius;
    var cy = 540 + Math.sin(angle) * radius;
    var r = 20 + Math.sin(t * 2 + i * 1.1) * 12;
    var opacity = interpolate(frame, [i * 5, i * 5 + 20], [0, 0.8]);
    var colors = ['#00ff88', '#00cfff', '#ff0080', '#fbbf24', '#a855f7', '#00ff88', '#00cfff', '#ff0080'];
    circles.push({ cx: cx, cy: cy, r: r, opacity: opacity, color: colors[i] });
  }

  // Animated path (breathing shape)
  var pathPoints = [];
  for (var p = 0; p <= 360; p += 10) {
    var a = (p / 180) * Math.PI;
    var baseR = 180;
    var wobble = Math.sin(a * 3 + t * 2) * 40 + Math.sin(a * 5 - t * 1.5) * 20;
    var pr = baseR + wobble;
    var px = 960 + Math.cos(a) * pr;
    var py = 540 + Math.sin(a) * pr;
    pathPoints.push((p === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1));
  }
  var pathD = pathPoints.join(' ') + ' Z';
  var pathOpacity = interpolate(frame, [0, 30], [0, 0.3]);

  // Connecting lines
  var lines = [];
  for (var li = 0; li < circles.length; li++) {
    var ni = (li + 1) % circles.length;
    lines.push({ x1: circles[li].cx, y1: circles[li].cy, x2: circles[ni].cx, y2: circles[ni].cy });
  }

  var titleOpacity = interpolate(frame, [10, 30], [0, 1]);
  var titleScale = spring({ frame: frame - 5, fps: fps, config: { damping: 14 } });

  return (
    <AbsoluteFill style={{
      background: 'radial-gradient(ellipse at center, #0a1a2e 0%, #0a0a1a 70%)',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* SVG layer — animated paths and circles driven by frame */}
      <AbsoluteFill style={{ zIndex: 0 }}>
        <svg viewBox="0 0 1920 1080" style={{ width: '100%', height: '100%' }}>
          {/* Breathing organic shape */}
          <path d={pathD} fill="none" stroke="#00ff88" strokeWidth="2" opacity={pathOpacity} />
          <path d={pathD} fill="rgba(0,255,136,0.03)" stroke="none" opacity={pathOpacity} />

          {/* Connecting lines */}
          {lines.map(function(l, i) {
            var lineOpacity = interpolate(frame, [15 + i * 3, 30 + i * 3], [0, 0.2]);
            return <line key={'l'+i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#00cfff" strokeWidth="1" opacity={lineOpacity} />;
          })}

          {/* Orbiting circles */}
          {circles.map(function(c, i) {
            return (
              <g key={'c'+i}>
                <circle cx={c.cx} cy={c.cy} r={c.r * 3} fill={c.color} opacity={c.opacity * 0.1} />
                <circle cx={c.cx} cy={c.cy} r={c.r} fill={c.color} opacity={c.opacity} />
                <circle cx={c.cx} cy={c.cy} r={c.r * 0.4} fill="white" opacity={c.opacity * 0.8} />
              </g>
            );
          })}

          {/* Rotating dashed ring */}
          <circle
            cx="960" cy="540" r="350" fill="none"
            stroke="rgba(255,255,255,0.08)" strokeWidth="1"
            strokeDasharray="10 20"
            transform={'rotate(' + (frame * 0.3) + ' 960 540)'}
          />
          <circle
            cx="960" cy="540" r="420" fill="none"
            stroke="rgba(0,207,255,0.06)" strokeWidth="1"
            strokeDasharray="5 30"
            transform={'rotate(' + (-frame * 0.2) + ' 960 540)'}
          />
        </svg>
      </AbsoluteFill>

      {/* Title */}
      <AbsoluteFill style={{ zIndex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <div style={{
          opacity: titleOpacity,
          transform: 'scale(' + titleScale + ')',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 72, fontWeight: 800, color: 'white',
            textShadow: '0 0 60px rgba(0,207,255,0.3)',
          }}>
            SVG in React
          </div>
          <div style={{ fontSize: 24, color: 'rgba(255,255,255,0.4)', marginTop: 12 }}>
            8 orbiting nodes + organic path + dashed rings — all driven by useCurrentFrame()
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
`

// ── Scene 4: ThreeJSLayer ────────────────────────────────────────────────────
// Demonstrates: ThreeJSLayer bridge, 3D geometry, lighting, per-frame rotation

const SCENE_4_THREEJS = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var titleOpacity = interpolate(frame, [0, 25], [0, 1]);
  var titleY = interpolate(frame, [0, 25], [30, 0], { easing: Easing.easeOut });

  return (
    <AbsoluteFill style={{
      background: 'radial-gradient(ellipse at center, #0a1020 0%, #050510 70%)',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* Three.js 3D scene */}
      <ThreeJSLayer
        setup={function(THREE, scene, camera, renderer) {
          renderer.setClearColor(0x000000, 0);
          camera.position.set(0, 2, 6);
          camera.lookAt(0, 0, 0);

          // Lighting
          var ambient = new THREE.AmbientLight(0x404060, 0.5);
          scene.add(ambient);

          var point1 = new THREE.PointLight(0x00ff88, 2, 20);
          point1.position.set(3, 3, 3);
          scene.add(point1);

          var point2 = new THREE.PointLight(0xff0080, 1.5, 20);
          point2.position.set(-3, 2, -2);
          scene.add(point2);

          var point3 = new THREE.PointLight(0x00cfff, 1, 20);
          point3.position.set(0, -2, 4);
          scene.add(point3);

          // Central torus knot
          var torusGeo = new THREE.TorusKnotGeometry(1.2, 0.4, 128, 32);
          var torusMat = new THREE.MeshStandardMaterial({
            color: 0x00ff88,
            metalness: 0.7,
            roughness: 0.2,
            emissive: 0x003322,
            emissiveIntensity: 0.3,
          });
          var torus = new THREE.Mesh(torusGeo, torusMat);
          torus.name = 'torus';
          scene.add(torus);

          // Orbiting smaller spheres
          for (var i = 0; i < 6; i++) {
            var sphereGeo = new THREE.SphereGeometry(0.2, 16, 16);
            var colors = [0x00ff88, 0xff0080, 0x00cfff, 0xfbbf24, 0xa855f7, 0x00ff88];
            var sphereMat = new THREE.MeshStandardMaterial({
              color: colors[i],
              metalness: 0.5,
              roughness: 0.3,
              emissive: colors[i],
              emissiveIntensity: 0.4,
            });
            var sphere = new THREE.Mesh(sphereGeo, sphereMat);
            sphere.name = 'orb_' + i;
            scene.add(sphere);
          }

          // Grid floor
          var grid = new THREE.GridHelper(12, 24, 0x00ff88, 0x112233);
          grid.position.y = -2;
          grid.material.opacity = 0.3;
          grid.material.transparent = true;
          scene.add(grid);
        }}
        update={function(scene, camera, f, config) {
          var t = f / config.fps;

          // Rotate torus
          var torus = scene.getObjectByName('torus');
          if (torus) {
            torus.rotation.x = t * 0.3;
            torus.rotation.y = t * 0.5;
            torus.rotation.z = t * 0.2;
            // Pulse scale
            var pulse = 1 + Math.sin(t * 2) * 0.05;
            torus.scale.set(pulse, pulse, pulse);
          }

          // Orbit spheres
          for (var i = 0; i < 6; i++) {
            var orb = scene.getObjectByName('orb_' + i);
            if (orb) {
              var angle = (i / 6) * Math.PI * 2 + t * (0.8 + i * 0.1);
              var radius = 2.5 + Math.sin(t + i) * 0.5;
              orb.position.x = Math.cos(angle) * radius;
              orb.position.z = Math.sin(angle) * radius;
              orb.position.y = Math.sin(t * 1.5 + i * 1.2) * 0.8;
            }
          }

          // Gentle camera sway
          camera.position.x = Math.sin(t * 0.2) * 1.5;
          camera.position.y = 2 + Math.sin(t * 0.15) * 0.5;
          camera.lookAt(0, 0, 0);
        }}
        style={{ zIndex: 0 }}
      />

      {/* Title overlay */}
      <AbsoluteFill style={{ zIndex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 80 }}>
        <div style={{
          opacity: titleOpacity,
          transform: 'translateY(' + titleY + 'px)',
          textAlign: 'center',
          background: 'rgba(0,0,0,0.4)',
          padding: '24px 48px',
          borderRadius: 16,
          backdropFilter: 'blur(10px)',
        }}>
          <div style={{ fontSize: 56, fontWeight: 800, color: 'white' }}>
            ThreeJSLayer
          </div>
          <div style={{ fontSize: 22, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
            Torus knot + 6 orbiting spheres + grid — setup() once, update() per frame
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
`

// ── Scene 5: D3 Data Visualization ───────────────────────────────────────────
// Demonstrates: D3 charting driven by frame, animated bar chart with React labels

const SCENE_5_D3 = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var t = frame / fps;

  // Data for the bar chart
  var data = [
    { label: 'React', value: 95, color: '#00ff88' },
    { label: 'Canvas2D', value: 78, color: '#ff0080' },
    { label: 'Three.js', value: 82, color: '#00cfff' },
    { label: 'SVG', value: 65, color: '#fbbf24' },
    { label: 'D3', value: 88, color: '#a855f7' },
    { label: 'Lottie', value: 55, color: '#f97316' },
  ];

  // Chart dimensions
  var chartLeft = 300;
  var chartTop = 200;
  var chartWidth = 1320;
  var chartHeight = 550;
  var barGap = 20;
  var barWidth = (chartWidth - barGap * (data.length + 1)) / data.length;

  // Animated bars
  var bars = data.map(function(d, i) {
    var delay = 20 + i * 10;
    var progress = interpolate(frame, [delay, delay + 40], [0, 1], { easing: Easing.easeOut });
    var barHeight = (d.value / 100) * chartHeight * progress;
    var x = chartLeft + barGap + i * (barWidth + barGap);
    var y = chartTop + chartHeight - barHeight;
    return { x: x, y: y, w: barWidth, h: barHeight, d: d, i: i, progress: progress };
  });

  var titleOpacity = interpolate(frame, [0, 20], [0, 1]);
  var axisOpacity = interpolate(frame, [5, 25], [0, 1]);

  return (
    <AbsoluteFill style={{
      background: 'linear-gradient(180deg, #0a0a1a 0%, #0a0a2e 100%)',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* Title */}
      <div style={{
        position: 'absolute', top: 60, width: '100%', textAlign: 'center',
        opacity: titleOpacity,
      }}>
        <div style={{ fontSize: 18, color: '#a855f7', letterSpacing: 4, textTransform: 'uppercase', fontWeight: 600 }}>
          D3-Style Data Visualization
        </div>
        <div style={{ fontSize: 48, fontWeight: 800, color: 'white', marginTop: 8 }}>
          Bridge Component Benchmark
        </div>
      </div>

      {/* Chart rendered as SVG in JSX (D3-style but pure React) */}
      <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {/* Y-axis */}
        <line
          x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartTop + chartHeight}
          stroke="rgba(255,255,255,0.2)" strokeWidth="1" opacity={axisOpacity}
        />
        {/* X-axis */}
        <line
          x1={chartLeft} y1={chartTop + chartHeight} x2={chartLeft + chartWidth} y2={chartTop + chartHeight}
          stroke="rgba(255,255,255,0.2)" strokeWidth="1" opacity={axisOpacity}
        />

        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map(function(v) {
          var y = chartTop + chartHeight - (v / 100) * chartHeight;
          return (
            <g key={'grid'+v}>
              <line x1={chartLeft} y1={y} x2={chartLeft + chartWidth} y2={y}
                stroke="rgba(255,255,255,0.05)" strokeWidth="1" opacity={axisOpacity}
              />
              <text x={chartLeft - 15} y={y + 5} fill="rgba(255,255,255,0.3)"
                fontSize="14" textAnchor="end" opacity={axisOpacity}>
                {v}
              </text>
            </g>
          );
        })}

        {/* Bars with glow */}
        {bars.map(function(bar) {
          var glowIntensity = Math.sin(t * 2 + bar.i) * 0.3 + 0.7;
          return (
            <g key={'bar'+bar.i}>
              {/* Glow rect */}
              <rect x={bar.x - 4} y={bar.y - 4} width={bar.w + 8} height={bar.h + 4}
                fill={bar.d.color} opacity={bar.progress * 0.15 * glowIntensity}
                rx="6" filter="url(#blur)"
              />
              {/* Main bar */}
              <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h}
                fill={bar.d.color} rx="4" opacity={bar.progress}
              />
              {/* Value label */}
              {bar.progress > 0.5 && (
                <text x={bar.x + bar.w / 2} y={bar.y - 15}
                  fill="white" fontSize="24" fontWeight="700" textAnchor="middle"
                  opacity={interpolate(bar.progress, [0.5, 0.8], [0, 1])}>
                  {Math.round(bar.d.value * bar.progress)}
                </text>
              )}
              {/* Label */}
              <text x={bar.x + bar.w / 2} y={chartTop + chartHeight + 35}
                fill={bar.d.color} fontSize="18" fontWeight="600" textAnchor="middle"
                opacity={bar.progress}>
                {bar.d.label}
              </text>
            </g>
          );
        })}

        {/* SVG filter for glow */}
        <defs>
          <filter id="blur">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>
      </svg>

      {/* Animated total */}
      <Sequence from={90}>
        <TotalCounter data={data} />
      </Sequence>
    </AbsoluteFill>
  );
}

function TotalCounter(props) {
  var frame = useCurrentFrame();
  var total = props.data.reduce(function(s, d) { return s + d.value; }, 0);
  var avg = total / props.data.length;
  var progress = interpolate(frame, [0, 40], [0, 1]);
  var opacity = interpolate(frame, [0, 15], [0, 1]);

  return (
    <div style={{
      position: 'absolute', bottom: 60, right: 100,
      textAlign: 'right', opacity: opacity,
    }}>
      <div style={{ fontSize: 16, color: 'rgba(255,255,255,0.4)', letterSpacing: 2 }}>AVERAGE SCORE</div>
      <div style={{ fontSize: 72, fontWeight: 800, color: '#a855f7', marginTop: 4 }}>
        {Math.round(avg * progress)}
      </div>
    </div>
  );
}
`

// ── Scene 6: All bridges composited in one scene ─────────────────────────────
// Demonstrates: Canvas2D starfield + SVG frame + React text — all layered

const SCENE_4_COMPOSITE = `
export default function Scene() {
  var frame = useCurrentFrame();
  var { fps, durationInFrames } = useVideoConfig();
  var t = frame / fps;

  return (
    <AbsoluteFill style={{
      background: '#050510',
      fontFamily: '"Inter", system-ui, sans-serif',
    }}>
      {/* Layer 0: Canvas2D — starfield background */}
      <Canvas2DLayer draw={function(ctx, f, config) {
        var w = config.width, h = config.height;
        function rand(s) { var x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
        var time = f / 30;

        // Stars
        for (var i = 0; i < 200; i++) {
          var sx = rand(i * 1.1) * w;
          var sy = rand(i * 2.3) * h;
          var sz = 0.5 + rand(i * 4.5) * 2;
          var twinkle = 0.3 + Math.sin(time * (1 + rand(i * 7.1) * 3) + i) * 0.3;
          ctx.beginPath();
          ctx.arc(sx, sy, sz, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,' + (twinkle * Math.min(1, f / 30)) + ')';
          ctx.fill();
        }

        // Nebula blobs
        var nebulae = [
          { x: w * 0.3, y: h * 0.4, r: 300, color: '0,255,136' },
          { x: w * 0.7, y: h * 0.6, r: 250, color: '255,0,128' },
          { x: w * 0.5, y: h * 0.3, r: 200, color: '0,207,255' },
        ];
        nebulae.forEach(function(n) {
          var ox = n.x + Math.sin(time * 0.3) * 30;
          var oy = n.y + Math.cos(time * 0.2) * 20;
          var grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, n.r);
          grad.addColorStop(0, 'rgba(' + n.color + ', 0.06)');
          grad.addColorStop(1, 'transparent');
          ctx.fillStyle = grad;
          ctx.fillRect(ox - n.r, oy - n.r, n.r * 2, n.r * 2);
        });
      }} style={{ zIndex: 0 }} />

      {/* Layer 1: SVG — animated geometric frame */}
      <AbsoluteFill style={{ zIndex: 1 }}>
        <svg viewBox="0 0 1920 1080" style={{ width: '100%', height: '100%' }}>
          {/* Corner brackets */}
          {[
            { x: 100, y: 100, rot: 0 },
            { x: 1820, y: 100, rot: 90 },
            { x: 1820, y: 980, rot: 180 },
            { x: 100, y: 980, rot: 270 },
          ].map(function(corner, i) {
            var drawProgress = interpolate(frame, [20 + i * 8, 50 + i * 8], [0, 1]);
            var len = 80 * drawProgress;
            return (
              <g key={'corner'+i} transform={'translate(' + corner.x + ',' + corner.y + ') rotate(' + corner.rot + ')'}>
                <line x1="0" y1="0" x2={len} y2="0" stroke="#00ff88" strokeWidth="2" opacity={drawProgress} />
                <line x1="0" y1="0" x2="0" y2={len} stroke="#00ff88" strokeWidth="2" opacity={drawProgress} />
              </g>
            );
          })}

          {/* Horizontal scan line */}
          <line
            x1="100" y1={540 + Math.sin(t * 1.5) * 300}
            x2="1820" y2={540 + Math.sin(t * 1.5) * 300}
            stroke="rgba(0,207,255,0.15)" strokeWidth="1"
          />
        </svg>
      </AbsoluteFill>

      {/* Layer 2: React — section labels */}
      <Sequence from={0} durationInFrames={100}>
        <CompositeLabel
          title="Canvas2D + SVG + React"
          subtitle="Three renderer types, one scene"
          badge="COMPOSITE"
        />
      </Sequence>

      <Sequence from={100} durationInFrames={100}>
        <CompositeLabel
          title="Starfield: Canvas2DLayer"
          subtitle="200 twinkling stars + nebula blobs drawn per frame"
          badge="CANVAS"
        />
      </Sequence>

      <Sequence from={200}>
        <CompositeLabel
          title="Frame: SVG in JSX"
          subtitle="Corner brackets + scan line — pure SVG elements in React"
          badge="SVG"
        />
      </Sequence>
    </AbsoluteFill>
  );
}

function CompositeLabel(props) {
  var frame = useCurrentFrame();
  var { fps } = useVideoConfig();
  var s = spring({ frame: frame, fps: fps, config: { damping: 14 } });
  var opacity = interpolate(frame, [0, 15], [0, 1]);
  var exitOpacity = interpolate(frame, [75, 90], [1, 0]);

  return (
    <AbsoluteFill style={{
      zIndex: 2,
      justifyContent: 'center',
      alignItems: 'center',
      opacity: Math.min(opacity, exitOpacity),
    }}>
      <div style={{
        padding: '12px 24px', borderRadius: 6,
        background: 'rgba(0,255,136,0.1)',
        border: '1px solid rgba(0,255,136,0.3)',
        fontSize: 14, fontWeight: 600, color: '#00ff88',
        letterSpacing: 3, textTransform: 'uppercase',
        marginBottom: 20,
        opacity: interpolate(frame, [5, 20], [0, 1]),
      }}>
        {props.badge}
      </div>
      <div style={{
        fontSize: 64, fontWeight: 800, color: 'white',
        transform: 'scale(' + s + ')',
        textShadow: '0 0 40px rgba(0,207,255,0.2)',
        textAlign: 'center',
      }}>
        {props.title}
      </div>
      <div style={{
        fontSize: 24, color: 'rgba(255,255,255,0.4)', marginTop: 16,
        opacity: interpolate(frame, [15, 30], [0, 1]),
        transform: 'translateY(' + interpolate(frame, [15, 30], [15, 0]) + 'px)',
      }}>
        {props.subtitle}
      </div>
    </AbsoluteFill>
  );
}
`

export function createReactShowcaseScenes(): Scene[] {
  return [
    {
      ...base(),
      id: uuidv4(),
      name: '1 — Pure React Animation',
      sceneType: 'react',
      prompt: 'Pure React: interpolate, spring, Sequence, Easing, stagger',
      reactCode: SCENE_1_PURE_REACT.trim(),
      duration: 10,
    },
    {
      ...base(),
      id: uuidv4(),
      name: '2 — Canvas2DLayer',
      sceneType: 'react',
      prompt: 'Canvas2D bridge: particles, connecting lines, wave',
      reactCode: SCENE_2_CANVAS2D.trim(),
      duration: 10,
    },
    {
      ...base(),
      id: uuidv4(),
      name: '3 — SVG in React',
      sceneType: 'react',
      prompt: 'SVG elements driven by useCurrentFrame: orbiting nodes, organic path, dashed rings',
      reactCode: SCENE_3_SVG.trim(),
      duration: 10,
    },
    {
      ...base(),
      id: uuidv4(),
      name: '4 — ThreeJSLayer',
      sceneType: 'react',
      prompt: 'Three.js bridge: torus knot, orbiting spheres, grid, camera sway',
      reactCode: SCENE_4_THREEJS.trim(),
      duration: 10,
    },
    {
      ...base(),
      id: uuidv4(),
      name: '5 — D3 Data Viz',
      sceneType: 'react',
      prompt: 'D3-style animated bar chart with glow, grid, counters — pure React SVG',
      reactCode: SCENE_5_D3.trim(),
      duration: 10,
    },
    {
      ...base(),
      id: uuidv4(),
      name: '6 — All Bridges Composited',
      sceneType: 'react',
      prompt: 'Canvas2D starfield + SVG frame + React text — three renderers in one scene',
      reactCode: SCENE_4_COMPOSITE.trim(),
      duration: 10,
    },
  ]
}
