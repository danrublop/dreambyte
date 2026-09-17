/**
 * Three.js stage + scatter helpers injected into generated scene HTML (client-safe; bundled with the app).
 * Edit this file directly when changing environments or scatter behavior.
 */
export const THREE_ENVIRONMENT_RUNTIME_SCRIPT = `/**
 * Injected into Three.js scene HTML (after window.THREE is set).
 * API:
 *   applyDreambyteThreeEnvironment(envId, scene, renderer, camera)
 *   updateDreambyteThreeEnvironment(t)  // call each frame with seconds (e.g. window.__dreambyte.time())
 */
(function initDreambyteThreeEnvironments() {
  var THREE = window.THREE;
  if (!THREE) return;

  function det(i, seed) {
    var x = Math.sin(i * 12.9898 + (seed || 0) * 78.233) * 43758.5453123;
    return x - Math.floor(x);
  }

  function disposeGroup(g) {
    if (!g) return;
    g.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
        else obj.material.dispose();
      }
    });
  }

  function clearEnv(scene) {
    var old = scene.getObjectByName('__dreambyteEnvRoot');
    if (old) {
      disposeGroup(old);
      scene.remove(old);
    }
    scene.fog = null;
    if (scene.background && scene.background.isTexture) {
      /* leave user textures alone if any */
    }
    window.__dreambyteEnvState = { update: null, refs: {} };
  }

  window.DREAMBYTE_THREE_ENV_IDS = [
    'track_rolling_topdown',
    'studio_white',
    'cinematic_fog',
    'iso_playful',
    'tech_grid',
    'nature_sunset',
    'data_lab',
  ];

  window.applyDreambyteThreeEnvironment = function (envId, scene, renderer, camera) {
    if (!scene || !renderer) return;
    clearEnv(scene);

    var root = new THREE.Group();
    root.name = '__dreambyteEnvRoot';
    var refs = {};
    var state = window.__dreambyteEnvState;
    state.refs = refs;

    if (window.DREAMBYTE_THREE_ENV_IDS.indexOf(envId) === -1) {
      console.warn('applyDreambyteThreeEnvironment: unknown env "' + envId + '" — falling back to studio_white');
      envId = 'studio_white';
    }

    switch (envId) {
      case 'track_rolling_topdown': {
        scene.background = new THREE.Color(0xf1f5f9);
        renderer.setClearColor(0xeef2f6);
        var table = new THREE.Mesh(
          new THREE.PlaneGeometry(30, 18),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.06 }),
        );
        table.rotation.x = -Math.PI / 2;
        table.receiveShadow = true;
        root.add(table);
        var divMat = new THREE.MeshStandardMaterial({ color: 0xd1d9e6, roughness: 0.45, metalness: 0.12 });
        [-2.7, 0, 2.7].forEach(function (dz) {
          var div = new THREE.Mesh(new THREE.BoxGeometry(26, 0.045, 0.07), divMat);
          div.position.set(0, 0.022, dz);
          div.receiveShadow = true;
          root.add(div);
        });
        [-5.35, 5.35].forEach(function (dz) {
          var edge = new THREE.Mesh(
            new THREE.BoxGeometry(26, 0.035, 0.055),
            new THREE.MeshStandardMaterial({ color: 0xb8c5d6, roughness: 0.5, metalness: 0.08 }),
          );
          edge.position.set(0, 0.023, dz);
          root.add(edge);
        });
        function makePatternTex(kind, hexA, hexB) {
          var cnv = document.createElement('canvas');
          cnv.width = 256;
          cnv.height = 128;
          var cx = cnv.getContext('2d');
          cx.fillStyle = hexA;
          cx.fillRect(0, 0, 256, 128);
          cx.fillStyle = hexB;
          if (kind === 0) {
            for (var x = 0; x < 256; x += 32) cx.fillRect(x, 0, 14, 128);
          } else if (kind === 1) {
            for (var y = 0; y < 128; y += 20) cx.fillRect(0, y, 256, 8);
          } else if (kind === 2) {
            var r = 12;
            for (var py = 0; py < 4; py++) {
              for (var px = 0; px < 8; px++) {
                cx.beginPath();
                cx.arc(px * 32 + 16, py * 32 + 16, r, 0, Math.PI * 2);
                cx.fill();
              }
            }
          } else {
            cx.strokeStyle = hexB;
            cx.lineWidth = 6;
            for (var g = 0; g < 10; g++) {
              cx.beginPath();
              cx.moveTo(g * 28, 0);
              cx.lineTo(g * 28 + 80, 128);
              cx.stroke();
            }
          }
          var tex = new THREE.CanvasTexture(cnv);
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(3, 2);
          tex.colorSpace = THREE.SRGBColorSpace;
          return tex;
        }
        var laneZ = [-4.05, -1.35, 1.35, 4.05];
        var dirs = [-1, 1, -1, 1];
        var pals = [
          ['#f8fafc', '#e11d48'],
          ['#fff7ed', '#c2410c'],
          ['#eff6ff', '#2563eb'],
          ['#f0fdf4', '#16a34a'],
        ];
        var span = 25;
        var ballR = 0.5;
        refs.trackBalls = [];
        for (var li = 0; li < 4; li++) {
          for (var bi = 0; bi < 3; bi++) {
            var pk = (li + bi) % 4;
            var tex = makePatternTex(pk, pals[pk][0], pals[pk][1]);
            var bmat = new THREE.MeshStandardMaterial({
              map: tex,
              roughness: 0.32,
              metalness: 0.18,
            });
            var ball = new THREE.Mesh(new THREE.SphereGeometry(ballR, 36, 28), bmat);
            ball.castShadow = true;
            var phase = -12.5 + det(li * 9 + bi, 88) * span;
            ball.position.set(phase, ballR, laneZ[li]);
            root.add(ball);
            var spd = 2.1 + det(li * 7 + bi, 89) * 0.65;
            refs.trackBalls.push({
              mesh: ball,
              dir: dirs[li],
              speed: spd,
              phase: phase,
              r: ballR,
            });
          }
        }
        root.add(new THREE.AmbientLight(0xffffff, 0.42));
        var tKey = new THREE.DirectionalLight(0xffffff, 1.05);
        tKey.position.set(-5, 18, 10);
        tKey.castShadow = true;
        tKey.shadow.mapSize.set(2048, 2048);
        tKey.shadow.camera.near = 2;
        tKey.shadow.camera.far = 32;
        tKey.shadow.camera.left = -16;
        tKey.shadow.camera.right = 16;
        tKey.shadow.camera.top = 16;
        tKey.shadow.camera.bottom = -16;
        tKey.shadow.bias = -0.0004;
        root.add(tKey);
        var tFill = new THREE.DirectionalLight(0xe2e8f0, 0.38);
        tFill.position.set(10, 12, -8);
        root.add(tFill);
        var tRim = new THREE.DirectionalLight(0xfef9c3, 0.22);
        tRim.position.set(0, 8, -12);
        root.add(tRim);
        camera.position.set(0, 17.2, 0.01);
        camera.lookAt(0, 0, 0);
        state.update = function (t) {
          var tt = typeof t === 'number' ? t : 0;
          refs.trackBalls.forEach(function (b) {
            var u = b.phase + tt * b.dir * b.speed + 12.5;
            u = ((u % span) + span) % span;
            b.mesh.position.x = u - 12.5;
            b.mesh.rotation.z = -b.dir * (tt * b.speed / b.r);
          });
        };
        // Self-driving render loop using native RAF (bypasses playback controller
        // interception) so the background always animates continuously.
        var _envStart = Date.now();
        var _nraf = window.__nativeRAF || requestAnimationFrame;
        (function _envLoop() {
          var t = (Date.now() - _envStart) / 1000;
          state.update(t);
          renderer.render(scene, camera);
          _nraf(_envLoop);
        })();
        break;
      }

      case 'studio_white': {
        scene.background = new THREE.Color(0xf7f8fa);
        renderer.setClearColor(0xf7f8fa);
        // Curved cyclorama: huge sphere open at the bottom, soft gradient
        var cycloMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
        var cyclo = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.55), cycloMat);
        cyclo.position.y = -0.5;
        root.add(cyclo);
        var floor = new THREE.Mesh(
          new THREE.CircleGeometry(40, 64),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.02 }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        root.add(floor);
        var hemi = new THREE.HemisphereLight(0xffffff, 0xe8eef5, 0.85);
        root.add(hemi);
        var sKey = new THREE.DirectionalLight(0xffffff, 1.6);
        sKey.position.set(-6, 10, 6);
        sKey.castShadow = true;
        sKey.shadow.mapSize.set(2048, 2048);
        sKey.shadow.camera.left = -12;
        sKey.shadow.camera.right = 12;
        sKey.shadow.camera.top = 12;
        sKey.shadow.camera.bottom = -12;
        sKey.shadow.bias = -0.0005;
        root.add(sKey);
        var sFill = new THREE.DirectionalLight(0xd9e6ff, 0.45);
        sFill.position.set(8, 4, 6);
        root.add(sFill);
        state.update = function () {};
        break;
      }

      case 'cinematic_fog': {
        scene.background = new THREE.Color(0x0a0d12);
        renderer.setClearColor(0x0a0d12);
        scene.fog = new THREE.FogExp2(0x0a0d12, 0.04);
        var cfFloor = new THREE.Mesh(
          new THREE.PlaneGeometry(200, 200),
          new THREE.MeshStandardMaterial({ color: 0x0e131a, roughness: 0.35, metalness: 0.25 }),
        );
        cfFloor.rotation.x = -Math.PI / 2;
        cfFloor.receiveShadow = true;
        root.add(cfFloor);
        root.add(new THREE.AmbientLight(0x222a36, 0.25));
        var cKey = new THREE.SpotLight(0xfff1d6, 4.2, 40, Math.PI / 7, 0.45, 1.2);
        cKey.position.set(-6, 14, 7);
        cKey.target.position.set(0, 0, 0);
        cKey.castShadow = true;
        cKey.shadow.mapSize.set(2048, 2048);
        cKey.shadow.bias = -0.0005;
        root.add(cKey);
        root.add(cKey.target);
        var cRim = new THREE.DirectionalLight(0x6aaeff, 0.9);
        cRim.position.set(2, 3, -8);
        root.add(cRim);
        state.update = function () {};
        break;
      }

      case 'iso_playful': {
        scene.background = new THREE.Color(0xfef3c7);
        renderer.setClearColor(0xfef3c7);
        var ipFloor = new THREE.Mesh(
          new THREE.PlaneGeometry(80, 80),
          new THREE.MeshStandardMaterial({ color: 0xfde68a, roughness: 1.0, metalness: 0 }),
        );
        ipFloor.rotation.x = -Math.PI / 2;
        ipFloor.receiveShadow = true;
        root.add(ipFloor);
        var ipHemi = new THREE.HemisphereLight(0xffffff, 0xfdba74, 0.9);
        root.add(ipHemi);
        var ipKey = new THREE.DirectionalLight(0xfff3c4, 1.1);
        ipKey.position.set(-8, 12, 6);
        ipKey.castShadow = true;
        ipKey.shadow.mapSize.set(1024, 1024);
        ipKey.shadow.camera.left = -12;
        ipKey.shadow.camera.right = 12;
        ipKey.shadow.camera.top = 12;
        ipKey.shadow.camera.bottom = -12;
        ipKey.shadow.bias = -0.0008;
        root.add(ipKey);
        state.update = function () {};
        break;
      }

      case 'tech_grid': {
        scene.background = new THREE.Color(0x030712);
        renderer.setClearColor(0x030712);
        scene.fog = new THREE.FogExp2(0x030712, 0.02);
        // Shader-based grid floor (neon lines, horizon fade)
        var tgGeo = new THREE.PlaneGeometry(200, 200);
        var tgMat = new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(0x22d3ee) },
            uDim:   { value: new THREE.Color(0x0b1622) },
            uFar:   { value: 80 },
          },
          vertexShader: 'varying vec3 wp; void main(){ vec4 w = modelMatrix*vec4(position,1.0); wp=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
          fragmentShader: 'varying vec3 wp; uniform vec3 uColor; uniform vec3 uDim; uniform float uFar; float grid(float s){ vec2 g = abs(fract(wp.xz/s - 0.5) - 0.5)/fwidth(wp.xz/s); float l = min(g.x, g.y); return 1.0 - min(l, 1.0);} void main(){ float g1 = grid(1.0); float g2 = grid(10.0); float d = 1.0 - min(length(wp.xz)/uFar, 1.0); vec3 c = mix(uDim, uColor, max(g1*0.5, g2)); gl_FragColor = vec4(c, max(g1*0.35, g2) * pow(d, 1.4)); if(gl_FragColor.a <= 0.005) discard; }',
          transparent: true,
          side: THREE.DoubleSide,
        });
        var tgFloor = new THREE.Mesh(tgGeo, tgMat);
        tgFloor.rotation.x = -Math.PI / 2;
        tgFloor.frustumCulled = false;
        root.add(tgFloor);
        root.add(new THREE.AmbientLight(0x1a2238, 0.35));
        var tgKey = new THREE.DirectionalLight(0x22d3ee, 1.0);
        tgKey.position.set(-5, 8, 5);
        root.add(tgKey);
        var tgRim = new THREE.DirectionalLight(0xa78bfa, 1.0);
        tgRim.position.set(5, 4, -6);
        root.add(tgRim);
        // Stars
        var sgeo = new THREE.BufferGeometry();
        var sCount = 600;
        var spos = new Float32Array(sCount * 3);
        for (var si = 0; si < sCount; si++) {
          var r = 60 + det(si, 3) * 40;
          var th = det(si, 4) * Math.PI * 2;
          var ph = Math.acos(1 - 2 * det(si, 5));
          spos[si * 3] = r * Math.sin(ph) * Math.cos(th);
          spos[si * 3 + 1] = r * Math.cos(ph) * 0.5 + 8;
          spos[si * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
        var stars = new THREE.Points(sgeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.8 }));
        root.add(stars);
        state.update = function (t) {
          tgMat.uniforms.uColor.value.setHSL(0.52 + 0.03 * Math.sin(t * 0.6), 0.8, 0.55);
        };
        break;
      }

      case 'nature_sunset': {
        // Gradient sky dome
        var nsSkyMat = new THREE.ShaderMaterial({
          side: THREE.BackSide,
          uniforms: {
            top: { value: new THREE.Color(0x1d4ed8) },
            mid: { value: new THREE.Color(0xf97316) },
            bot: { value: new THREE.Color(0xfed7aa) },
          },
          vertexShader: 'varying vec3 wp; void main(){ vec4 w = modelMatrix*vec4(position,1.0); wp=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
          fragmentShader: 'varying vec3 wp; uniform vec3 top; uniform vec3 mid; uniform vec3 bot; void main(){ float h = normalize(wp).y; float a = smoothstep(-0.2, 0.15, h); float b = smoothstep(0.15, 0.6, h); vec3 c = mix(bot, mid, a); c = mix(c, top, b); gl_FragColor = vec4(c, 1.0); }',
        });
        var nsSky = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 20), nsSkyMat);
        root.add(nsSky);
        scene.fog = new THREE.FogExp2(0xfed7aa, 0.015);
        var nsGround = new THREE.Mesh(
          new THREE.PlaneGeometry(200, 200),
          new THREE.MeshStandardMaterial({ color: 0x3f6212, roughness: 0.95, metalness: 0 }),
        );
        nsGround.rotation.x = -Math.PI / 2;
        nsGround.receiveShadow = true;
        root.add(nsGround);
        var nsHemi = new THREE.HemisphereLight(0xfed7aa, 0x3f6212, 0.7);
        root.add(nsHemi);
        var nsSun = new THREE.DirectionalLight(0xfed7aa, 2.2);
        nsSun.position.set(-12, 4, -10);
        nsSun.castShadow = true;
        nsSun.shadow.mapSize.set(2048, 2048);
        nsSun.shadow.bias = -0.0005;
        root.add(nsSun);
        state.update = function () {};
        break;
      }

      case 'data_lab': {
        scene.background = new THREE.Color(0xffffff);
        renderer.setClearColor(0xffffff);
        // Circular shadow-catcher (ShadowMaterial: transparent, receives shadows only)
        var dlShadow = new THREE.Mesh(
          new THREE.CircleGeometry(12, 64),
          new THREE.ShadowMaterial({ opacity: 0.18 }),
        );
        dlShadow.rotation.x = -Math.PI / 2;
        dlShadow.receiveShadow = true;
        root.add(dlShadow);
        root.add(new THREE.HemisphereLight(0xffffff, 0xf1f5f9, 0.7));
        var dlKey = new THREE.DirectionalLight(0xffffff, 1.5);
        dlKey.position.set(-4, 10, 5);
        dlKey.castShadow = true;
        dlKey.shadow.mapSize.set(1024, 1024);
        dlKey.shadow.camera.left = -10;
        dlKey.shadow.camera.right = 10;
        dlKey.shadow.camera.top = 10;
        dlKey.shadow.camera.bottom = -10;
        dlKey.shadow.bias = -0.0005;
        root.add(dlKey);
        state.update = function () {};
        break;
      }

      default:
        console.warn('applyDreambyteThreeEnvironment: unreachable envId', envId);
    }

    scene.add(root);
  };

  window.updateDreambyteThreeEnvironment = function (t) {
    var st = window.__dreambyteEnvState;
    if (st && typeof st.update === 'function') st.update(t || 0);
  };
})();
`

