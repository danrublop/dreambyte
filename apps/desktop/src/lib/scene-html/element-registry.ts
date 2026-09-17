/**
 * Element registry injected into every scene HTML.
 *
 * Provides:
 * - window.__elements: registry of all scene elements
 * - window.__register(): register an element with properties + bbox
 * - window.__hitTest(): find element at a point (reverse z-order)
 * - Click handler that selects elements and posts to parent
 * - Selection highlight overlay (dashed box + corner handles)
 * - patch_element message handler for live property updates
 *
 * Injected AFTER playback-controller and BEFORE scene code.
 */

export const ELEMENT_REGISTRY = `
(function() {
  // ── Element registry ────────────────────────────────────
  window.__elements = {};
  window.__selected = null;

  window.__register = function(element) {
    window.__elements[element.id] = element;
  };

  // ── Hit detection ───────────────────────────────────────
  window.__hitTest = function(x, y) {
    var elements = Object.values(window.__elements);
    for (var i = elements.length - 1; i >= 0; i--) {
      var el = elements[i];
      if (!el.bbox || el.visible === false) continue;
      if (
        x >= el.bbox.x && x <= el.bbox.x + el.bbox.w &&
        y >= el.bbox.y && y <= el.bbox.y + el.bbox.h
      ) {
        return el;
      }
    }
    return null;
  };

  function __sceneBodyScale() {
    var bodyStyle = document.body.style.transform || '';
    var m = bodyStyle.match(/scale\\(([^)]+)\\)/);
    if (m) return parseFloat(m[1]);
    return Math.min(window.innerWidth / (typeof WIDTH !== 'undefined' ? WIDTH : 1920), window.innerHeight / (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080));
  }

  // ── Click handler ───────────────────────────────────────
  document.addEventListener('click', function(e) {
    // The scene body uses transform:scale(s) via fitToViewport().
    // e.clientX/Y are in the *scaled* viewport, so we need to
    // convert back to 1920x1080 scene coordinates.
    // Use the body's current CSS transform scale factor.
    var body = document.body;
    var bodyStyle = body.style.transform || '';
    var scaleMatch = bodyStyle.match(/scale\\(([^)]+)\\)/);
    var bodyScale = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
    // If no body transform, fall back to viewport ratio
    if (!bodyScale || isNaN(bodyScale)) {
      bodyScale = Math.min(window.innerWidth / (typeof WIDTH !== 'undefined' ? WIDTH : 1920), window.innerHeight / (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080));
    }
    var x = e.clientX / bodyScale;
    var y = e.clientY / bodyScale;

    var hit = window.__hitTest(x, y);

    if (hit) {
      window.__selected = hit.id;
      showSelectionHighlight(hit);
      window.parent.postMessage({
        source: 'dreambyte-scene',
        type: 'element_selected',
        elementId: hit.id,
        element: JSON.parse(JSON.stringify(hit)),
      }, '*');
    } else {
      window.__selected = null;
      clearSelectionHighlight();
      window.parent.postMessage({
        source: 'dreambyte-scene',
        type: 'element_deselected',
      }, '*');
    }
  });

  // ── Selection highlight overlay ─────────────────────────
  var highlightCanvas = null;

  function showSelectionHighlight(element) {
    if (!element.bbox) return;

    if (!highlightCanvas) {
      highlightCanvas = document.createElement('canvas');
      highlightCanvas.width = (typeof WIDTH !== 'undefined' ? WIDTH : 1920);
      highlightCanvas.height = (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080);
      highlightCanvas.style.cssText =
        'position:absolute;inset:0;pointer-events:none;z-index:9999;';
      // Scale with the body
      var bodyTransform = document.body.style.transform;
      if (bodyTransform) {
        highlightCanvas.style.transformOrigin = 'top left';
      }
      document.body.appendChild(highlightCanvas);
    }

    var ctx = highlightCanvas.getContext('2d');
    var __w = (typeof WIDTH !== 'undefined' ? WIDTH : 1920);
    var __h = (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080);
    ctx.clearRect(0, 0, __w, __h);

    var bx = element.bbox.x;
    var by = element.bbox.y;
    var bw = element.bbox.w;
    var bh = element.bbox.h;
    var pad = 8;

    // Dashed selection box
    ctx.strokeStyle = '#e84545';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(bx - pad, by - pad, bw + pad * 2, bh + pad * 2);

    // Corner handles
    ctx.fillStyle = '#e84545';
    ctx.setLineDash([]);
    var corners = [
      [bx - pad, by - pad],
      [bx + bw + pad, by - pad],
      [bx - pad, by + bh + pad],
      [bx + bw + pad, by + bh + pad],
    ];
    corners.forEach(function(c) {
      ctx.fillRect(c[0] - 4, c[1] - 4, 8, 8);
    });

    // Element label
    ctx.fillStyle = '#e84545';
    ctx.font = '20px DM Mono, monospace';
    ctx.fillText(element.label || element.id, bx - pad, by - pad - 8);
  }

  function clearSelectionHighlight() {
    if (highlightCanvas) {
      var ctx = highlightCanvas.getContext('2d');
      ctx.clearRect(0, 0, (typeof WIDTH !== 'undefined' ? WIDTH : 1920), (typeof HEIGHT !== 'undefined' ? HEIGHT : 1080));
    }
  }

  // ── Highlight from parent (when selecting in layers panel) ──
  window.__highlightElement = function(elementId) {
    var el = window.__elements[elementId];
    if (el) {
      window.__selected = elementId;
      showSelectionHighlight(el);
    }
  };

  window.__clearHighlight = function() {
    window.__selected = null;
    clearSelectionHighlight();
  };

  // ── Property patching from parent ──────────────────────
  window.addEventListener('message', function(e) {
    // Only accept messages from the embedding parent. A scene may embed
    // third-party iframes (videos/widgets); without this any nested frame
    // could post {target:'dreambyte-scene', type:'patch_element', ...} and drive
    // arbitrary element/src/style mutations. Matches the
    // source-gating in playback-controller.ts.
    if (e.source && e.source !== window.parent) return;
    if (!e.data || e.data.target !== 'dreambyte-scene') return;

    if (e.data.type === 'patch_element') {
      var elementId = e.data.elementId;
      var property = e.data.property;
      var value = e.data.value;
      var element = window.__elements[elementId];
      if (!element) return;

      element[property] = value;

      // Re-render: for canvas2d, call redrawAll if it exists
      if (window.__redrawAll) {
        window.__redrawAll();
      }
      // For DOM elements (React scenes), patch via style
      var domEl = document.getElementById(elementId);
      if (domEl && (element.type === 'dom-text' || element.type === 'dom-container' || element.type === 'dom-image')) {
        if (property === 'text') {
          domEl.textContent = value;
        } else if (property === 'visible') {
          domEl.style.display = value ? '' : 'none';
        } else if (property === 'opacity') {
          domEl.style.opacity = String(value);
        } else if (property === 'src' && domEl.tagName === 'IMG') {
          domEl.src = value;
        } else {
          // CSS properties — camelCase keys map directly to style
          domEl.style[property] = (typeof value === 'number') ? (value + 'px') : String(value);
        }
        // Update bbox after patch
        try {
          var s = __sceneBodyScale();
          var r = domEl.getBoundingClientRect();
          element.bbox = { x: r.left / s, y: r.top / s, w: r.width / s, h: r.height / s };
        } catch(ignored) {}
      }
      // For SVG, apply attribute directly to the DOM node
      else if (domEl) {
        // Map element properties to DOM attributes
        if (property === 'fill' || property === 'stroke') {
          domEl.setAttribute(property, value || 'none');
        } else if (property === 'strokeWidth') {
          domEl.setAttribute('stroke-width', value);
        } else if (property === 'fillOpacity') {
          domEl.setAttribute('fill-opacity', value);
        } else if (property === 'opacity') {
          domEl.setAttribute('opacity', value);
        } else if (property === 'visible') {
          domEl.style.display = value ? '' : 'none';
        } else if (property === 'text') {
          domEl.textContent = value;
        } else if (property === 'fontSize') {
          domEl.setAttribute('font-size', value);
        } else if (property === 'fontFamily') {
          domEl.setAttribute('font-family', value);
        } else if (property === 'fontWeight') {
          domEl.setAttribute('font-weight', value);
        } else if (property === 'textAnchor') {
          domEl.setAttribute('text-anchor', value);
        } else if (['x','y','cx','cy','r','rx','ry','width','height','x1','y1','x2','y2'].indexOf(property) !== -1) {
          domEl.setAttribute(property, value);
          // Update bbox for selection highlight
          try {
            var nb = domEl.getBBox();
            element.bbox = { x: nb.x, y: nb.y, w: nb.width, h: nb.height };
          } catch(ignored) {}
        }
      }

      // Update selection highlight if this element is selected
      if (window.__selected === elementId && element.bbox) {
        showSelectionHighlight(element);
      }

      // Re-seek timeline to current time to show the change
      if (window.__clock && !window.__clock.isActive()) {
        window.__clock.seek(window.__clock.time());
      }
    }

    if (e.data.type === 'highlight_element') {
      if (e.data.elementId) {
        window.__highlightElement(e.data.elementId);
      } else {
        window.__clearHighlight();
      }
    }

    if (e.data.type === 'get_elements') {
      window.parent.postMessage({
        source: 'dreambyte-scene',
        type: 'elements_list',
        elements: JSON.parse(JSON.stringify(window.__elements)),
      }, '*');
    }
  });

  // ── Auto-register SVG elements on load ──────────────────
  var SVG_SCAN_TAGS = 'rect,circle,ellipse,line,polyline,polygon,path,text,g,image,use';

  window.addEventListener('load', function() {
    // Scan ALL visible SVG elements (not just those with id)
    // Skip SVGs inside #react-root — those are part of React components
    // and will be handled by the DOM scan if they have data-label
    var autoIdx = 0;
    var rRoot = document.getElementById('react-root');
    document.querySelectorAll('svg').forEach(function(svg) {
      if (rRoot && rRoot.contains(svg)) return;
      svg.querySelectorAll(SVG_SCAN_TAGS).forEach(function(el) {
        // Assign stable id if missing
        if (!el.id) {
          el.id = 'auto-' + el.tagName.toLowerCase() + '-' + (autoIdx++);
        }
        // Skip if already registered by scene code
        if (window.__elements[el.id]) return;

        // Skip invisible or tiny elements
        var bbox;
        try {
          var b = el.getBBox();
          bbox = { x: b.x, y: b.y, w: b.width, h: b.height };
          // Skip zero-size elements (markers, defs, clip-paths)
          if (bbox.w < 2 && bbox.h < 2) return;
        } catch(e) {
          return; // Can't measure = not renderable
        }

        // Skip elements inside <defs>, <clipPath>, <mask>, <pattern>
        var skip = false;
        var parent = el.parentElement;
        while (parent && parent !== svg) {
          var pTag = parent.tagName.toLowerCase();
          if (pTag === 'defs' || pTag === 'clippath' || pTag === 'mask' || pTag === 'pattern' || pTag === 'marker') { skip = true; break; }
          parent = parent.parentElement;
        }
        if (skip) return;

        var tagName = el.tagName.toLowerCase();
        var type = 'svg-shape';
        if (tagName === 'text' || tagName === 'tspan') type = 'svg-text';
        else if (tagName === 'path') type = 'svg-path';
        else if (tagName === 'rect') type = 'svg-shape';
        else if (tagName === 'circle' || tagName === 'ellipse') type = 'svg-shape';
        else if (tagName === 'line' || tagName === 'polyline' || tagName === 'polygon') type = 'svg-shape';
        else if (tagName === 'image') type = 'svg-shape';
        else if (tagName === 'g') type = 'svg-shape';

        // Build readable label
        var autoLabel = el.dataset ? el.dataset.label : null;
        if (!autoLabel) {
          if (type === 'svg-text') {
            autoLabel = (el.textContent || '').trim().slice(0, 30) || 'Text';
          } else {
            autoLabel = tagName + (el.id && !el.id.startsWith('auto-') ? '#' + el.id : ' ' + (autoIdx));
          }
        }

        // Extract computed style for inherited properties
        var cs = window.getComputedStyle(el);

        window.__register({
          id: el.id,
          type: type,
          label: autoLabel,
          bbox: bbox,
          stroke: el.getAttribute('stroke') || cs.stroke || 'none',
          strokeWidth: parseFloat(el.getAttribute('stroke-width') || cs.strokeWidth || '0'),
          fill: el.getAttribute('fill') || cs.fill || 'none',
          fillOpacity: parseFloat(el.getAttribute('fill-opacity') || '1'),
          opacity: parseFloat(el.getAttribute('opacity') || cs.opacity || '1'),
          visible: el.style.display !== 'none' && cs.display !== 'none',
          animStartTime: 0,
          animDuration: 0,
          text: (type === 'svg-text') ? (el.textContent || '') : '',
          fontSize: parseFloat(el.getAttribute('font-size') || cs.fontSize || '16'),
          fontFamily: el.getAttribute('font-family') || cs.fontFamily || '',
          x: parseFloat(el.getAttribute('x') || el.getAttribute('cx') || '0'),
          y: parseFloat(el.getAttribute('y') || el.getAttribute('cy') || '0'),
        });
      });
    });

    // ── Auto-register DOM elements (React scenes) ─────────
    // React 18 createRoot().render() is async — DOM may not exist at load time.
    // We use a single retry-based scan that waits for React to render.
    function __scanReactDOM(root) {
      var domIdx = 0;
      var bodyScale = __sceneBodyScale();
      var registered = {};
      var candidates = [];

      // Pass 1: elements with explicit data-label (highest priority)
      root.querySelectorAll('[data-label]').forEach(function(el) {
        candidates.push(el);
      });
      // Pass 2: leaf text elements
      root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li').forEach(function(el) {
        if (!el.dataset || !el.dataset.label) candidates.push(el);
      });
      // Pass 3: images
      root.querySelectorAll('img').forEach(function(el) {
        candidates.push(el);
      });

      candidates.forEach(function(el) {
        var rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;

        // Skip if an ancestor is already registered
        var ancestor = el.parentElement;
        while (ancestor && ancestor !== root) {
          if (registered[ancestor.id]) return;
          ancestor = ancestor.parentElement;
        }

        var tag = el.tagName.toLowerCase();
        var isTextTag = /^(h[1-6]|p|li|span|a|button)$/.test(tag);
        var hasLabel = el.dataset && el.dataset.label;
        var hasDirectText = (el.textContent || '').trim().length > 0;
        var isText = isTextTag || (hasLabel && hasDirectText && !(/^(img|svg|canvas|video)$/.test(tag)));
        var isImage = tag === 'img';

        if (isText && !(el.textContent || '').trim()) return;

        if (!el.id) el.id = 'dreambyte-' + tag + '-' + (domIdx++);
        if (window.__elements[el.id]) return;

        var label = hasLabel ? el.dataset.label : null;
        if (!label) {
          if (isText) label = (el.textContent || '').trim().slice(0, 40) || tag;
          else if (isImage) { var src = el.getAttribute('src') || ''; label = src.split('/').pop().split('?')[0] || 'Image'; }
          else label = tag + ' element';
        }

        registered[el.id] = true;
        window.__register({
          id: el.id,
          type: isText ? 'dom-text' : isImage ? 'dom-image' : 'dom-container',
          label: label,
          bbox: { x: rect.left / bodyScale, y: rect.top / bodyScale, w: rect.width / bodyScale, h: rect.height / bodyScale },
          visible: true, opacity: parseFloat(cs.opacity) || 1,
          animStartTime: 0, animDuration: 0,
          text: isText ? (el.textContent || '') : '',
          color: cs.color, backgroundColor: cs.backgroundColor,
          fontSize: parseFloat(cs.fontSize) || 16, fontFamily: cs.fontFamily,
          fontWeight: cs.fontWeight, textAlign: cs.textAlign,
          padding: cs.padding, borderRadius: parseFloat(cs.borderRadius) || 0,
          gap: cs.gap || '0px', display: cs.display, flexDirection: cs.flexDirection,
          alignItems: cs.alignItems, justifyContent: cs.justifyContent,
          src: isImage ? el.getAttribute('src') : undefined, objectFit: cs.objectFit,
          width: rect.width / bodyScale, height: rect.height / bodyScale,
        });
      });
    }

    function __reportElements() {
      window.parent.postMessage({
        source: 'dreambyte-scene',
        type: 'elements_list',
        elements: JSON.parse(JSON.stringify(window.__elements)),
      }, '*');
    }

    var rr = document.getElementById('react-root');
    if (rr) {
      // Always wait for React to render (createRoot is async)
      var attempts = 0;
      var waitForReact = setInterval(function() {
        attempts++;
        if (rr.children.length > 0 || attempts > 50) {
          clearInterval(waitForReact);
          if (rr.children.length > 0) __scanReactDOM(rr);
          __reportElements();
        }
      }, 80);
    } else {
      // No React root — just report SVG elements
      setTimeout(__reportElements, 100);
    }
  });
})();
`
