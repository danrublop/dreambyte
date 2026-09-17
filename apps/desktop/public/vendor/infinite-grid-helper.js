/**
 * InfiniteGridHelper — shader-based infinite grid plane for Three.js r160+.
 * Based on THREE.InfiniteGridHelper (Fyrestar, MIT License).
 * https://github.com/Fyrestar/THREE.InfiniteGridHelper
 *
 * Exposes window.InfiniteGridHelper (constructor).
 *
 * Usage:
 *   const grid = new InfiniteGridHelper(10, 100, '#cccccc', 8000)
 *   grid.position.y = -2.5
 *   scene.add(grid)
 *
 * Args:
 *   size1    — minor grid line spacing  (default 10)
 *   size2    — major grid line spacing  (default 100)
 *   color    — grid line color, any THREE.Color-compatible value (default '#aaaaaa')
 *   distance — fade-out distance in world units (default 8000)
 *   axes     — floor orientation: 'xzy' = horizontal, 'xyz' = vertical (default 'xzy')
 */
(function () {
  if (typeof window === 'undefined') return;

  var vertexShader = [
    'varying vec3 worldPosition;',
    'uniform float uDistance;',
    'void main() {',
    '  vec3 pos = position.xzy * uDistance;',
    '  pos.xz += cameraPosition.xz;',
    '  worldPosition = pos;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);',
    '}',
  ].join('\n');

  var fragmentShader = [
    'varying vec3 worldPosition;',
    'uniform float uSize1;',
    'uniform float uSize2;',
    'uniform vec3 uColor;',
    'uniform float uDistance;',
    '',
    'float getGrid(float size) {',
    '  vec2 r = worldPosition.xz / size;',
    '  vec2 grid = abs(fract(r - 0.5) - 0.5) / fwidth(r);',
    '  float line = min(grid.x, grid.y);',
    '  return 1.0 - min(line, 1.0);',
    '}',
    '',
    'void main() {',
    '  float d = 1.0 - min(distance(cameraPosition.xz, worldPosition.xz) / uDistance, 1.0);',
    '  float g1 = getGrid(uSize1);',
    '  float g2 = getGrid(uSize2);',
    '  gl_FragColor = vec4(uColor.rgb, mix(g2, g1, g1) * pow(d, 3.0));',
    '  gl_FragColor.a = mix(0.5 * gl_FragColor.a, gl_FragColor.a, g2);',
    '  if (gl_FragColor.a <= 0.0) discard;',
    '}',
  ].join('\n');

  function InfiniteGridHelper(size1, size2, color, distance) {
    var T = window.THREE;
    if (!T) { console.warn('InfiniteGridHelper: window.THREE not found'); return {}; }

    size1 = size1 !== undefined ? size1 : 10;
    size2 = size2 !== undefined ? size2 : 100;
    var gridColor = new T.Color(color !== undefined ? color : '#aaaaaa');
    distance = distance !== undefined ? distance : 8000;

    var geo = new T.PlaneGeometry(2, 2, 1, 1);
    var mat = new T.ShaderMaterial({
      side: T.DoubleSide,
      transparent: true,
      depthWrite: false,
      extensions: { derivatives: true },
      uniforms: {
        uSize1:    { value: size1 },
        uSize2:    { value: size2 },
        uColor:    { value: gridColor },
        uDistance: { value: distance },
      },
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
    });

    var mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;

    // Public API
    mesh.setColor = function (c) { mat.uniforms.uColor.value.set(c); };
    mesh.setSpacing = function (s1, s2) {
      mat.uniforms.uSize1.value = s1;
      if (s2 !== undefined) mat.uniforms.uSize2.value = s2;
    };
    mesh.setDistance = function (d) { mat.uniforms.uDistance.value = d; };

    return mesh;
  }

  window.InfiniteGridHelper = InfiniteGridHelper;
})();