export const THREE_SCATTER_RUNTIME_SCRIPT = `/**
 * 3D data scatter — vanilla Three.js helper inspired by the CorticoAI 3d-react-demo
 * (React + react-three-fiber scatterplot style). Original demo: MIT License —
 * https://github.com/CorticoAI/3d-react-demo
 *
 * Injected in the Three template after stage environments. API:
 *   createDreambyteDataScatterplot(scene, options)
 *   updateDreambyteDataScatterplot(t)
 */
(function initDreambyteDataScatterplot() {
  var THREE = window.THREE;
  if (!THREE) return;

  function disposeGroup(g) {
    if (!g) return;
    g.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
        else obj.material.dispose();
      }
    });
  }

  window.createDreambyteDataScatterplot = function (scene, options) {
    var old = scene.getObjectByName('__dreambyteScatterRoot');
    if (old) {
      disposeGroup(old);
      scene.remove(old);
    }
    window.__dreambyteScatterState = { update: null };

    var opts = options || {};
    var raw = opts.points;
    if (!raw || !raw.length) {
      console.warn('createDreambyteDataScatterplot: no points');
      return;
    }

    var orbitSpeed = typeof opts.orbitSpeed === 'number' ? opts.orbitSpeed : 0.12;
    var pointRadius = typeof opts.pointRadius === 'number' ? opts.pointRadius : 0.14;
    var axisExtent = typeof opts.axisExtent === 'number' ? opts.axisExtent : 7;

    var root = new THREE.Group();
    root.name = '__dreambyteScatterRoot';

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    var i;
    for (i = 0; i < raw.length; i++) {
      var p = raw[i];
      var px = Number(p.x), py = Number(p.y), pz = Number(p.z);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    var cz = (minZ + maxZ) / 2;
    var dx = maxX - minX || 1;
    var dy = maxY - minY || 1;
    var dz = maxZ - minZ || 1;
    var maxSpan = Math.max(dx, dy, dz);
    var scale = (axisExtent * 0.42) / maxSpan;

    var count = raw.length;
    var geo = new THREE.IcosahedronGeometry(pointRadius, 1);
    var mat = new THREE.MeshStandardMaterial({ metalness: 0.25, roughness: 0.45 });
    var mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.castShadow = true;

    var dummy = new THREE.Object3D();
    var col = new THREE.Color();
    var zNorm = 0;
    for (i = 0; i < count; i++) {
      var q = raw[i];
      var x = (Number(q.x) - cx) * scale;
      var y = (Number(q.y) - cy) * scale;
      var z = (Number(q.z) - cz) * scale;
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      zNorm = maxZ > minZ ? (Number(q.z) - minZ) / (maxZ - minZ) : 0.5;
      col.setHSL(0.55 + zNorm * 0.35, 0.75, 0.52);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);

    var ax = axisExtent * 0.5;
    function axisLine(x0, y0, z0, x1, y1, z1, hex) {
      var g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x0, y0, z0),
        new THREE.Vector3(x1, y1, z1),
      ]);
      var m = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.75 });
      return new THREE.Line(g, m);
    }
    root.add(axisLine(0, 0, 0, ax, 0, 0, 0xf87171));
    root.add(axisLine(0, 0, 0, 0, ax, 0, 0x4ade80));
    root.add(axisLine(0, 0, 0, 0, 0, ax, 0x60a5fa));

    var grid = new THREE.GridHelper(axisExtent * 1.2, 14, 0x334155, 0x1e293b);
    grid.position.y = -axisExtent * 0.35;
    root.add(grid);

    root.position.set(0, axisExtent * 0.08, 0);

    scene.add(root);

    window.__dreambyteScatterState = {
      update: function (t) {
        root.rotation.y = t * orbitSpeed;
        root.rotation.x = Math.sin(t * 0.2) * 0.04;
      },
    };
  };

  window.updateDreambyteDataScatterplot = function (t) {
    var st = window.__dreambyteScatterState;
    if (st && typeof st.update === 'function') st.update(t || 0);
  };
})();
`

