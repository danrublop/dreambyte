/**
 * DreambyteInteract — Pre-built interactive scene components for Dreambyte.
 *
 * 6 component types: hotspot, choice, quiz, gate, tooltip, form
 * 6 visual styles: professional, glassmorphic, minimal, terminal, chalk, edu
 *
 * All components check window.__wvc_render and skip initialization during
 * headless WVC capture. Interactions only activate in live preview.
 *
 * SECURITY NOTE: All HTML assembly uses escHtml() which sanitizes via
 * textContent assignment. Config values come from the trusted agent, not
 * end-user input. innerHTML is only set with pre-escaped, internally-built
 * template strings — never with raw external content.
 *
 * Usage:
 *   DreambyteInteract.quiz({
 *     question: 'What causes drag?',
 *     options: ['Gravity', 'Air resistance', 'Friction'],
 *     correct: 1,
 *     explanation: 'Air resistance removes kinetic energy.',
 *     style: 'professional'
 *   })
 */
;(function (global) {
  'use strict'

  var IS_RENDER = !!(global.__wvc_render)
  var _idCounter = 0
  function uid() { return 'ci-' + (++_idCounter) }

  // ── Style Registry ────────────────────────────────────────────────────────

  var STYLES = {
    professional: {
      bg: 'rgba(255, 255, 255, 0.98)',
      border: '1px solid #E0E0E0',
      borderRadius: '4px',
      shadow: '0 2px 8px rgba(0,0,0,0.12)',
      backdropFilter: 'none',
      fontFamily: 'Inter, system-ui, sans-serif',
      titleSize: '15px',
      titleWeight: '600',
      titleColor: '#1A1A2E',
      bodySize: '14px',
      bodyWeight: '400',
      bodyColor: '#444444',
      labelSize: '11px',
      labelWeight: '500',
      labelColor: '#888888',
      labelTracking: '0.06em',
      labelTransform: 'uppercase',
      primaryBg: '#1A1A2E',
      primaryText: '#FFFFFF',
      primaryHover: '#2D2D4E',
      primaryBorder: 'none',
      secondaryBg: 'transparent',
      secondaryText: '#1A1A2E',
      secondaryBorder: '1px solid #1A1A2E',
      secondaryHover: 'rgba(26,26,46,0.06)',
      correctBg: '#F0FFF4',
      correctBorder: '1px solid #38A169',
      correctText: '#276749',
      incorrectBg: '#FFF5F5',
      incorrectBorder: '1px solid #E53E3E',
      incorrectText: '#C53030',
      neutralBg: '#F7F7F9',
      hotspotSize: '28px',
      hotspotBg: '#1A1A2E',
      hotspotBorder: 'none',
      hotspotText: '#FFFFFF',
      hotspotPulse: 'rgba(26,26,46,0.2)',
      hotspotShadow: 'none',
      entranceDuration: 0.25,
      entranceEase: 'outCubic',
      exitDuration: 0.15,
      gateLockColor: '#888888',
      gateUnlockColor: '#38A169',
      gateProgressColor: '#1A1A2E',
      divider: '1px solid #E8E8E8',
      padding: '20px 24px',
      gap: '10px',
      buttonRadius: '3px',
      inputRadius: '3px',
      checkboxAccent: '#1A1A2E',
      correctIcon: '\u2713',
      incorrectIcon: '\u2717'
    },

    glassmorphic: {
      bg: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      borderRadius: '16px',
      shadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      backdropFilter: 'blur(20px) saturate(180%)',
      fontFamily: 'Inter, system-ui, sans-serif',
      titleSize: '16px',
      titleWeight: '500',
      titleColor: 'rgba(255, 255, 255, 0.95)',
      bodySize: '14px',
      bodyWeight: '400',
      bodyColor: 'rgba(255, 255, 255, 0.7)',
      labelSize: '11px',
      labelWeight: '500',
      labelColor: 'rgba(255, 255, 255, 0.4)',
      labelTracking: '0.08em',
      labelTransform: 'uppercase',
      primaryBg: 'rgba(124, 58, 237, 0.8)',
      primaryText: '#FFFFFF',
      primaryHover: 'rgba(124, 58, 237, 1)',
      primaryBorder: '1px solid rgba(124, 58, 237, 0.5)',
      secondaryBg: 'rgba(255, 255, 255, 0.06)',
      secondaryText: 'rgba(255, 255, 255, 0.8)',
      secondaryBorder: '1px solid rgba(255, 255, 255, 0.12)',
      secondaryHover: 'rgba(255, 255, 255, 0.12)',
      correctBg: 'rgba(16, 185, 129, 0.15)',
      correctBorder: '1px solid rgba(16, 185, 129, 0.4)',
      correctText: 'rgba(110, 231, 183, 0.95)',
      incorrectBg: 'rgba(239, 68, 68, 0.12)',
      incorrectBorder: '1px solid rgba(239, 68, 68, 0.3)',
      incorrectText: 'rgba(252, 165, 165, 0.95)',
      neutralBg: 'rgba(255, 255, 255, 0.05)',
      hotspotSize: '32px',
      hotspotBg: 'rgba(124, 58, 237, 0.7)',
      hotspotBorder: '1px solid rgba(124, 58, 237, 0.5)',
      hotspotText: '#FFFFFF',
      hotspotPulse: 'rgba(124, 58, 237, 0.3)',
      hotspotShadow: 'none',
      entranceDuration: 0.3,
      entranceEase: 'outQuart',
      exitDuration: 0.2,
      gateLockColor: 'rgba(255,255,255,0.3)',
      gateUnlockColor: 'rgba(16, 185, 129, 0.8)',
      gateProgressColor: 'rgba(124, 58, 237, 0.8)',
      divider: '1px solid rgba(255,255,255,0.08)',
      padding: '24px 28px',
      gap: '12px',
      buttonRadius: '10px',
      inputRadius: '10px',
      checkboxAccent: 'rgba(124, 58, 237, 0.9)',
      correctIcon: '\u2713',
      incorrectIcon: '\u2717'
    },

    minimal: {
      bg: 'rgba(255, 255, 255, 0.97)',
      border: '0.5px solid rgba(0,0,0,0.1)',
      borderRadius: '2px',
      shadow: 'none',
      backdropFilter: 'none',
      fontFamily: 'Inter, system-ui, sans-serif',
      titleSize: '14px',
      titleWeight: '500',
      titleColor: '#1A1A1A',
      bodySize: '13px',
      bodyWeight: '400',
      bodyColor: '#666666',
      labelSize: '10px',
      labelWeight: '400',
      labelColor: '#AAAAAA',
      labelTracking: '0',
      labelTransform: 'none',
      primaryBg: '#1A1A1A',
      primaryText: '#FFFFFF',
      primaryHover: '#333333',
      primaryBorder: 'none',
      secondaryBg: 'transparent',
      secondaryText: '#1A1A1A',
      secondaryBorder: '0.5px solid #1A1A1A',
      secondaryHover: 'rgba(0,0,0,0.04)',
      correctBg: '#FAFFF9',
      correctBorder: '0.5px solid #38A169',
      correctText: '#276749',
      incorrectBg: '#FFF9F9',
      incorrectBorder: '0.5px solid #E53E3E',
      incorrectText: '#C53030',
      neutralBg: '#F9F9F9',
      hotspotSize: '20px',
      hotspotBg: '#1A1A1A',
      hotspotBorder: 'none',
      hotspotText: '#FFFFFF',
      hotspotPulse: 'rgba(0,0,0,0.08)',
      hotspotShadow: 'none',
      entranceDuration: 0.4,
      entranceEase: 'outQuad',
      exitDuration: 0.2,
      gateLockColor: '#CCCCCC',
      gateUnlockColor: '#666666',
      gateProgressColor: '#1A1A1A',
      divider: '0.5px solid rgba(0,0,0,0.08)',
      padding: '16px 18px',
      gap: '8px',
      buttonRadius: '2px',
      inputRadius: '2px',
      checkboxAccent: '#1A1A1A',
      correctIcon: '\u2713',
      incorrectIcon: '\u2717'
    },

    terminal: {
      bg: '#0F0D00',
      border: '1px solid #FFB000',
      borderRadius: '0px',
      shadow: '0 0 12px rgba(255, 176, 0, 0.2)',
      backdropFilter: 'none',
      fontFamily: "'Space Mono', 'Courier New', monospace",
      titleSize: '14px',
      titleWeight: '700',
      titleColor: '#FFB000',
      bodySize: '13px',
      bodyWeight: '400',
      bodyColor: '#CC7000',
      labelSize: '11px',
      labelWeight: '400',
      labelColor: '#8B5000',
      labelTracking: '0.06em',
      labelTransform: 'uppercase',
      primaryBg: '#FFB000',
      primaryText: '#0a0800',
      primaryHover: '#FFC933',
      primaryBorder: 'none',
      secondaryBg: 'transparent',
      secondaryText: '#FFB000',
      secondaryBorder: '1px solid #FFB000',
      secondaryHover: 'rgba(255,176,0,0.1)',
      correctBg: 'rgba(255,176,0,0.15)',
      correctBorder: '1px solid #FFB000',
      correctText: '#FFB000',
      incorrectBg: 'rgba(139,0,0,0.2)',
      incorrectBorder: '1px solid #8B0000',
      incorrectText: '#FF4444',
      neutralBg: 'rgba(255,176,0,0.05)',
      hotspotSize: '24px',
      hotspotBg: 'transparent',
      hotspotBorder: '1px solid #FFB000',
      hotspotText: '#FFB000',
      hotspotPulse: 'rgba(255,176,0,0.15)',
      hotspotShadow: 'none',
      entranceDuration: 0.1,
      entranceEase: 'linear',
      exitDuration: 0.08,
      gateLockColor: '#8B5000',
      gateUnlockColor: '#FFB000',
      gateProgressColor: '#FF8C00',
      divider: '1px solid rgba(255,176,0,0.2)',
      padding: '16px 20px',
      gap: '8px',
      buttonRadius: '0px',
      inputRadius: '0px',
      checkboxAccent: '#FFB000',
      correctIcon: '[OK]',
      incorrectIcon: '[ERR]'
    },

    chalk: {
      bg: 'rgba(45, 74, 62, 0.97)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '2px',
      shadow: 'none',
      backdropFilter: 'none',
      fontFamily: "'Caveat', cursive, sans-serif",
      titleSize: '22px',
      titleWeight: '700',
      titleColor: '#FFFEF9',
      bodySize: '18px',
      bodyWeight: '400',
      bodyColor: 'rgba(255,254,249,0.85)',
      labelSize: '14px',
      labelWeight: '400',
      labelColor: 'rgba(255,254,249,0.55)',
      labelTracking: '0',
      labelTransform: 'none',
      primaryBg: 'rgba(255,254,249,0.15)',
      primaryText: '#FFFEF9',
      primaryBorder: '1.5px solid rgba(255,254,249,0.6)',
      primaryHover: 'rgba(255,254,249,0.25)',
      secondaryBg: 'transparent',
      secondaryText: '#FFFEF9',
      secondaryBorder: '1px solid rgba(255,254,249,0.3)',
      secondaryHover: 'rgba(255,254,249,0.08)',
      correctBg: 'rgba(42, 157, 143, 0.25)',
      correctBorder: '1px solid rgba(42,157,143,0.6)',
      correctText: '#a8e6df',
      incorrectBg: 'rgba(231, 111, 81, 0.2)',
      incorrectBorder: '1px solid rgba(231,111,81,0.5)',
      incorrectText: '#f4a482',
      neutralBg: 'rgba(255,254,249,0.06)',
      hotspotSize: '32px',
      hotspotBg: 'transparent',
      hotspotBorder: '2px solid rgba(255,254,249,0.7)',
      hotspotText: '#FFFEF9',
      hotspotPulse: 'rgba(255,254,249,0.12)',
      hotspotShadow: 'none',
      entranceDuration: 0.4,
      entranceEase: 'outCubic',
      exitDuration: 0.25,
      gateLockColor: 'rgba(255,254,249,0.3)',
      gateUnlockColor: 'rgba(42,157,143,0.8)',
      gateProgressColor: 'rgba(255,254,249,0.7)',
      divider: '1px solid rgba(255,254,249,0.1)',
      padding: '20px 24px',
      gap: '12px',
      buttonRadius: '2px',
      inputRadius: '2px',
      checkboxAccent: '#FFFEF9',
      correctIcon: '\u2713',
      incorrectIcon: '\u2717'
    },

    edu: {
      bg: '#FFFFFF',
      border: '2px solid #E8E8E8',
      borderRadius: '16px',
      shadow: '0 4px 16px rgba(0,0,0,0.08)',
      backdropFilter: 'none',
      fontFamily: "'Nunito', 'Inter', system-ui, sans-serif",
      titleSize: '18px',
      titleWeight: '700',
      titleColor: '#2D3748',
      bodySize: '16px',
      bodyWeight: '400',
      bodyColor: '#4A5568',
      labelSize: '12px',
      labelWeight: '600',
      labelColor: '#A0AEC0',
      labelTracking: '0.04em',
      labelTransform: 'uppercase',
      primaryBg: '#3498DB',
      primaryText: '#FFFFFF',
      primaryHover: '#2980B9',
      primaryBorder: 'none',
      secondaryBg: '#EBF8FF',
      secondaryText: '#2B6CB0',
      secondaryBorder: '2px solid #BEE3F8',
      secondaryHover: '#BEE3F8',
      correctBg: '#F0FFF4',
      correctBorder: '2px solid #68D391',
      correctText: '#276749',
      incorrectBg: '#FFF5F5',
      incorrectBorder: '2px solid #FC8181',
      incorrectText: '#C53030',
      neutralBg: '#F7FAFC',
      hotspotSize: '36px',
      hotspotBg: '#3498DB',
      hotspotBorder: '3px solid #FFFFFF',
      hotspotText: '#FFFFFF',
      hotspotPulse: 'rgba(52,152,219,0.2)',
      hotspotShadow: '0 2px 8px rgba(52,152,219,0.4)',
      entranceDuration: 0.4,
      entranceEase: 'outBack(1.5)',
      exitDuration: 0.2,
      gateLockColor: '#A0AEC0',
      gateUnlockColor: '#48BB78',
      gateProgressColor: '#3498DB',
      divider: '1.5px solid #EDF2F7',
      padding: '24px 28px',
      gap: '12px',
      buttonRadius: '12px',
      inputRadius: '10px',
      checkboxAccent: '#3498DB',
      correctIcon: '\u2713',
      incorrectIcon: '\u2717'
    }
  }

  // ── Style auto-detection ──────────────────────────────────────────────────

  function detectStyle() {
    var tool = global.TOOL || 'pen'
    var bg = (global.BG_COLOR || global.PALETTE && global.PALETTE[3] || '#FFFFFF').toLowerCase()

    if (tool === 'chalk') return 'chalk'
    if (tool === 'marker' && bg.indexOf('#fafa') === 0) return 'edu'
    // Dark backgrounds -> glassmorphic
    if (bg === '#0a0800' || bg === '#080808' || bg === '#0d1117' ||
        bg === '#0c1a2e' || bg === '#0f0f0f' || bg === '#111111' ||
        bg === '#000000' || bg === '#1a1a2e') return 'glassmorphic'
    // Warm paper -> chalk
    if (bg === '#f8f7f4' || bg === '#f5f0e8' || bg === '#2d4a3e') return 'chalk'
    // Clean/minimal
    if (bg === '#f5f5f0' || bg === '#fafafa' || bg === '#ffffff') return 'minimal'
    return 'professional'
  }

  function resolveStyle(styleName) {
    if (!styleName || styleName === 'auto') styleName = detectStyle()
    return STYLES[styleName] || STYLES.professional
  }

  // ── Mounting system ───────────────────────────────────────────────────────

  function getLayer() {
    var layer = document.getElementById('ci-layer')
    if (!layer) {
      layer = document.createElement('div')
      layer.id = 'ci-layer'
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:100;overflow:visible;'
      var root = document.getElementById('scene') || document.body
      root.appendChild(layer)
    }
    return layer
  }

  /**
   * Mount a component into the interaction layer.
   * Uses DOM construction via createElement + safe property assignment.
   * The htmlStr parameter is built internally from escaped config values.
   */
  function mount(htmlStr, position, s) {
    var wrap = document.createElement('div')
    // Safe: htmlStr is assembled internally using escHtml() on all config values
    wrap.innerHTML = htmlStr.trim() // eslint-disable-line no-unsanitized/property
    var el = wrap.firstElementChild
    el.style.pointerEvents = 'all'

    if (position === 'center') {
      el.style.position = 'absolute'
      el.style.left = '50%'
      el.style.top = '50%'
      el.style.transform = 'translate(-50%, -50%)'
    } else if (position === 'bottom') {
      el.style.position = 'absolute'
      el.style.left = '50%'
      el.style.bottom = '60px'
      el.style.transform = 'translateX(-50%)'
    } else if (position === 'top') {
      el.style.position = 'absolute'
      el.style.left = '50%'
      el.style.top = '60px'
      el.style.transform = 'translateX(-50%)'
    } else if (position && position.x !== undefined) {
      el.style.position = 'absolute'
      el.style.left = (typeof position.x === 'string' ? position.x : position.x + 'px')
      el.style.top = (typeof position.y === 'string' ? position.y : position.y + 'px')
    }

    getLayer().appendChild(el)
    return el
  }

  function containerCSS(s) {
    return 'font-family:' + s.fontFamily + ';' +
      'background:' + s.bg + ';' +
      'border:' + s.border + ';' +
      'border-radius:' + s.borderRadius + ';' +
      'box-shadow:' + s.shadow + ';' +
      (s.backdropFilter !== 'none' ? 'backdrop-filter:' + s.backdropFilter + ';-webkit-backdrop-filter:' + s.backdropFilter + ';' : '') +
      'padding:' + s.padding + ';'
  }

  function btnCSS(s, type) {
    if (type === 'primary') {
      return 'display:inline-flex;align-items:center;justify-content:center;' +
        'background:' + s.primaryBg + ';color:' + s.primaryText + ';' +
        'border:' + (s.primaryBorder || 'none') + ';border-radius:' + s.buttonRadius + ';' +
        'padding:10px 20px;font-family:' + s.fontFamily + ';font-size:' + s.bodySize + ';' +
        'font-weight:' + s.titleWeight + ';cursor:pointer;transition:background 0.15s;' +
        'outline:none;line-height:1.3;'
    }
    return 'display:inline-flex;align-items:center;justify-content:center;' +
      'background:' + s.secondaryBg + ';color:' + s.secondaryText + ';' +
      'border:' + s.secondaryBorder + ';border-radius:' + s.buttonRadius + ';' +
      'padding:10px 20px;font-family:' + s.fontFamily + ';font-size:' + s.bodySize + ';' +
      'font-weight:' + s.bodyWeight + ';cursor:pointer;transition:background 0.15s;' +
      'outline:none;line-height:1.3;'
  }

  // Entrance animation via anime.js if available (interactive UI, not on the scene timeline)
  function animateIn(el, s) {
    if (typeof anime === 'undefined') return
    anime.animate(el, {
      opacity: [0, 1], y: [12, 0],
      duration: s.entranceDuration || 0.25,
      ease: s.entranceEase || 'outCubic',
    })
  }

  function animateOut(el, s, cb) {
    if (typeof anime === 'undefined') {
      if (el.parentNode) el.parentNode.removeChild(el)
      if (cb) cb()
      return
    }
    anime.animate(el, {
      opacity: 0, y: 8, duration: s.exitDuration || 0.15,
      onComplete: function () {
        if (el.parentNode) el.parentNode.removeChild(el)
        if (cb) cb()
      }
    })
  }

  /** Escape text for safe insertion into HTML templates */
  function escHtml(str) {
    var d = document.createElement('div')
    d.textContent = str || ''
    return d.innerHTML
  }

  // ── Inject global CSS (once) ──────────────────────────────────────────────

  function injectCSS() {
    if (document.getElementById('ci-global-css')) return
    var css = document.createElement('style')
    css.id = 'ci-global-css'
    css.textContent = [
      '@keyframes ci-pulse{0%{transform:scale(1);opacity:1}100%{transform:scale(1.8);opacity:0}}',
      '@keyframes ci-gate-pulse{0%{box-shadow:0 0 0 0 var(--ci-pulse-color)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}',
      '.ci-hotspot-pulse{animation:ci-pulse 2s ease-out infinite}',
      '.ci-gate-btn-pulse{animation:ci-gate-pulse 1.5s ease-out infinite}',
      '.ci-shake{animation:ci-shake 0.3s ease-in-out}',
      '@keyframes ci-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}',
      '#ci-layer *{box-sizing:border-box}',
      '#ci-layer span,#ci-layer label{display:inline;background:transparent;border:none;padding:0;margin:0;}'
    ].join('\n')
    document.head.appendChild(css)
  }

  // ── Popup direction calculation ───────────────────────────────────────────

  function calcDirection(x, y, dir, popW, popH) {
    if (dir && dir !== 'auto') return dir
    var w = global.WIDTH || 1920
    var h = global.HEIGHT || 1080
    if (y - popH - 20 > 0) return 'top'
    if (y + popH + 60 < h) return 'bottom'
    if (x + popW + 60 < w) return 'right'
    return 'left'
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 1: HOTSPOT
  // ══════════════════════════════════════════════════════════════════════════

  function hotspot(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var x = cfg.x || 0
    var y = cfg.y || 0
    var trigger = cfg.trigger || 'hover'
    var maxW = cfg.maxWidth || 280
    var persistent = cfg.persistent || false
    var dir = cfg.direction || 'auto'

    var html = '<div id="' + id + '" style="position:absolute;left:' +
      (typeof x === 'string' ? x : x + 'px') + ';top:' +
      (typeof y === 'string' ? y : y + 'px') + ';z-index:110;">' +
      '<div style="position:relative;width:' + s.hotspotSize + ';height:' + s.hotspotSize + ';cursor:pointer;">' +
        '<div class="ci-hotspot-pulse" style="position:absolute;inset:0;border-radius:50%;background:' + s.hotspotPulse + ';"></div>' +
        '<div class="ci-dot" style="position:absolute;inset:0;border-radius:50%;background:' + s.hotspotBg + ';' +
          'border:' + (s.hotspotBorder || 'none') + ';color:' + s.hotspotText + ';' +
          'display:flex;align-items:center;justify-content:center;font-family:' + s.fontFamily + ';' +
          'font-size:' + s.labelSize + ';font-weight:' + s.titleWeight + ';' +
          (s.hotspotShadow && s.hotspotShadow !== 'none' ? 'box-shadow:' + s.hotspotShadow + ';' : '') +
          'z-index:1;">' + escHtml(cfg.label || '') + '</div>' +
      '</div>' +
      '<div class="ci-popup" style="display:none;position:absolute;width:' + maxW + 'px;' +
        containerCSS(s) + 'z-index:120;">' +
        (cfg.title ? '<div style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';margin-bottom:6px;">' + escHtml(cfg.title) + '</div>' : '') +
        '<div style="font-size:' + s.bodySize + ';font-weight:' + s.bodyWeight + ';color:' + s.bodyColor + ';line-height:1.5;">' + escHtml(cfg.content || '') + '</div>' +
      '</div>' +
    '</div>'

    var el = mount(html, null, s)
    var dot = el.querySelector('.ci-dot')
    var popup = el.querySelector('.ci-popup')

    // Position popup based on direction
    function positionPopup() {
      var hs = parseInt(s.hotspotSize)
      var d = calcDirection(x, y, dir, maxW, 120)
      popup.style.left = ''
      popup.style.right = ''
      popup.style.top = ''
      popup.style.bottom = ''

      if (d === 'top') {
        popup.style.bottom = (hs + 10) + 'px'
        popup.style.left = (hs / 2 - maxW / 2) + 'px'
      } else if (d === 'bottom') {
        popup.style.top = (hs + 10) + 'px'
        popup.style.left = (hs / 2 - maxW / 2) + 'px'
      } else if (d === 'right') {
        popup.style.left = (hs + 10) + 'px'
        popup.style.top = (-10) + 'px'
      } else {
        popup.style.right = (hs + 10) + 'px'
        popup.style.top = (-10) + 'px'
      }
    }
    positionPopup()

    var isOpen = false

    function showPopup() {
      if (isOpen) return
      isOpen = true
      // Close other non-persistent hotspots
      if (!persistent) {
        var all = getLayer().querySelectorAll('.ci-popup')
        for (var i = 0; i < all.length; i++) {
          if (all[i] !== popup) all[i].style.display = 'none'
        }
      }
      popup.style.display = 'block'
      if (typeof anime !== 'undefined') {
        anime.animate(popup, {
          opacity: [0, 1], y: [dir === 'bottom' ? -8 : 8, 0],
          duration: s.entranceDuration, ease: s.entranceEase,
        })
      }
    }

    function hidePopup() {
      if (!isOpen) return
      isOpen = false
      if (typeof anime !== 'undefined') {
        anime.animate(popup, {
          opacity: 0, duration: s.exitDuration,
          onComplete: function () { popup.style.display = 'none' }
        })
      } else {
        popup.style.display = 'none'
      }
    }

    if (trigger === 'hover') {
      el.addEventListener('mouseenter', showPopup)
      el.addEventListener('mouseleave', hidePopup)
    } else {
      dot.addEventListener('click', function () {
        if (isOpen) hidePopup()
        else showPopup()
      })
    }

    // Analytics tracking
    if (typeof Dreambyte !== 'undefined' && Dreambyte.interactionFired) {
      dot.addEventListener('click', function () { Dreambyte.interactionFired(id, 'hotspot') })
    }

    return el
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 2: CHOICE
  // ══════════════════════════════════════════════════════════════════════════

  function choice(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var layout = cfg.layout || 'vertical'
    var multiSelect = cfg.multiSelect || false
    var showFeedback = cfg.showFeedback !== false
    var selected = []

    var optionsHtml = ''
    var options = cfg.options || []
    var flexDir = layout === 'horizontal' ? 'row' : 'column'
    var flexWrap = layout === 'grid' ? 'flex-wrap:wrap;' : ''
    var optWidth = layout === 'grid' ? 'width:calc(50% - ' + parseInt(s.gap) / 2 + 'px);' : 'width:100%;'

    for (var i = 0; i < options.length; i++) {
      var opt = typeof options[i] === 'string' ? { text: options[i] } : options[i]
      optionsHtml += '<div class="ci-option" data-index="' + i + '" data-value="' + escHtml(opt.value || opt.text) + '" ' +
        'style="' + optWidth + 'padding:14px 18px;border-radius:' + s.buttonRadius + ';' +
        'background:' + s.neutralBg + ';border:' + s.secondaryBorder + ';cursor:pointer;' +
        'display:flex;align-items:center;gap:10px;transition:all 0.15s;font-family:' + s.fontFamily + ';">' +
        (opt.icon ? '<span style="font-size:20px;flex-shrink:0;">' + escHtml(opt.icon) + '</span>' : '') +
        '<div style="flex:1;">' +
          '<div style="font-size:' + s.bodySize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';">' + escHtml(opt.text) + '</div>' +
          (opt.subtext ? '<div style="font-size:' + s.labelSize + ';color:' + s.bodyColor + ';margin-top:3px;">' + escHtml(opt.subtext) + '</div>' : '') +
        '</div>' +
        '<span class="ci-check" style="display:none;color:' + s.primaryText + ';font-weight:bold;width:22px;height:22px;border-radius:50%;background:' + s.primaryBg + ';align-items:center;justify-content:center;font-size:13px;">' + s.correctIcon + '</span>' +
      '</div>'
    }

    var html = '<div id="' + id + '" style="' + containerCSS(s) + 'max-width:480px;min-width:300px;">' +
      (cfg.question ? '<div style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';margin-bottom:' + s.gap + ';">' + escHtml(cfg.question) + '</div>' : '') +
      '<div class="ci-options" style="display:flex;flex-direction:' + flexDir + ';gap:' + s.gap + ';' + flexWrap + '">' +
        optionsHtml +
      '</div>' +
      (multiSelect ? '<div class="ci-continue-wrap" style="display:none;margin-top:' + s.gap + ';text-align:right;"><span class="ci-continue" style="' + btnCSS(s, 'primary') + '">Continue</span></div>' : '') +
    '</div>'

    var el = mount(html, cfg.position || 'center', s)
    animateIn(el, s)

    var optEls = el.querySelectorAll('.ci-option')

    // Stagger entrance
    if (typeof anime !== 'undefined' && optEls.length) {
      anime.animate(optEls, {
        opacity: [0, 1], y: [16, 0],
        duration: 0.3, delay: anime.stagger(0.08), ease: s.entranceEase,
      })
    }

    // Hover effects
    for (var j = 0; j < optEls.length; j++) {
      (function (optEl) {
        optEl.addEventListener('mouseenter', function () {
          if (!optEl.classList.contains('ci-selected')) {
            optEl.style.background = s.secondaryHover
          }
        })
        optEl.addEventListener('mouseleave', function () {
          if (!optEl.classList.contains('ci-selected')) {
            optEl.style.background = s.neutralBg
          }
        })
      })(optEls[j])
    }

    function selectOption(optEl) {
      var idx = parseInt(optEl.getAttribute('data-index'))
      var val = optEl.getAttribute('data-value')

      if (!multiSelect) {
        // Deselect others
        for (var k = 0; k < optEls.length; k++) {
          optEls[k].classList.remove('ci-selected')
          optEls[k].style.background = s.neutralBg
          optEls[k].style.border = s.secondaryBorder
          var chk = optEls[k].querySelector('.ci-check')
          if (chk) chk.style.display = 'none'
        }
        selected = [val]
      } else {
        var si = selected.indexOf(val)
        if (si >= 0) {
          selected.splice(si, 1)
          optEl.classList.remove('ci-selected')
          optEl.style.background = s.neutralBg
          optEl.style.border = s.secondaryBorder
          var unchk = optEl.querySelector('.ci-check')
          if (unchk) unchk.style.display = 'none'
          return
        }
        selected.push(val)
      }

      optEl.classList.add('ci-selected')
      optEl.style.background = s.primaryBg
      optEl.style.border = s.primaryBorder || s.border
      optEl.style.color = s.primaryText

      // Update text colors for selected state
      var titleEl = optEl.querySelector('div > div:first-child')
      if (titleEl) titleEl.style.color = s.primaryText
      var subEl = optEl.querySelector('div > div:last-child')
      if (subEl && subEl !== titleEl) subEl.style.color = s.primaryText

      var checkEl = optEl.querySelector('.ci-check')
      if (checkEl && showFeedback) {
        checkEl.style.display = 'flex'
        checkEl.style.background = s.primaryText
        checkEl.style.color = s.primaryBg
      }

      if (typeof anime !== 'undefined') {
        anime.animate(optEl, { scale: [0.97, 1], duration: 0.15 })
      }

      if (cfg.onSelect) cfg.onSelect(val, idx)

      if (multiSelect) {
        var contWrap = el.querySelector('.ci-continue-wrap')
        if (contWrap) contWrap.style.display = selected.length > 0 ? 'block' : 'none'
      } else {
        if (cfg.onComplete) {
          setTimeout(function () { cfg.onComplete(selected) }, 400)
        }
      }

      if (typeof Dreambyte !== 'undefined' && Dreambyte.interactionFired) {
        Dreambyte.interactionFired(id, 'choice')
      }
    }

    for (var m = 0; m < optEls.length; m++) {
      (function (oe) {
        oe.addEventListener('click', function () { selectOption(oe) })
      })(optEls[m])
    }

    // Multi-select continue button
    var contBtn = el.querySelector('.ci-continue')
    if (contBtn) {
      contBtn.addEventListener('click', function () {
        if (cfg.onComplete) cfg.onComplete(selected)
      })
    }

    return el
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 3: QUIZ
  // ══════════════════════════════════════════════════════════════════════════

  function quiz(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var maxAttempts = cfg.maxAttempts || 2
    var attempts = 0
    var correctIdx = Array.isArray(cfg.correct) ? cfg.correct : [cfg.correct]
    var qType = cfg.questionType || 'single'
    var inputType = qType === 'multiple' ? 'checkbox' : 'radio'
    var inputName = 'quiz_' + id

    var optionsHtml = ''
    var options = cfg.options || []
    for (var i = 0; i < options.length; i++) {
      var optText = typeof options[i] === 'string' ? options[i] : options[i].text
      optionsHtml += '<label class="ci-quiz-option" data-index="' + i + '" style="' +
        'display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:' + s.buttonRadius + ';' +
        'background:' + s.neutralBg + ';border:' + s.secondaryBorder + ';cursor:pointer;' +
        'transition:all 0.15s;font-family:' + s.fontFamily + ';">' +
        '<input type="' + inputType + '" name="' + inputName + '" value="' + i + '" ' +
          'style="accent-color:' + s.checkboxAccent + ';width:16px;height:16px;cursor:pointer;">' +
        '<span style="flex:1;font-size:' + s.bodySize + ';color:' + s.titleColor + ';">' + escHtml(optText) + '</span>' +
        '<span class="ci-feedback" style="display:none;font-weight:bold;font-size:14px;"></span>' +
      '</label>'
    }

    var html = '<div id="' + id + '" style="' + containerCSS(s) + 'max-width:480px;min-width:300px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:' + s.gap + ';">' +
        '<span style="font-size:' + s.labelSize + ';font-weight:' + s.labelWeight + ';color:' + s.labelColor + ';letter-spacing:' + s.labelTracking + ';text-transform:' + s.labelTransform + ';">Quiz</span>' +
        '<span class="ci-attempts" style="font-size:' + s.labelSize + ';color:' + s.labelColor + ';">' + maxAttempts + ' attempts</span>' +
      '</div>' +
      '<div style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';margin-bottom:' + s.gap + ';line-height:1.4;">' + escHtml(cfg.question) + '</div>' +
      '<div class="ci-quiz-options" style="display:flex;flex-direction:column;gap:' + s.gap + ';">' +
        optionsHtml +
      '</div>' +
      (cfg.hint ? '<div class="ci-hint" style="display:none;margin-top:' + s.gap + ';padding:10px 14px;background:' + s.neutralBg + ';border-radius:' + s.buttonRadius + ';font-size:' + s.bodySize + ';color:' + s.bodyColor + ';font-family:' + s.fontFamily + ';">Hint: ' + escHtml(cfg.hint) + '</div>' : '') +
      '<span class="ci-submit" style="' + btnCSS(s, 'primary') + 'margin-top:' + s.gap + ';width:100%;opacity:0.5;pointer-events:none;">Check answer</span>' +
      '<div class="ci-explanation" style="display:none;margin-top:' + s.gap + ';padding:14px 16px;background:' + s.correctBg + ';border:' + s.correctBorder + ';border-radius:' + s.buttonRadius + ';">' +
        '<div style="display:flex;align-items:flex-start;gap:8px;">' +
          '<span style="font-size:18px;flex-shrink:0;">&#x1F4A1;</span>' +
          '<span style="font-size:' + s.bodySize + ';color:' + s.correctText + ';line-height:1.5;">' + escHtml(cfg.explanation || '') + '</span>' +
        '</div>' +
      '</div>' +
    '</div>'

    var el = mount(html, cfg.position || 'center', s)
    animateIn(el, s)

    var submitBtn = el.querySelector('.ci-submit')
    var attemptsEl = el.querySelector('.ci-attempts')
    var hintEl = el.querySelector('.ci-hint')
    var explanationEl = el.querySelector('.ci-explanation')
    var optionEls = el.querySelectorAll('.ci-quiz-option')
    var inputs = el.querySelectorAll('input[name="' + inputName + '"]')
    var answered = false

    // Enable submit when selection made
    for (var j = 0; j < inputs.length; j++) {
      inputs[j].addEventListener('change', function () {
        if (!answered) {
          submitBtn.style.opacity = '1'
          submitBtn.style.pointerEvents = 'auto'
        }
      })
    }

    // Hover on options
    for (var h = 0; h < optionEls.length; h++) {
      (function (oel) {
        oel.addEventListener('mouseenter', function () {
          if (!answered) oel.style.background = s.secondaryHover
        })
        oel.addEventListener('mouseleave', function () {
          if (!answered) oel.style.background = s.neutralBg
        })
      })(optionEls[h])
    }

    submitBtn.addEventListener('click', function () {
      if (answered) return
      var selectedIndices = []
      for (var k = 0; k < inputs.length; k++) {
        if (inputs[k].checked) selectedIndices.push(k)
      }
      if (selectedIndices.length === 0) return

      attempts++
      var remaining = maxAttempts - attempts
      attemptsEl.textContent = remaining + ' attempt' + (remaining !== 1 ? 's' : '')

      // Check correctness
      var isCorrect = false
      if (qType === 'multiple') {
        isCorrect = selectedIndices.length === correctIdx.length &&
          selectedIndices.every(function (si) { return correctIdx.indexOf(si) >= 0 })
      } else {
        isCorrect = correctIdx.indexOf(selectedIndices[0]) >= 0
      }

      if (isCorrect) {
        answered = true
        for (var c = 0; c < optionEls.length; c++) {
          var fb = optionEls[c].querySelector('.ci-feedback')
          if (correctIdx.indexOf(c) >= 0) {
            optionEls[c].style.background = s.correctBg
            optionEls[c].style.border = s.correctBorder
            fb.textContent = s.correctIcon
            fb.style.color = s.correctText
            fb.style.display = 'block'
          }
          optionEls[c].style.cursor = 'default'
          optionEls[c].querySelector('input').disabled = true
        }
        submitBtn.style.display = 'none'

        if (cfg.showExplanationAlways !== false) {
          explanationEl.style.display = 'block'
          if (typeof anime !== 'undefined') anime.animate(explanationEl, { opacity: [0, 1], y: [8, 0], duration: 0.3 })
        }

        if (cfg.onCorrect) setTimeout(cfg.onCorrect, 600)
        if (cfg.onComplete) setTimeout(function () { cfg.onComplete(true, attempts) }, 600)

        if (typeof Dreambyte !== 'undefined' && Dreambyte.interactionFired) {
          Dreambyte.interactionFired(id, 'quiz_correct')
        }
      } else {
        // Wrong answer
        for (var w = 0; w < selectedIndices.length; w++) {
          var wrongEl = optionEls[selectedIndices[w]]
          wrongEl.style.background = s.incorrectBg
          wrongEl.style.border = s.incorrectBorder
          var wfb = wrongEl.querySelector('.ci-feedback')
          wfb.textContent = s.incorrectIcon
          wfb.style.color = s.incorrectText
          wfb.style.display = 'block'

          // Shake + reset after delay
          wrongEl.classList.add('ci-shake')
          setTimeout((function (we) {
            return function () {
              we.classList.remove('ci-shake')
              we.style.background = s.neutralBg
              we.style.border = s.secondaryBorder
              we.querySelector('.ci-feedback').style.display = 'none'
            }
          })(wrongEl), 600)
        }

        if (remaining <= 0) {
          // Out of attempts — reveal answer
          answered = true
          setTimeout(function () {
            for (var r = 0; r < optionEls.length; r++) {
              var rfb = optionEls[r].querySelector('.ci-feedback')
              if (correctIdx.indexOf(r) >= 0) {
                optionEls[r].style.background = s.correctBg
                optionEls[r].style.border = s.correctBorder
                rfb.textContent = s.correctIcon
                rfb.style.color = s.correctText
                rfb.style.display = 'block'
              }
              optionEls[r].style.cursor = 'default'
              optionEls[r].querySelector('input').disabled = true
            }
            submitBtn.style.display = 'none'
            explanationEl.style.display = 'block'
            if (typeof anime !== 'undefined') anime.animate(explanationEl, { opacity: [0, 1], y: [8, 0], duration: 0.3 })
            if (cfg.onComplete) cfg.onComplete(false, attempts)
          }, 700)
        } else {
          // Show hint after 2nd wrong attempt
          if (hintEl && attempts >= 2) {
            hintEl.style.display = 'block'
            if (typeof anime !== 'undefined') anime.animate(hintEl, { opacity: [0, 1], duration: 0.2 })
          }
          // Reset inputs
          for (var ri = 0; ri < inputs.length; ri++) inputs[ri].checked = false
          submitBtn.style.opacity = '0.5'
          submitBtn.style.pointerEvents = 'none'
        }
      }
    })

    return el
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 4: GATE
  // ══════════════════════════════════════════════════════════════════════════

  function gate(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var type = cfg.type || 'timer'
    var duration = cfg.duration || 10
    var showProgress = cfg.showProgress !== false
    var blurContent = cfg.blurContent || false
    var lockMsg = cfg.lockMessage || 'Complete this section to continue'
    var unlockMsg = cfg.unlockMessage || 'Ready! Continue \u2192'
    var unlocked = false

    var html = '<div id="' + id + '" style="position:absolute;inset:0;z-index:1000;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.3);">' +
      '<div class="ci-gate-panel" style="' + containerCSS(s) + 'text-align:center;max-width:400px;min-width:280px;">' +
        '<div class="ci-lock-icon" style="font-size:36px;margin-bottom:12px;">&#x1F512;</div>' +
        '<div class="ci-gate-msg" style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';margin-bottom:16px;line-height:1.4;">' + escHtml(lockMsg) + '</div>' +
        (showProgress ? '<div class="ci-progress-wrap" style="width:100%;height:4px;background:' + s.neutralBg + ';border-radius:2px;overflow:hidden;margin-bottom:16px;">' +
          '<div class="ci-progress-bar" style="width:0%;height:100%;background:' + s.gateProgressColor + ';border-radius:2px;transition:width 0.3s;"></div>' +
        '</div>' : '') +
        '<span class="ci-gate-btn" style="' + btnCSS(s, 'primary') + 'width:100%;opacity:0.4;pointer-events:none;">Continue \u2192</span>' +
      '</div>' +
    '</div>'

    var el = mount(html, null, s)
    animateIn(el.querySelector('.ci-gate-panel'), s)

    var lockIcon = el.querySelector('.ci-lock-icon')
    var gateMsg = el.querySelector('.ci-gate-msg')
    var progressBar = el.querySelector('.ci-progress-bar')
    var gateBtn = el.querySelector('.ci-gate-btn')

    // Apply blur to scene content behind gate
    if (blurContent) {
      var sceneRoot = document.getElementById('scene') || document.body
      var children = sceneRoot.children
      for (var c = 0; c < children.length; c++) {
        if (children[c].id !== 'ci-layer') {
          children[c].style.filter = 'blur(4px)'
          children[c].style.transition = 'filter 0.5s'
        }
      }
    }

    function unlock() {
      if (unlocked) return
      unlocked = true

      lockIcon.textContent = '\uD83D\uDD13' // unlocked padlock emoji
      gateMsg.textContent = unlockMsg

      if (typeof anime !== 'undefined') {
        anime.animate(lockIcon, {
          scale: [
            { from: 0.8, to: 1.1, duration: 0.4, ease: 'outBack(2)' },
            { to: 1, duration: 0.2 },
          ],
        })
      }

      gateBtn.style.opacity = '1'
      gateBtn.style.pointerEvents = 'auto'
      gateBtn.style.setProperty('--ci-pulse-color', s.primaryBg)
      gateBtn.classList.add('ci-gate-btn-pulse')

      if (cfg.onUnlock) cfg.onUnlock()

      if (typeof Dreambyte !== 'undefined' && Dreambyte.interactionFired) {
        Dreambyte.interactionFired(id, 'gate_unlock')
      }
    }

    // Gate continue action
    gateBtn.addEventListener('click', function () {
      if (!unlocked) return
      if (blurContent) {
        var sr = document.getElementById('scene') || document.body
        var ch = sr.children
        for (var ci = 0; ci < ch.length; ci++) {
          if (ch[ci].id !== 'ci-layer') ch[ci].style.filter = 'none'
        }
      }
      animateOut(el, s, function () {
        if (cfg.onContinue) cfg.onContinue()
      })
    })

    // Gate type: timer
    if (type === 'timer') {
      var startTime = Date.now()
      var timerInterval = setInterval(function () {
        var elapsed = (Date.now() - startTime) / 1000
        var pct = Math.min(elapsed / duration, 1)
        if (progressBar) progressBar.style.width = (pct * 100) + '%'
        if (pct >= 1) {
          clearInterval(timerInterval)
          unlock()
        }
      }, 100)
    }

    // Gate type: scroll
    if (type === 'scroll') {
      var scrollDepth = cfg.scrollDepth || 0.8
      var sceneEl = document.getElementById('scene') || document.body
      function checkScroll() {
        var scrollPct = sceneEl.scrollTop / (sceneEl.scrollHeight - sceneEl.clientHeight || 1)
        if (progressBar) progressBar.style.width = (Math.min(scrollPct / scrollDepth, 1) * 100) + '%'
        if (scrollPct >= scrollDepth) {
          sceneEl.removeEventListener('scroll', checkScroll)
          unlock()
        }
      }
      sceneEl.addEventListener('scroll', checkScroll)
    }

    // Gate type: interaction
    if (type === 'interaction' && cfg.requiredInteraction) {
      var target = document.getElementById(cfg.requiredInteraction)
      if (target) {
        target.addEventListener('click', function () { unlock() }, { once: true })
      }
    }

    // Gate type: custom
    if (type === 'custom' && cfg.condition) {
      var customInterval = setInterval(function () {
        if (cfg.condition()) {
          clearInterval(customInterval)
          unlock()
        }
      }, 200)
    }

    // Gate type: quiz_pass — expose unlock for external wiring
    if (type === 'quiz_pass') {
      el._unlock = unlock
    }

    return el
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 5: TOOLTIP
  // ══════════════════════════════════════════════════════════════════════════

  function tooltip(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var trigger = cfg.trigger || 'always'
    var maxW = cfg.maxWidth || 260
    var dir = cfg.direction || 'auto'
    var showArrow = cfg.showArrow !== false
    var dismissible = cfg.dismissible || false
    var highlight = cfg.highlight || false

    // Resolve anchor position
    var anchorEl = null
    var anchorX = 0, anchorY = 0
    if (typeof cfg.anchor === 'string') {
      anchorEl = document.querySelector(cfg.anchor)
      if (anchorEl) {
        var rect = anchorEl.getBoundingClientRect()
        var layerRect = getLayer().getBoundingClientRect()
        anchorX = rect.left - layerRect.left + rect.width / 2
        anchorY = rect.top - layerRect.top + rect.height / 2
      }
    } else if (cfg.anchor && cfg.anchor.x !== undefined) {
      anchorX = cfg.anchor.x
      anchorY = cfg.anchor.y
    }

    var resolvedDir = calcDirection(anchorX, anchorY, dir, maxW, 100)

    // Arrow CSS
    var arrowSize = 6
    var arrowCSS = ''
    if (showArrow) {
      var arrowBorder = 'solid ' + arrowSize + 'px transparent'
      if (resolvedDir === 'top') {
        arrowCSS = 'position:absolute;left:50%;bottom:-' + (arrowSize * 2) + 'px;transform:translateX(-50%);' +
          'border-left:' + arrowBorder + ';border-right:' + arrowBorder + ';' +
          'border-top:solid ' + arrowSize + 'px ' + s.bg + ';border-bottom:none;width:0;height:0;'
      } else if (resolvedDir === 'bottom') {
        arrowCSS = 'position:absolute;left:50%;top:-' + (arrowSize * 2) + 'px;transform:translateX(-50%);' +
          'border-left:' + arrowBorder + ';border-right:' + arrowBorder + ';' +
          'border-bottom:solid ' + arrowSize + 'px ' + s.bg + ';border-top:none;width:0;height:0;'
      } else if (resolvedDir === 'left') {
        arrowCSS = 'position:absolute;top:50%;right:-' + (arrowSize * 2) + 'px;transform:translateY(-50%);' +
          'border-top:' + arrowBorder + ';border-bottom:' + arrowBorder + ';' +
          'border-left:solid ' + arrowSize + 'px ' + s.bg + ';border-right:none;width:0;height:0;'
      } else {
        arrowCSS = 'position:absolute;top:50%;left:-' + (arrowSize * 2) + 'px;transform:translateY(-50%);' +
          'border-top:' + arrowBorder + ';border-bottom:' + arrowBorder + ';' +
          'border-right:solid ' + arrowSize + 'px ' + s.bg + ';border-left:none;width:0;height:0;'
      }
    }

    // Calculate tooltip position relative to anchor
    var tooltipX = anchorX, tooltipY = anchorY
    var offset = 14
    if (resolvedDir === 'top') { tooltipY = anchorY - offset }
    else if (resolvedDir === 'bottom') { tooltipY = anchorY + offset }
    else if (resolvedDir === 'left') { tooltipX = anchorX - offset }
    else { tooltipX = anchorX + offset }

    var translateCSS = ''
    var transformOrigin = ''
    if (resolvedDir === 'top') {
      translateCSS = 'transform:translateX(-50%) translateY(-100%);'
      transformOrigin = 'bottom center'
    } else if (resolvedDir === 'bottom') {
      translateCSS = 'transform:translateX(-50%);'
      transformOrigin = 'top center'
    } else if (resolvedDir === 'left') {
      translateCSS = 'transform:translateX(-100%) translateY(-50%);'
      transformOrigin = 'center right'
    } else {
      translateCSS = 'transform:translateY(-50%);'
      transformOrigin = 'center left'
    }

    var html = '<div id="' + id + '" style="position:absolute;left:' + tooltipX + 'px;top:' + tooltipY + 'px;' + translateCSS + 'z-index:115;">' +
      '<div class="ci-tooltip-bubble" style="' + containerCSS(s) + 'max-width:' + maxW + 'px;position:relative;transform-origin:' + transformOrigin + ';">' +
        (showArrow ? '<div style="' + arrowCSS + '"></div>' : '') +
        (cfg.title || dismissible ?
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
            (cfg.title ? '<span style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';">' + escHtml(cfg.title) + '</span>' : '<span></span>') +
            (dismissible ? '<span class="ci-dismiss" style="cursor:pointer;color:' + s.labelColor + ';font-size:16px;line-height:1;padding:0 0 0 8px;">&times;</span>' : '') +
          '</div>' : '') +
        '<div style="font-size:' + s.bodySize + ';color:' + s.bodyColor + ';line-height:1.5;">' + escHtml(cfg.content || '') + '</div>' +
      '</div>' +
    '</div>'

    // Highlight ring on anchor
    if (highlight && anchorEl) {
      var ring = document.createElement('div')
      ring.className = 'ci-tooltip-ring ci-hotspot-pulse'
      ring.style.cssText = 'position:absolute;inset:-4px;border:2px solid ' + s.primaryBg + ';border-radius:' + s.borderRadius + ';pointer-events:none;opacity:0.4;'
      anchorEl.style.position = anchorEl.style.position || 'relative'
      anchorEl.appendChild(ring)
    }

    function show() {
      var tooltipEl = mount(html, null, s)
      animateIn(tooltipEl, s)

      var dismissBtn = tooltipEl.querySelector('.ci-dismiss')
      if (dismissBtn) {
        dismissBtn.addEventListener('click', function () {
          animateOut(tooltipEl, s)
        })
      }

      return tooltipEl
    }

    if (trigger === 'always') {
      return show()
    }

    if (trigger === 'delay') {
      var delayMs = (cfg.delay || 3) * 1000
      setTimeout(function () { show() }, delayMs)
      return null
    }

    if (trigger === 'hover' && anchorEl) {
      var hoverEl = null
      anchorEl.addEventListener('mouseenter', function () {
        if (!hoverEl || !hoverEl.parentNode) hoverEl = show()
      })
      anchorEl.addEventListener('mouseleave', function () {
        if (hoverEl && hoverEl.parentNode) {
          animateOut(hoverEl, s)
          hoverEl = null
        }
      })
      return null
    }

    if (trigger === 'click' && anchorEl) {
      var clickEl = null
      anchorEl.addEventListener('click', function () {
        if (clickEl && clickEl.parentNode) {
          animateOut(clickEl, s)
          clickEl = null
        } else {
          clickEl = show()
        }
      })
      return null
    }

    return show()
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPONENT 6: FORM
  // ══════════════════════════════════════════════════════════════════════════

  function form(cfg) {
    if (IS_RENDER) return null
    injectCSS()
    var s = resolveStyle(cfg.style)
    var id = uid()
    var fields = cfg.fields || []
    var submitLabel = cfg.submitLabel || 'Submit'
    var confirmMsg = cfg.confirmationMessage || 'Thank you!'
    var confirmIcon = cfg.confirmationIcon || '\u2713'

    var fieldsHtml = ''
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i]
      var fid = id + '-f-' + (f.id || i)
      var inputHtml = ''

      if (f.type === 'select') {
        var optsHtml = '<option value="">Select...</option>'
        for (var o = 0; o < (f.options || []).length; o++) {
          optsHtml += '<option value="' + escHtml(f.options[o]) + '">' + escHtml(f.options[o]) + '</option>'
        }
        inputHtml = '<select id="' + fid + '" class="ci-field-input" data-field="' + escHtml(f.id || '' + i) + '" ' +
          'style="width:100%;padding:10px 12px;border:' + s.secondaryBorder + ';border-radius:' + s.inputRadius + ';' +
          'background:' + s.neutralBg + ';color:' + s.titleColor + ';font-family:' + s.fontFamily + ';' +
          'font-size:' + s.bodySize + ';outline:none;">' + optsHtml + '</select>'
      } else if (f.type === 'textarea') {
        inputHtml = '<textarea id="' + fid + '" class="ci-field-input" data-field="' + escHtml(f.id || '' + i) + '" ' +
          'placeholder="' + escHtml(f.placeholder || '') + '" rows="3" ' +
          'style="width:100%;padding:10px 12px;border:' + s.secondaryBorder + ';border-radius:' + s.inputRadius + ';' +
          'background:' + s.neutralBg + ';color:' + s.titleColor + ';font-family:' + s.fontFamily + ';' +
          'font-size:' + s.bodySize + ';outline:none;resize:vertical;"></textarea>'
      } else if (f.type === 'checkbox') {
        inputHtml = '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
          '<input id="' + fid + '" type="checkbox" class="ci-field-input" data-field="' + escHtml(f.id || '' + i) + '" ' +
          'style="accent-color:' + s.checkboxAccent + ';width:16px;height:16px;">' +
          '<span style="font-size:' + s.bodySize + ';color:' + s.bodyColor + ';">' + escHtml(f.label || '') + '</span>' +
        '</label>'
      } else if (f.type === 'radio') {
        inputHtml = '<div class="ci-radio-group" data-field="' + escHtml(f.id || '' + i) + '">'
        for (var r = 0; r < (f.options || []).length; r++) {
          inputHtml += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:6px;">' +
            '<input type="radio" name="' + fid + '" value="' + escHtml(f.options[r]) + '" class="ci-field-input" data-field="' + escHtml(f.id || '' + i) + '" ' +
            'style="accent-color:' + s.checkboxAccent + ';width:16px;height:16px;">' +
            '<span style="font-size:' + s.bodySize + ';color:' + s.bodyColor + ';">' + escHtml(f.options[r]) + '</span>' +
          '</label>'
        }
        inputHtml += '</div>'
      } else {
        inputHtml = '<input id="' + fid + '" type="' + escHtml(f.type || 'text') + '" class="ci-field-input" ' +
          'data-field="' + escHtml(f.id || '' + i) + '" placeholder="' + escHtml(f.placeholder || '') + '" ' +
          'style="width:100%;padding:10px 12px;border:' + s.secondaryBorder + ';border-radius:' + s.inputRadius + ';' +
          'background:' + s.neutralBg + ';color:' + s.titleColor + ';font-family:' + s.fontFamily + ';' +
          'font-size:' + s.bodySize + ';outline:none;">'
      }

      fieldsHtml += '<div class="ci-field-wrap" style="margin-bottom:' + s.gap + ';">' +
        (f.type !== 'checkbox' ? '<label style="display:block;font-size:' + s.labelSize + ';font-weight:' + s.labelWeight + ';color:' + s.labelColor + ';' +
          'letter-spacing:' + s.labelTracking + ';text-transform:' + s.labelTransform + ';margin-bottom:6px;">' +
          escHtml(f.label || '') + (f.required ? ' <span style="color:' + s.incorrectText + ';">*</span>' : '') +
        '</label>' : '') +
        inputHtml +
        '<div class="ci-field-error" data-for="' + escHtml(f.id || '' + i) + '" style="display:none;font-size:' + s.labelSize + ';color:' + s.incorrectText + ';margin-top:4px;">' +
          escHtml(f.errorMessage || 'This field is required') +
        '</div>' +
      '</div>'
    }

    var html = '<div id="' + id + '" style="' + containerCSS(s) + 'max-width:440px;min-width:300px;">' +
      '<div class="ci-form-content">' +
        (cfg.title ? '<div style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';margin-bottom:4px;">' + escHtml(cfg.title) + '</div>' : '') +
        (cfg.subtitle ? '<div style="font-size:' + s.bodySize + ';color:' + s.bodyColor + ';margin-bottom:' + s.gap + ';">' + escHtml(cfg.subtitle) + '</div>' : '') +
        fieldsHtml +
        '<span class="ci-form-submit" style="' + btnCSS(s, 'primary') + 'width:100%;margin-top:4px;">' + escHtml(submitLabel) + '</span>' +
      '</div>' +
      '<div class="ci-form-confirm" style="display:none;text-align:center;padding:20px 0;">' +
        '<div class="ci-confirm-icon" style="font-size:48px;margin-bottom:12px;">' + escHtml(confirmIcon) + '</div>' +
        '<div style="font-size:' + s.titleSize + ';font-weight:' + s.titleWeight + ';color:' + s.titleColor + ';line-height:1.4;">' + escHtml(confirmMsg) + '</div>' +
      '</div>' +
    '</div>'

    var el = mount(html, cfg.position || 'center', s)
    animateIn(el, s)

    var formContent = el.querySelector('.ci-form-content')
    var formConfirm = el.querySelector('.ci-form-confirm')
    var submitBtn = el.querySelector('.ci-form-submit')

    // Real-time blur validation
    var allInputs = el.querySelectorAll('.ci-field-input')
    for (var v = 0; v < allInputs.length; v++) {
      (function (inp) {
        inp.addEventListener('blur', function () {
          validateField(inp)
        })
      })(allInputs[v])
    }

    function validateField(inp) {
      var fieldId = inp.getAttribute('data-field')
      var fieldCfg = null
      for (var fi = 0; fi < fields.length; fi++) {
        if ((fields[fi].id || '' + fi) === fieldId) { fieldCfg = fields[fi]; break }
      }
      if (!fieldCfg) return true

      var val = inp.type === 'checkbox' ? inp.checked : inp.value
      var errorEl = el.querySelector('.ci-field-error[data-for="' + fieldId + '"]')
      var valid = true

      if (fieldCfg.required && !val) valid = false
      if (valid && fieldCfg.validation) {
        if (fieldCfg.validation instanceof RegExp) {
          valid = fieldCfg.validation.test(val)
        } else if (typeof fieldCfg.validation === 'function') {
          valid = fieldCfg.validation(val)
        }
      }

      if (errorEl) {
        errorEl.style.display = valid ? 'none' : 'block'
      }
      inp.style.borderColor = valid ? '' : s.incorrectText

      return valid
    }

    submitBtn.addEventListener('click', function () {
      // Validate all fields
      var allValid = true
      var firstInvalid = null
      var data = {}

      for (var si = 0; si < fields.length; si++) {
        var fld = fields[si]
        var fldId = fld.id || '' + si
        var fldInputs = el.querySelectorAll('[data-field="' + fldId + '"]')
        var val = ''

        if (fld.type === 'radio') {
          for (var ri = 0; ri < fldInputs.length; ri++) {
            if (fldInputs[ri].checked) val = fldInputs[ri].value
          }
        } else if (fld.type === 'checkbox') {
          val = fldInputs[0] && fldInputs[0].checked
        } else if (fldInputs[0]) {
          val = fldInputs[0].value
        }

        data[fldId] = val

        if (fldInputs[0] && !validateField(fldInputs[0])) {
          allValid = false
          if (!firstInvalid) firstInvalid = fldInputs[0]
        }
      }

      if (!allValid) {
        el.classList.add('ci-shake')
        setTimeout(function () { el.classList.remove('ci-shake') }, 300)
        if (firstInvalid) firstInvalid.focus()
        return
      }

      // Submit
      submitBtn.textContent = '...'
      submitBtn.style.opacity = '0.6'
      submitBtn.style.pointerEvents = 'none'

      var result = cfg.onSubmit ? cfg.onSubmit(data) : undefined
      var afterSubmit = function () {
        if (typeof anime !== 'undefined') {
          anime.animate(formContent, {
            opacity: 0, duration: 0.2,
            onComplete: function () {
              formContent.style.display = 'none'
              formConfirm.style.display = 'block'
              anime.animate(formConfirm, { opacity: [0, 1], duration: 0.3 })

              var icon = formConfirm.querySelector('.ci-confirm-icon')
              if (icon) {
                anime.animate(icon, { scale: [0.5, 1], duration: 0.4, ease: 'outBack(2)' })
              }
            }
          })
        } else {
          formContent.style.display = 'none'
          formConfirm.style.display = 'block'
        }

        if (cfg.onComplete) setTimeout(cfg.onComplete, 1500)

        if (typeof Dreambyte !== 'undefined' && Dreambyte.interactionFired) {
          Dreambyte.interactionFired(id, 'form_submit')
        }
      }

      if (result && typeof result.then === 'function') {
        result.then(afterSubmit)
      } else {
        afterSubmit()
      }
    })

    return el
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════

  var DreambyteInteract = {
    hotspot: hotspot,
    choice: choice,
    quiz: quiz,
    gate: gate,
    tooltip: tooltip,
    form: form,

    // Utilities for advanced usage
    _mount: mount,
    _resolveStyle: resolveStyle,
    _detectStyle: detectStyle,
    _getLayer: getLayer,
    _styles: STYLES
  }

  global.DreambyteInteract = DreambyteInteract

})(typeof window !== 'undefined' ? window : this)
