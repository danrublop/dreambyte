/**
 * Inlined Canvas2D Drawing Engine — for injection into scene HTML.
 *
 * This module exports a single string of JavaScript that can be embedded
 * directly in a <script> tag. It contains all drawing functions as globals,
 * with no imports, no exports, and no external dependencies.
 *
 * Keep in sync with index.ts.
 */

export const CANVAS_RENDERER_CODE: string = `
// ── Dreambyte Canvas2D Drawing Engine ─────────────────────────────────────
// Auto-injected by the scene template. All functions are global.

// ── Drawing Tool Configurations ───────────────────────────────────────────────

var DRAWING_TOOLS = {
  marker: {
    id: 'marker',
    name: 'Marker',
    description: 'Broad, consistent strokes with slight wobble. Bold and readable.',
    roughness: 0.6,
    bowing: 0.4,
    defaultWidth: 6,
    pressureProfile: { peakAt: 0.35, minWidth: 0.55, sharpness: 1.8 },
    alphaJitter: 0.04,
    textureStyle: 'none',
    textureIntensity: 0,
    smoothIterations: 1,
    lineDash: [],
    lineCap: 'round',
  },
  pen: {
    id: 'pen',
    name: 'Pen',
    description: 'Fine, precise strokes with natural hand-drawn character.',
    roughness: 0.4,
    bowing: 0.25,
    defaultWidth: 2.5,
    pressureProfile: { peakAt: 0.4, minWidth: 0.25, sharpness: 2.5 },
    alphaJitter: 0.02,
    textureStyle: 'none',
    textureIntensity: 0,
    smoothIterations: 2,
    lineDash: [],
    lineCap: 'round',
  },
  chalk: {
    id: 'chalk',
    name: 'Chalk',
    description: 'Rough, textured strokes with grain — perfect for chalkboard scenes.',
    roughness: 1.8,
    bowing: 0.6,
    defaultWidth: 8,
    pressureProfile: { peakAt: 0.5, minWidth: 0.3, sharpness: 1.4 },
    alphaJitter: 0.18,
    textureStyle: 'chalk',
    textureIntensity: 0.6,
    smoothIterations: 0,
    lineDash: [],
    lineCap: 'round',
  },
  brush: {
    id: 'brush',
    name: 'Brush',
    description: 'Wide, tapered brush strokes with strong pressure variation.',
    roughness: 0.9,
    bowing: 0.5,
    defaultWidth: 14,
    pressureProfile: { peakAt: 0.3, minWidth: 0.08, sharpness: 3.2 },
    alphaJitter: 0.08,
    textureStyle: 'grain',
    textureIntensity: 0.3,
    smoothIterations: 3,
    lineDash: [],
    lineCap: 'round',
  },
  highlighter: {
    id: 'highlighter',
    name: 'Highlighter',
    description: 'Broad, semi-transparent strokes for emphasis.',
    roughness: 0.3,
    bowing: 0.15,
    defaultWidth: 18,
    pressureProfile: { peakAt: 0.5, minWidth: 0.7, sharpness: 1.2 },
    alphaJitter: 0.03,
    textureStyle: 'none',
    textureIntensity: 0,
    smoothIterations: 2,
    lineDash: [],
    lineCap: 'square',
  },
};

// ── Seeded PRNG ───────────────────────────────────────────────────────────────

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pressure Curve ────────────────────────────────────────────────────────────

function strokePressure(t, opts) {
  opts = opts || {};
  var peakAt = opts.peakAt !== undefined ? opts.peakAt : 0.4;
  var minWidth = opts.minWidth !== undefined ? opts.minWidth : 0.25;
  var sharpness = opts.sharpness !== undefined ? opts.sharpness : 2.5;

  var distFromPeak = Math.abs(t - peakAt);
  var maxDist = Math.max(peakAt, 1 - peakAt);
  var normalized = Math.min(distFromPeak / maxDist, 1);
  var pressure = 1 - (1 - minWidth) * Math.pow(normalized, sharpness);
  return Math.max(minWidth, Math.min(1, pressure));
}

// ── Alpha Jitter ──────────────────────────────────────────────────────────────

function jitteredAlpha(baseAlpha, t, rand, intensity) {
  if (intensity <= 0) return baseAlpha;
  var jitter = (rand() - 0.5) * 2 * intensity;
  return Math.max(0.1, Math.min(1, baseAlpha + jitter));
}

// ── Pressure-Sensitive Stroke ─────────────────────────────────────────────────

function drawSegmentWithPressure(ctx, points, baseWidth, color, pressureOpts, rand, alphaJitter) {
  if (points.length < 2) return;
  pressureOpts = pressureOpts || {};
  alphaJitter = alphaJitter || 0;

  var total = points.length - 1;

  for (var i = 0; i < total; i++) {
    var t = i / Math.max(total - 1, 1);
    var tNext = (i + 1) / Math.max(total - 1, 1);

    var widthMid = strokePressure((t + tNext) / 2, pressureOpts) * baseWidth;
    var alpha = jitteredAlpha(1, t, rand, alphaJitter);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = widthMid;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[i][0], points[i][1]);
    ctx.lineTo(points[i + 1][0], points[i + 1][1]);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Path Smoothing ────────────────────────────────────────────────────────────

function chaikinSmooth(points, iterations, ratio, closed) {
  if (iterations === undefined) iterations = 2;
  if (ratio === undefined) ratio = 0.25;
  if (closed === undefined) closed = false;

  if (points.length < 3 || iterations <= 0) return points.slice(); // fresh array — don't alias input

  var pts = points.slice();

  for (var iter = 0; iter < iterations; iter++) {
    var newPts = [];
    var len = closed ? pts.length : pts.length - 1;

    if (!closed) {
      newPts.push(pts[0]);
    }

    for (var i = 0; i < len; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % pts.length];

      var q = [
        a[0] + ratio * (b[0] - a[0]),
        a[1] + ratio * (b[1] - a[1]),
      ];
      var r = [
        b[0] - ratio * (b[0] - a[0]),
        b[1] - ratio * (b[1] - a[1]),
      ];

      newPts.push(q, r);
    }

    if (!closed) {
      newPts.push(pts[pts.length - 1]);
    }

    pts = newPts;
  }

  return pts;
}

// ── Tool Resolution ───────────────────────────────────────────────────────────

function applyTool(opts) {
  opts = opts || {};
  var toolId = opts.tool || 'pen';
  var toolConfig = DRAWING_TOOLS[toolId] || DRAWING_TOOLS['pen'];

  return {
    color: opts.color || '#000000',
    width: opts.width !== undefined ? opts.width : toolConfig.defaultWidth,
    roughness: opts.roughness !== undefined ? opts.roughness : toolConfig.roughness,
    bowing: opts.bowing !== undefined ? opts.bowing : (toolConfig.bowing || 0.4),
    seed: opts.seed !== undefined ? opts.seed : 42,
    fill: opts.fill !== undefined ? opts.fill : null,
    fillAlpha: opts.fillAlpha !== undefined ? opts.fillAlpha : 0.15,
    tool: toolId,
    pressureOpts: opts.pressureOpts || toolConfig.pressureProfile,
    alphaJitter: opts.alphaJitter !== undefined ? opts.alphaJitter : (toolConfig.alphaJitter || 0),
    smooth: opts.smooth !== undefined ? opts.smooth : (toolConfig.smoothIterations > 0),
    smoothIterations: opts.smoothIterations !== undefined ? opts.smoothIterations : toolConfig.smoothIterations,
    lineDash: opts.lineDash || (toolConfig.lineDash || []),
    lineCap: opts.lineCap || (toolConfig.lineCap || 'round'),
    toolConfig: toolConfig,
  };
}

// ── Texture Cache ─────────────────────────────────────────────────────────────

var _textureCache = {};

function generateTextureCanvas(width, height, seed, opts) {
  var style = opts.style || 'none';
  if (style === 'none') return null;

  var intensity = opts.intensity !== undefined ? opts.intensity : 0.3;
  var rand = mulberry32(seed);

  var offscreen;
  try {
    offscreen = new OffscreenCanvas(width, height);
  } catch (e) {
    offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
  }

  var octx = offscreen.getContext('2d');
  if (!octx) return null; // headless/export can yield a null 2D context
  var imageData = octx.createImageData(width, height);
  var data = imageData.data;

  for (var i = 0; i < data.length; i += 4) {
    var noiseVal = 0;

    if (style === 'grain') {
      noiseVal = rand() * intensity;
    } else if (style === 'paper') {
      var coarse = rand() * 0.6;
      var fine = rand() * 0.4;
      noiseVal = (coarse + fine) * intensity * 0.5;
    } else if (style === 'chalk') {
      var v = rand();
      noiseVal = v < 0.12 ? v * intensity * 2 : 0;
    }

    var luminance = Math.floor(noiseVal * 255);
    data[i] = luminance;
    data[i + 1] = luminance;
    data[i + 2] = luminance;
    data[i + 3] = Math.floor(intensity * 60);
  }

  octx.putImageData(imageData, 0, 0);
  return offscreen;
}

function applyTextureOverlay(targetCanvas, textureStyle, seed) {
  if (textureStyle === 'none') return;

  var key = textureStyle + ':' + seed + ':' + targetCanvas.width + ':' + targetCanvas.height;

  var texture;
  if (_textureCache[key]) {
    texture = _textureCache[key];
  } else {
    var toolEntry = DRAWING_TOOLS[textureStyle];
    var intensity = toolEntry ? toolEntry.textureIntensity : 0.3;
    texture = generateTextureCanvas(targetCanvas.width, targetCanvas.height, seed, {
      style: textureStyle,
      intensity: intensity,
    });
    _textureCache[key] = texture;
  }

  if (!texture) return;

  var ctx = targetCanvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}

// ── Internal: Hand-drawn Point Generation ─────────────────────────────────────

function _wobbleLine(x1, y1, x2, y2, roughness, bowing, numPoints, rand) {
  var pts = [];
  var dx = x2 - x1;
  var dy = y2 - y1;
  var len = Math.sqrt(dx * dx + dy * dy);

  var perpX = -dy / len;
  var perpY = dx / len;

  var bowAmount = bowing * len * 0.06;

  for (var i = 0; i <= numPoints; i++) {
    var t = i / numPoints;
    var bx = x1 + t * dx;
    var by = y1 + t * dy;

    var bowFactor = 4 * t * (1 - t) * bowAmount;
    var wobbleMag = roughness * Math.max(1, len * 0.008);
    var wx = (rand() - 0.5) * 2 * wobbleMag;
    var wy = (rand() - 0.5) * 2 * wobbleMag;

    pts.push([
      bx + perpX * bowFactor + wx,
      by + perpY * bowFactor + wy,
    ]);
  }

  return pts;
}

function _wobbleCircle(cx, cy, radius, roughness, numPoints, rand) {
  var pts = [];
  for (var i = 0; i <= numPoints; i++) {
    var angle = (i / numPoints) * Math.PI * 2;
    var wobbleMag = roughness * Math.max(1, radius * 0.04);
    var r = radius + (rand() - 0.5) * 2 * wobbleMag;
    pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return pts;
}

// ── Internal: Animated Point Rendering ───────────────────────────────────────

function _animatePoints(ctx, allPoints, baseWidth, color, pressureOpts, rand, alphaJitter, duration, lineDash, lineCap) {
  lineDash = lineDash || [];
  lineCap = lineCap || 'round';

  return new Promise(function (resolve) {
    var total = allPoints.length;
    if (total < 2) { resolve(); return; }

    var startTime = performance.now();
    var drawnUpTo = 0;

    function frame() {
      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var targetIndex = Math.floor(progress * (total - 1)) + 1;

      if (targetIndex > drawnUpTo) {
        var segStart = Math.max(0, drawnUpTo - 1);
        var segPoints = allPoints.slice(segStart, targetIndex + 1);

        ctx.save();
        ctx.setLineDash(lineDash);
        ctx.lineCap = lineCap;

        for (var i = 0; i < segPoints.length - 1; i++) {
          var globalT = (segStart + i) / Math.max(total - 2, 1);
          var globalTNext = (segStart + i + 1) / Math.max(total - 2, 1);
          var widthMid = strokePressure((globalT + globalTNext) / 2, pressureOpts) * baseWidth;
          var alpha = jitteredAlpha(1, globalT, rand, alphaJitter);

          ctx.globalAlpha = alpha;
          ctx.lineWidth = widthMid;
          ctx.strokeStyle = color;
          ctx.lineCap = lineCap;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(segPoints[i][0], segPoints[i][1]);
          ctx.lineTo(segPoints[i + 1][0], segPoints[i + 1][1]);
          ctx.stroke();
        }

        ctx.restore();
        drawnUpTo = targetIndex;
      }

      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(frame);
  });
}

// ── Simple Delay ──────────────────────────────────────────────────────────────

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ── Drawing Primitives ────────────────────────────────────────────────────────

function animateRoughLine(ctx, x1, y1, x2, y2, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 600;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);
  var len = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  var numPoints = Math.max(8, Math.floor(len / 6));

  var points = _wobbleLine(x1, y1, x2, y2, resolved.roughness, resolved.toolConfig.bowing, numPoints, rand);

  if (resolved.smooth && resolved.smoothIterations > 0) {
    points = chaikinSmooth(points, resolved.smoothIterations);
  }

  return _animatePoints(
    ctx, points, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    duration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  );
}

function animateRoughCircle(ctx, cx, cy, diameter, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 800;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);
  var radius = diameter / 2;
  var numPoints = Math.max(32, Math.floor(radius * 0.5));

  var points = _wobbleCircle(cx, cy, radius, resolved.roughness, numPoints, rand);

  if (resolved.smooth && resolved.smoothIterations > 0) {
    points = chaikinSmooth(points, resolved.smoothIterations, 0.25, true);
  }

  if (resolved.fill) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (var i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = resolved.fill;
    ctx.globalAlpha = resolved.fillAlpha;
    ctx.fill();
    ctx.restore();
  }

  return _animatePoints(
    ctx, points, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    duration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  );
}

function animateRoughRect(ctx, x, y, w, h, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 700;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);

  var corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
  ];

  var allPoints = [];
  var edgeSeed = mulberry32(resolved.seed + 1);

  for (var i = 0; i < corners.length - 1; i++) {
    var ax = corners[i][0], ay = corners[i][1];
    var bx = corners[i + 1][0], by = corners[i + 1][1];
    var edgeLen = Math.sqrt(Math.pow(bx - ax, 2) + Math.pow(by - ay, 2));
    var numPoints = Math.max(4, Math.floor(edgeLen / 8));

    var edgePoints = _wobbleLine(ax, ay, bx, by, resolved.roughness, resolved.toolConfig.bowing * 0.4, numPoints, edgeSeed);

    if (allPoints.length > 0) {
      allPoints = allPoints.concat(edgePoints.slice(1));
    } else {
      allPoints = edgePoints;
    }
  }

  if (resolved.smooth && resolved.smoothIterations > 0) {
    allPoints = chaikinSmooth(allPoints, Math.max(1, resolved.smoothIterations - 1));
  }

  if (resolved.fill) {
    ctx.save();
    ctx.fillStyle = resolved.fill;
    ctx.globalAlpha = resolved.fillAlpha;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  return _animatePoints(
    ctx, allPoints, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    duration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  );
}

function animateRoughPolygon(ctx, points, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 900;

  if (points.length < 3) return Promise.resolve();

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);

  var closed = points.concat([points[0]]);
  var allPoints = [];
  var edgeSeed = mulberry32(resolved.seed + 7);

  for (var i = 0; i < closed.length - 1; i++) {
    var ax = closed[i][0], ay = closed[i][1];
    var bx = closed[i + 1][0], by = closed[i + 1][1];
    var edgeLen = Math.sqrt(Math.pow(bx - ax, 2) + Math.pow(by - ay, 2));
    var numPts = Math.max(3, Math.floor(edgeLen / 8));

    var edgePoints = _wobbleLine(ax, ay, bx, by, resolved.roughness, resolved.toolConfig.bowing * 0.3, numPts, edgeSeed);

    if (allPoints.length > 0) {
      allPoints = allPoints.concat(edgePoints.slice(1));
    } else {
      allPoints = edgePoints;
    }
  }

  if (resolved.smooth && resolved.smoothIterations > 0) {
    allPoints = chaikinSmooth(allPoints, resolved.smoothIterations, 0.25, true);
  }

  if (resolved.fill) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (var j = 1; j < points.length; j++) {
      ctx.lineTo(points[j][0], points[j][1]);
    }
    ctx.closePath();
    ctx.fillStyle = resolved.fill;
    ctx.globalAlpha = resolved.fillAlpha;
    ctx.fill();
    ctx.restore();
  }

  return _animatePoints(
    ctx, allPoints, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    duration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  );
}

function animateRoughCurve(ctx, points, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 700;

  if (points.length < 2) return Promise.resolve();

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);

  var iterations = Math.max(2, resolved.smoothIterations + 1);
  var smoothed = chaikinSmooth(points, iterations);

  var wobbled = smoothed.map(function (p) {
    var wobbleMag = resolved.roughness * 3;
    return [
      p[0] + (rand() - 0.5) * wobbleMag,
      p[1] + (rand() - 0.5) * wobbleMag,
    ];
  });

  return _animatePoints(
    ctx, wobbled, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    duration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  );
}

function animateRoughArrow(ctx, x1, y1, x2, y2, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 700;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);

  var shaftDuration = duration * 0.8;
  var headDuration = duration * 0.2;

  var len = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  var numPoints = Math.max(8, Math.floor(len / 6));

  var shaftPoints = _wobbleLine(x1, y1, x2, y2, resolved.roughness, resolved.toolConfig.bowing, numPoints, rand);

  if (resolved.smooth && resolved.smoothIterations > 0) {
    shaftPoints = chaikinSmooth(shaftPoints, resolved.smoothIterations);
  }

  return _animatePoints(
    ctx, shaftPoints, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    resolved.toolConfig.alphaJitter,
    shaftDuration,
    resolved.toolConfig.lineDash,
    resolved.toolConfig.lineCap
  ).then(function () {
    var headRand = mulberry32(resolved.seed + 100);
    var angle = Math.atan2(y2 - y1, x2 - x1);
    var headSize = Math.max(12, resolved.width * 3.5);
    var spread = Math.PI / 6;

    var leftX = x2 - Math.cos(angle - spread) * headSize;
    var leftY = y2 - Math.sin(angle - spread) * headSize;
    var rightX = x2 - Math.cos(angle + spread) * headSize;
    var rightY = y2 - Math.sin(angle + spread) * headSize;

    var leftPoints = _wobbleLine(x2, y2, leftX, leftY, resolved.roughness * 0.8, 0, 4, headRand);
    var rightPoints = _wobbleLine(x2, y2, rightX, rightY, resolved.roughness * 0.8, 0, 4, headRand);
    var headPoints = leftPoints.concat(rightPoints.slice(1));

    var headPressure = Object.assign({}, resolved.pressureOpts, { minWidth: 0.5 });

    return _animatePoints(
      ctx, headPoints, resolved.width, resolved.color,
      headPressure, headRand,
      resolved.toolConfig.alphaJitter,
      headDuration,
      [],
      'round'
    );
  });
}

function animateLine(ctx, x1, y1, x2, y2, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 500;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);
  var len = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  var numPoints = Math.max(8, Math.floor(len / 4));

  var points = [];
  for (var i = 0; i <= numPoints; i++) {
    var t = i / numPoints;
    points.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
  }

  return _animatePoints(ctx, points, resolved.width, resolved.color, resolved.pressureOpts, rand, 0, duration, [], 'round');
}

function animateCircle(ctx, cx, cy, r, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 600;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);
  var numPoints = Math.max(32, Math.floor(r * 0.5));

  var points = [];
  for (var i = 0; i <= numPoints; i++) {
    var angle = (i / numPoints) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }

  if (resolved.fill) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = resolved.fill;
    ctx.globalAlpha = resolved.fillAlpha;
    ctx.fill();
    ctx.restore();
  }

  return _animatePoints(ctx, points, resolved.width, resolved.color, resolved.pressureOpts, rand, 0, duration, [], 'round');
}

function animateArrow(ctx, x1, y1, x2, y2, opts, duration) {
  opts = opts || {};
  duration = duration !== undefined ? duration : 500;

  var resolved = applyTool(opts);
  var rand = mulberry32(resolved.seed);

  var shaftDuration = duration * 0.8;
  var headDuration = duration * 0.2;

  var len = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  var numPoints = Math.max(8, Math.floor(len / 4));

  var shaftPoints = [];
  for (var i = 0; i <= numPoints; i++) {
    var t = i / numPoints;
    shaftPoints.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
  }

  return _animatePoints(
    ctx, shaftPoints, resolved.width, resolved.color,
    resolved.pressureOpts, rand,
    0,
    shaftDuration,
    [],
    'round'
  ).then(function () {
    var angle = Math.atan2(y2 - y1, x2 - x1);
    var headSize = Math.max(12, resolved.width * 3.5);
    var spread = Math.PI / 6;

    ctx.save();
    ctx.strokeStyle = resolved.color;
    ctx.lineWidth = resolved.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x2 - Math.cos(angle - spread) * headSize, y2 - Math.sin(angle - spread) * headSize);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle + spread) * headSize, y2 - Math.sin(angle + spread) * headSize);
    ctx.stroke();
    ctx.restore();

    return wait(headDuration);
  });
}

// ── Text Rendering ────────────────────────────────────────────────────────────
// Text ALWAYS appears instantly as a complete unit. Never character by character.

function drawText(ctx, text, x, y, opts) {
  opts = opts || {};
  var size = opts.size !== undefined ? opts.size : 32;
  var color = opts.color || '#000000';
  var weight = opts.weight || 'normal';
  var align = opts.align || 'left';
  var fontFamily = opts.font || 'sans-serif';
  var delay = opts.delay || 0;

  function render() {
    ctx.save();
    ctx.font = weight + ' ' + size + 'px ' + fontFamily;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  if (delay > 0) {
    setTimeout(render, delay);
  } else {
    render();
  }
}

// ── Fade-in Fill ──────────────────────────────────────────────────────────────

function fadeInFill(ctx, drawFn, color, alpha, duration) {
  return new Promise(function (resolve) {
    var startTime = performance.now();

    function frame() {
      var elapsed = performance.now() - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);

      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = eased * alpha;
      drawFn(ctx);
      ctx.restore();

      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(frame);
  });
}

// ── Asset Drawing ─────────────────────────────────────────────────────────────

function drawAsset(ctx, assetId, opts) {
  opts = opts || {};
  var x = opts.x !== undefined ? opts.x : 0;
  var y = opts.y !== undefined ? opts.y : 0;
  var width = opts.width !== undefined ? opts.width : 100;
  var height = opts.height !== undefined ? opts.height : 100;
  var opacity = opts.opacity !== undefined ? opts.opacity : 1;

  var assets = (window.__dreambyteAssets) || {};
  var img = assets[assetId];

  if (img && img instanceof HTMLImageElement && img.complete) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(img, x, y, width, height);
    ctx.restore();
    return Promise.resolve();
  }

  ctx.save();
  ctx.globalAlpha = opacity * 0.3;
  ctx.fillStyle = '#888888';
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = '#555555';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = opacity * 0.6;
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('asset:' + assetId, x + width / 2, y + height / 2);
  ctx.restore();

  return Promise.resolve();
}
// ── Progress-Based Drawing (for the timeline proxy pattern) ─────────────────
// These draw a stroke at 0-1 completion. Used with the anime.js master timeline:
//   const proxy = { p: 0 };
//   window.__tl.add(proxy, { p: [0, 1], duration: 0.8, onUpdate: draw }, 0);
//   function draw() { drawRoughLineAtProgress(ctx, ...proxy.p, opts); }

function _renderPointsAtProgress(ctx, allPoints, progress, baseWidth, color, pressureOpts, rand, alphaJitter, lineDash, lineCap) {
  lineDash = lineDash || [];
  lineCap = lineCap || 'round';
  var total = allPoints.length;
  if (total < 2 || progress <= 0) return;
  var p = Math.min(1, progress);
  var targetIndex = Math.floor(p * (total - 1)) + 1;

  ctx.save();
  ctx.setLineDash(lineDash);
  ctx.lineCap = lineCap;

  for (var i = 0; i < targetIndex - 1 && i < total - 1; i++) {
    var globalT = i / Math.max(total - 2, 1);
    var globalTNext = (i + 1) / Math.max(total - 2, 1);
    var widthMid = strokePressure((globalT + globalTNext) / 2, pressureOpts) * baseWidth;
    var alpha = jitteredAlpha(1, globalT, rand, alphaJitter);

    ctx.globalAlpha = alpha;
    ctx.lineWidth = widthMid;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(allPoints[i][0], allPoints[i][1]);
    ctx.lineTo(allPoints[i + 1][0], allPoints[i + 1][1]);
    ctx.stroke();
  }

  ctx.restore();
}

function drawRoughLineAtProgress(ctx, x1, y1, x2, y2, progress, opts) {
  if (progress <= 0) return;
  opts = opts || {};
  var resolved = applyTool(opts);
  var rand = mulberry32(opts.seed || 1);
  var numPts = Math.max(8, Math.floor(Math.sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1)) / 6));
  var pts = _wobbleLine(x1, y1, x2, y2, resolved.roughness, resolved.bowing, numPts, rand);
  if (resolved.smooth) pts = chaikinSmooth(pts, resolved.smoothIterations, 0.25, false);
  _renderPointsAtProgress(ctx, pts, progress, resolved.width, resolved.color, resolved.pressureOpts, rand, resolved.alphaJitter, resolved.lineDash, resolved.lineCap);

  if (opts.fill && progress >= 1) {
    ctx.save();
    ctx.globalAlpha = opts.fillAlpha || 0.15;
    ctx.fillStyle = opts.fill;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawRoughCircleAtProgress(ctx, cx, cy, diameter, progress, opts) {
  if (progress <= 0) return;
  opts = opts || {};
  var resolved = applyTool(opts);
  var rand = mulberry32(opts.seed || 1);
  var radius = diameter / 2;
  var numPts = Math.max(24, Math.floor(radius * 0.8));
  var pts = _wobbleCircle(cx, cy, radius, resolved.roughness, numPts, rand);
  if (resolved.smooth) pts = chaikinSmooth(pts, resolved.smoothIterations, 0.25, true);
  _renderPointsAtProgress(ctx, pts, progress, resolved.width, resolved.color, resolved.pressureOpts, rand, resolved.alphaJitter, resolved.lineDash, resolved.lineCap);

  if (opts.fill && progress >= 1) {
    ctx.save();
    ctx.globalAlpha = opts.fillAlpha || 0.15;
    ctx.fillStyle = opts.fill;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawRoughRectAtProgress(ctx, x, y, w, h, progress, opts) {
  if (progress <= 0) return;
  opts = opts || {};
  var resolved = applyTool(opts);
  var rand = mulberry32(opts.seed || 1);
  var corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
  var allPts = [];
  for (var i = 0; i < corners.length - 1; i++) {
    var seg = _wobbleLine(corners[i][0], corners[i][1], corners[i+1][0], corners[i+1][1], resolved.roughness, resolved.bowing, 8, rand);
    allPts = allPts.concat(seg);
  }
  if (resolved.smooth) allPts = chaikinSmooth(allPts, resolved.smoothIterations, 0.25, false);
  _renderPointsAtProgress(ctx, allPts, progress, resolved.width, resolved.color, resolved.pressureOpts, rand, resolved.alphaJitter, resolved.lineDash, resolved.lineCap);

  if (opts.fill && progress >= 1) {
    ctx.save();
    ctx.globalAlpha = opts.fillAlpha || 0.15;
    ctx.fillStyle = opts.fill;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

function drawRoughArrowAtProgress(ctx, x1, y1, x2, y2, progress, opts) {
  if (progress <= 0) return;
  // Draw shaft at full progress, head appears at end
  var shaftProgress = Math.min(1, progress / 0.85);
  drawRoughLineAtProgress(ctx, x1, y1, x2, y2, shaftProgress, opts);

  if (progress > 0.85) {
    opts = opts || {};
    var resolved = applyTool(opts);
    var angle = Math.atan2(y2 - y1, x2 - x1);
    var headLen = Math.min(30, Math.sqrt((x2-x1)*(x2-x1)+(y2-y1)*(y2-y1)) * 0.15);
    var headProgress = (progress - 0.85) / 0.15;
    var a1x = x2 - headLen * Math.cos(angle - 0.4) * headProgress;
    var a1y = y2 - headLen * Math.sin(angle - 0.4) * headProgress;
    var a2x = x2 - headLen * Math.cos(angle + 0.4) * headProgress;
    var a2y = y2 - headLen * Math.sin(angle + 0.4) * headProgress;

    ctx.save();
    ctx.strokeStyle = resolved.color;
    ctx.lineWidth = resolved.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a1x, a1y); ctx.lineTo(x2, y2); ctx.lineTo(a2x, a2y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTextAtProgress(ctx, text, x, y, progress, opts) {
  if (progress <= 0) return;
  opts = opts || {};
  ctx.save();
  ctx.globalAlpha = Math.min(1, progress);
  ctx.font = (opts.weight || 'bold') + ' ' + (opts.size || 48) + 'px ' + (opts.font || FONT || 'Caveat');
  ctx.fillStyle = opts.color || STROKE_COLOR || '#1a1a2e';
  ctx.textAlign = opts.align || 'center';
  ctx.textBaseline = opts.baseline || 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── End Dreambyte Canvas2D Drawing Engine ──────────────────────────────────
`