/**
 * Cookbook helpers — expanded Three.js toolkit (post-fx, lighting rigs, PBR,
 * HDR IBL, instancing, spatial audio, tone-map presets). Inspired by patterns
 * in the public threejs-visual-guide (MIT) but implemented Dreambyte-native with
 * no external deps beyond `three/addons/*` already in the importmap.
 *
 * This script is interpolated into the scene-template module after imports
 * of EffectComposer / RenderPass / UnrealBloomPass / BokehPass / SSAOPass /
 * OutputPass / OutlinePass / FilmPass / GlitchPass / AfterimagePass /
 * ShaderPass / RGBELoader, so those symbols are in lexical scope.
 */
export const THREE_HELPERS_RUNTIME_SCRIPT = `/* Dreambyte three-helpers cookbook */
(function initDreambyteThreeHelpers() {
  var THREE = window.THREE;
  if (!THREE) return;

  // ── Tone-map presets (r183 supports aces, cineon, reinhard, linear, agx, neutral) ──
  window.DREAMBYTE_TONE_MAPS = {
    aces:     THREE.ACESFilmicToneMapping,
    cineon:   THREE.CineonToneMapping,
    reinhard: THREE.ReinhardToneMapping,
    linear:   THREE.LinearToneMapping,
    agx:      typeof THREE.AgXToneMapping !== 'undefined' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping,
    neutral:  typeof THREE.NeutralToneMapping !== 'undefined' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping,
    none:     THREE.NoToneMapping,
  };

  // ── Custom shader passes (inline GLSL, small and cheap) ───────────────────
  function makeChromaticAberrationPass(amount) {
    return new ShaderPass({
      uniforms: { tDiffuse: { value: null }, amount: { value: amount != null ? amount : 0.0035 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv; void main(){ vec2 o = (vUv - 0.5) * amount; float r = texture2D(tDiffuse, vUv + o).r; float g = texture2D(tDiffuse, vUv).g; float b = texture2D(tDiffuse, vUv - o).b; float a = texture2D(tDiffuse, vUv).a; gl_FragColor = vec4(r, g, b, a); }',
    });
  }
  function makeColorGradePass(opts) {
    opts = opts || {};
    return new ShaderPass({
      uniforms: {
        tDiffuse:   { value: null },
        exposure:   { value: opts.exposure != null ? opts.exposure : 1.0 },
        contrast:   { value: opts.contrast != null ? opts.contrast : 1.0 },
        saturation: { value: opts.saturation != null ? opts.saturation : 1.0 },
        brightness: { value: opts.brightness != null ? opts.brightness : 0.0 },
        tint:       { value: new THREE.Color(opts.tint || 0xffffff) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float exposure; uniform float contrast; uniform float saturation; uniform float brightness; uniform vec3 tint; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); c.rgb *= exposure; c.rgb += brightness; c.rgb *= tint; c.rgb = (c.rgb - 0.5) * contrast + 0.5; float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); c.rgb = mix(vec3(l), c.rgb, saturation); gl_FragColor = c; }',
    });
  }
  function makePixelatePass(pixelSize) {
    var ps = pixelSize != null ? pixelSize : 4.0;
    return new ShaderPass({
      uniforms: {
        tDiffuse:  { value: null },
        pixelSize: { value: ps },
        resolution: { value: new THREE.Vector2(window.WIDTH || 1920, window.HEIGHT || 1080) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float pixelSize; uniform vec2 resolution; varying vec2 vUv; void main(){ vec2 grid = resolution / pixelSize; vec2 uv = floor(vUv * grid) / grid; gl_FragColor = texture2D(tDiffuse, uv); }',
    });
  }
  function makeScanlinePass(intensity, density) {
    return new ShaderPass({
      uniforms: {
        tDiffuse:  { value: null },
        intensity: { value: intensity != null ? intensity : 0.25 },
        density:   { value: density != null ? density : 1.8 },
        resolution: { value: new THREE.Vector2(window.WIDTH || 1920, window.HEIGHT || 1080) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; uniform float intensity; uniform float density; uniform vec2 resolution; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float s = sin(vUv.y * resolution.y * density * 3.14159) * 0.5 + 0.5; c.rgb *= 1.0 - intensity * (1.0 - s); gl_FragColor = c; }',
    });
  }

  // ── createDreambytePostFX: one-call, opinionated composer ─────────────────────
  // opts keys: bloom, ssao, outline, dof, filmGrain, chromaticAberration,
  //            colorGrade, pixelate, scanlines, afterimage  — each can be
  //            false, true, or a config object. Returns { composer, render,
  //            passes, dispose }.
  window.createDreambytePostFX = function (renderer, scene, camera, opts) {
    opts = opts || {};
    try {
      var composer = new EffectComposer(renderer);
      composer.setSize(window.WIDTH || 1920, window.HEIGHT || 1080);
      var passes = {};
      composer.addPass(new RenderPass(scene, camera));

      if (opts.ssao) {
        var ss = typeof opts.ssao === 'object' ? opts.ssao : {};
        var ssao = new SSAOPass(scene, camera, window.WIDTH || 1920, window.HEIGHT || 1080);
        if (ss.kernelRadius != null) ssao.kernelRadius = ss.kernelRadius;
        if (ss.minDistance != null) ssao.minDistance = ss.minDistance;
        if (ss.maxDistance != null) ssao.maxDistance = ss.maxDistance;
        composer.addPass(ssao); passes.ssao = ssao;
      }

      if (opts.bloom) {
        var b = typeof opts.bloom === 'object' ? opts.bloom : {};
        var bp = new UnrealBloomPass(
          new THREE.Vector2(window.WIDTH || 1920, window.HEIGHT || 1080),
          b.strength != null ? b.strength : 0.4,
          b.radius != null ? b.radius : 0.4,
          b.threshold != null ? b.threshold : 0.85,
        );
        composer.addPass(bp); passes.bloom = bp;
      }

      if (opts.dof) {
        var d = typeof opts.dof === 'object' ? opts.dof : {};
        var bokeh = new BokehPass(scene, camera, {
          focus: d.focus != null ? d.focus : 10,
          aperture: d.aperture != null ? d.aperture : 0.002,
          maxblur: d.maxblur != null ? d.maxblur : 0.01,
        });
        composer.addPass(bokeh); passes.dof = bokeh;
      }

      if (opts.outline && typeof OutlinePass !== 'undefined') {
        var o = typeof opts.outline === 'object' ? opts.outline : {};
        var out = new OutlinePass(
          new THREE.Vector2(window.WIDTH || 1920, window.HEIGHT || 1080),
          scene, camera,
        );
        out.edgeStrength = o.edgeStrength != null ? o.edgeStrength : 3.0;
        out.edgeGlow = o.edgeGlow != null ? o.edgeGlow : 0.5;
        out.edgeThickness = o.edgeThickness != null ? o.edgeThickness : 1.0;
        if (o.visibleEdgeColor) out.visibleEdgeColor.set(o.visibleEdgeColor);
        if (o.hiddenEdgeColor) out.hiddenEdgeColor.set(o.hiddenEdgeColor);
        if (Array.isArray(o.selectedObjects)) out.selectedObjects = o.selectedObjects;
        composer.addPass(out); passes.outline = out;
      }

      if (opts.afterimage && typeof AfterimagePass !== 'undefined') {
        var ai = typeof opts.afterimage === 'object' ? opts.afterimage : {};
        var after = new AfterimagePass(ai.damp != null ? ai.damp : 0.92);
        composer.addPass(after); passes.afterimage = after;
      }

      if (opts.chromaticAberration) {
        var ca = typeof opts.chromaticAberration === 'object' ? opts.chromaticAberration : {};
        var cap = makeChromaticAberrationPass(ca.amount);
        composer.addPass(cap); passes.chromaticAberration = cap;
      }

      if (opts.colorGrade) {
        var cg = typeof opts.colorGrade === 'object' ? opts.colorGrade : {};
        var cgp = makeColorGradePass(cg);
        composer.addPass(cgp); passes.colorGrade = cgp;
      }

      if (opts.pixelate) {
        var pz = typeof opts.pixelate === 'object' ? opts.pixelate : {};
        var pzp = makePixelatePass(pz.pixelSize);
        composer.addPass(pzp); passes.pixelate = pzp;
      }

      if (opts.scanlines) {
        var sc = typeof opts.scanlines === 'object' ? opts.scanlines : {};
        var scp = makeScanlinePass(sc.intensity, sc.density);
        composer.addPass(scp); passes.scanlines = scp;
      }

      if (opts.filmGrain && typeof FilmPass !== 'undefined') {
        var f = typeof opts.filmGrain === 'object' ? opts.filmGrain : {};
        var fp = new FilmPass(
          f.intensity != null ? f.intensity : 0.35,
          f.grayscale ? 1 : 0,
        );
        composer.addPass(fp); passes.filmGrain = fp;
      }

      if (opts.glitch && typeof GlitchPass !== 'undefined') {
        var g = typeof opts.glitch === 'object' ? opts.glitch : {};
        var gp = new GlitchPass();
        if (g.goWild) gp.goWild = true;
        composer.addPass(gp); passes.glitch = gp;
      }

      composer.addPass(new OutputPass());

      return {
        composer: composer,
        passes: passes,
        render: function () { composer.render(); },
        dispose: function () { composer.passes.forEach(function (p) { if (p.dispose) p.dispose(); }); },
      };
    } catch (e) {
      console.warn('createDreambytePostFX failed, falling back to direct render:', e);
      return { render: function () { renderer.render(scene, camera); }, passes: {} };
    }
  };

  // ── Named presets for createDreambytePostFX ───────────────────────────────────
  window.DREAMBYTE_POSTFX_PRESETS = {
    bloom:     { bloom: { strength: 0.6, radius: 0.5, threshold: 0.8 } },
    cinematic: { bloom: { strength: 0.35, radius: 0.45, threshold: 0.85 }, dof: { focus: 10, aperture: 0.0018, maxblur: 0.012 }, colorGrade: { exposure: 1.05, contrast: 1.08, saturation: 1.05 } },
    cyberpunk: { bloom: { strength: 1.1, radius: 0.8, threshold: 0.55 }, chromaticAberration: { amount: 0.006 }, scanlines: { intensity: 0.22, density: 1.6 }, colorGrade: { saturation: 1.25, contrast: 1.1, tint: 0xffccff } },
    vintage:   { filmGrain: { intensity: 0.45 }, colorGrade: { exposure: 0.95, contrast: 1.08, saturation: 0.75, tint: 0xffe8bf }, chromaticAberration: { amount: 0.002 } },
    dream:     { bloom: { strength: 0.85, radius: 0.9, threshold: 0.4 }, dof: { focus: 8, aperture: 0.003, maxblur: 0.02 }, colorGrade: { exposure: 1.1, saturation: 0.9, brightness: 0.04 } },
    matrix:    { bloom: { strength: 0.65, radius: 0.6, threshold: 0.7 }, scanlines: { intensity: 0.2 }, colorGrade: { tint: 0xa7f3d0, saturation: 1.3, contrast: 1.15 } },
    retroPixel:{ pixelate: { pixelSize: 6 }, colorGrade: { saturation: 1.2, contrast: 1.05 } },
    ghibli:    { bloom: { strength: 0.45, radius: 0.7, threshold: 0.75 }, colorGrade: { exposure: 1.05, saturation: 1.12, tint: 0xfff4d6 } },
    noir:      { filmGrain: { intensity: 0.45, grayscale: true }, colorGrade: { saturation: 0.05, contrast: 1.25 }, bloom: { strength: 0.2, radius: 0.3, threshold: 0.9 } },
    sharpCorporate: { ssao: { kernelRadius: 6, minDistance: 0.003, maxDistance: 0.08 }, colorGrade: { contrast: 1.04, exposure: 1.02 } },
  };

  window.createDreambytePostFXPreset = function (renderer, scene, camera, presetName, overrides) {
    var base = window.DREAMBYTE_POSTFX_PRESETS[presetName];
    if (!base) {
      console.warn('createDreambytePostFXPreset: unknown preset "' + presetName + '"');
      base = window.DREAMBYTE_POSTFX_PRESETS.bloom;
    }
    var merged = Object.assign({}, base, overrides || {});
    return window.createDreambytePostFX(renderer, scene, camera, merged);
  };

  // ── addCinematicLighting: tuned 3-point (or 4-point) rig by style ─────────
  window.addCinematicLighting = function (scene, style, opts) {
    style = style || 'corporate';
    opts = opts || {};
    var group = new THREE.Group();
    group.name = '__dreambyteLightingRig';
    var cfgs = {
      corporate: { amb: [0xffffff, 0.4], key: [0xfff6e0, 1.5, [-5,8,5]],  fill: [0xd0e8ff, 0.5, [6,2,4]],  rim: [0xffe0d0, 0.7, [0,4,-9]] },
      dramatic:  { amb: [0x222233, 0.2], key: [0xffefd5, 2.8, [-6,10,6]], fill: [0x3355aa, 0.25, [8,2,4]], rim: [0xff7a40, 1.4, [2,3,-10]] },
      playful:   { amb: [0xfff0c4, 0.55], key: [0xffd6a5, 1.4, [-5,10,4]], fill: [0xbae6fd, 0.65, [7,3,5]], rim: [0xfca5a5, 0.6, [0,5,-8]] },
      product:   { amb: [0xffffff, 0.3], key: [0xffffff, 1.6, [-5,9,5]],  fill: [0xffffff, 0.7, [6,3,4]],  rim: [0xffffff, 1.0, [0,5,-8]] },
      cyberpunk: { amb: [0x1a1a2e, 0.25], key: [0x22d3ee, 1.5, [-6,6,6]], fill: [0xa78bfa, 1.0, [6,3,4]],  rim: [0xf472b6, 1.4, [0,4,-9]] },
      nature:    { amb: [0xe6edf5, 0.5], key: [0xfed7aa, 1.8, [-8,8,-4]], fill: [0xbae6fd, 0.5, [7,4,5]],  rim: [0xfcd34d, 0.65, [-2,2,-9]] },
      softbox:   { amb: [0xffffff, 0.6], key: [0xffffff, 0.85, [-4,6,5]], fill: [0xffffff, 0.75, [5,3,4]], rim: [0xffffff, 0.5, [0,3,-8]] },
    };
    var c = cfgs[style] || cfgs.corporate;
    var amb = new THREE.AmbientLight(c.amb[0], c.amb[1]);
    group.add(amb);
    function dir(cfg, cast) {
      var l = new THREE.DirectionalLight(cfg[0], cfg[1]);
      l.position.set(cfg[2][0], cfg[2][1], cfg[2][2]);
      if (cast) {
        l.castShadow = true;
        l.shadow.mapSize.set(2048, 2048);
        l.shadow.camera.left = -12; l.shadow.camera.right = 12;
        l.shadow.camera.top = 12; l.shadow.camera.bottom = -12;
        l.shadow.bias = -0.0005;
      }
      return l;
    }
    var key = dir(c.key, opts.shadows !== false);
    var fill = dir(c.fill, false);
    var rim = dir(c.rim, false);
    group.add(key); group.add(fill); group.add(rim);
    if (opts.hemisphere) {
      var h = new THREE.HemisphereLight(opts.hemisphere[0] || 0xffffff, opts.hemisphere[1] || 0x202030, opts.hemisphere[2] != null ? opts.hemisphere[2] : 0.4);
      group.add(h);
    }
    group.__refs = { ambient: amb, key: key, fill: fill, rim: rim };
    scene.add(group);
    return group;
  };

  // ── addGroundPlane: shadow-catcher, infinite, circle-fade, or grid ────────
  window.addGroundPlane = function (scene, opts) {
    opts = opts || {};
    var mode = opts.mode || 'infinite';
    var y = opts.y != null ? opts.y : 0;
    var color = opts.color || 0xf3f4f6;
    var mesh;
    if (mode === 'shadow') {
      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(opts.size || 200, opts.size || 200),
        new THREE.ShadowMaterial({ opacity: opts.opacity != null ? opts.opacity : 0.25 }),
      );
    } else if (mode === 'circle') {
      mesh = new THREE.Mesh(
        new THREE.CircleGeometry(opts.radius || 20, 64),
        new THREE.MeshStandardMaterial({ color: color, roughness: opts.roughness != null ? opts.roughness : 0.9, metalness: opts.metalness != null ? opts.metalness : 0 }),
      );
    } else {
      mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(opts.size || 200, opts.size || 200),
        new THREE.MeshStandardMaterial({ color: color, roughness: opts.roughness != null ? opts.roughness : 0.9, metalness: opts.metalness != null ? opts.metalness : 0 }),
      );
    }
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    mesh.receiveShadow = opts.receiveShadow !== false;
    scene.add(mesh);
    return mesh;
  };

  // ── loadPBRSet: diffuse+normal+roughness+metalness+ao → MeshStandardMaterial
  window.loadPBRSet = function (urlPrefix, opts) {
    opts = opts || {};
    var loader = new THREE.TextureLoader();
    function tex(suffix, colorSpace, repeat) {
      var t = loader.load(urlPrefix + '_' + suffix + '.' + (opts.ext || 'jpg'));
      if (colorSpace) t.colorSpace = colorSpace;
      t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
      if (repeat) t.repeat.set(repeat, repeat);
      return t;
    }
    var r = opts.repeat != null ? opts.repeat : 1;
    var MatCtor = opts.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    var mat = new MatCtor({
      map: tex('diffuse', THREE.SRGBColorSpace, r),
      normalMap: tex('normal', null, r),
      roughnessMap: tex('roughness', null, r),
      metalnessMap: tex('metalness', null, r),
      aoMap: tex('ao', null, r),
      roughness: opts.roughness != null ? opts.roughness : 1.0,
      metalness: opts.metalness != null ? opts.metalness : 1.0,
    });
    if (opts.clearcoat != null && opts.physical) mat.clearcoat = opts.clearcoat;
    if (opts.transmission != null && opts.physical) mat.transmission = opts.transmission;
    if (opts.normalScale) mat.normalScale.set(opts.normalScale, opts.normalScale);
    return mat;
  };

  // ── loadHDREnvironment: equirect HDR → scene.environment via PMREM ───────
  window.loadHDREnvironment = function (url, scene, renderer, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (typeof RGBELoader === 'undefined') {
        console.warn('loadHDREnvironment: RGBELoader not available; using synthetic fallback');
        if (typeof window.setupEnvironment === 'function') window.setupEnvironment(scene, renderer);
        return resolve(null);
      }
      new RGBELoader().load(url, function (hdr) {
        try {
          var pmrem = new THREE.PMREMGenerator(renderer);
          hdr.mapping = THREE.EquirectangularReflectionMapping;
          var envMap = pmrem.fromEquirectangular(hdr).texture;
          scene.environment = envMap;
          if (opts.background) scene.background = envMap;
          hdr.dispose();
          pmrem.dispose();
          resolve(envMap);
        } catch (e) {
          reject(e);
        }
      }, undefined, reject);
    });
  };

  // ── createInstancedField: layouts = grid | circle | sphere | jitter ───────
  window.createInstancedField = function (opts) {
    opts = opts || {};
    var geometry = opts.geometry || new THREE.SphereGeometry(0.25, 16, 12);
    var material = opts.material || new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.1 });
    var count = opts.count || 64;
    var seed = opts.seed || 42;
    var rng = window.mulberry32 ? window.mulberry32(seed) : Math.random;
    var layout = opts.layout || 'grid';
    var mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = !!opts.receiveShadow;
    var dummy = new THREE.Object3D();
    for (var i = 0; i < count; i++) {
      switch (layout) {
        case 'grid': {
          var side = Math.ceil(Math.sqrt(count));
          var sp = opts.spacing || 1.4;
          var gx = (i % side) - (side - 1) / 2;
          var gz = Math.floor(i / side) - (side - 1) / 2;
          dummy.position.set(gx * sp, 0, gz * sp);
          break;
        }
        case 'circle': {
          var rad = opts.radius || 5;
          var th = (i / count) * Math.PI * 2;
          dummy.position.set(Math.cos(th) * rad, 0, Math.sin(th) * rad);
          break;
        }
        case 'sphere': {
          var rs = opts.radius || 5;
          var phi = Math.acos(1 - 2 * (i + 0.5) / count);
          var th2 = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);
          dummy.position.set(
            rs * Math.sin(phi) * Math.cos(th2),
            rs * Math.cos(phi),
            rs * Math.sin(phi) * Math.sin(th2),
          );
          break;
        }
        case 'jitter': {
          var bx = opts.box || [10, 10, 10];
          if (typeof bx === 'number') bx = [bx, bx, bx];
          dummy.position.set((rng() - 0.5) * bx[0], (rng() - 0.5) * bx[1], (rng() - 0.5) * bx[2]);
          break;
        }
      }
      if (opts.randomRotation) dummy.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
      if (opts.randomScale) {
        var sr = opts.scaleRange || [0.75, 1.25];
        dummy.scale.setScalar(sr[0] + rng() * (sr[1] - sr[0]));
      }
      if (typeof opts.transform === 'function') opts.transform(dummy, i, rng);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (typeof opts.color === 'function' && mesh.setColorAt) {
        var col = opts.color(i, rng);
        if (col) mesh.setColorAt(i, col instanceof THREE.Color ? col : new THREE.Color(col));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  };

  // ── createPositionalAudio: AudioListener on camera + PositionalAudio ──────
  window.createPositionalAudio = function (camera, url, opts) {
    opts = opts || {};
    if (!camera) return null;
    if (!camera.__dreambyteAudioListener) {
      camera.__dreambyteAudioListener = new THREE.AudioListener();
      camera.add(camera.__dreambyteAudioListener);
    }
    var audio = new THREE.PositionalAudio(camera.__dreambyteAudioListener);
    var loader = new THREE.AudioLoader();
    loader.load(url, function (buf) {
      audio.setBuffer(buf);
      audio.setRefDistance(opts.refDistance != null ? opts.refDistance : 1);
      audio.setRolloffFactor(opts.rolloffFactor != null ? opts.rolloffFactor : 1);
      audio.setVolume(opts.volume != null ? opts.volume : 0.5);
      audio.setLoop(opts.loop !== false);
      if (opts.autoplay !== false) {
        try { audio.play(); } catch (e) { /* autoplay blocked — caller should trigger on user gesture */ }
      }
    });
    return audio;
  };
})();
`
