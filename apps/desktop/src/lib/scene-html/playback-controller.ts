/**
 * Universal playback controller injected into every scene HTML.
 *
 * Creates window.__tl — the master anime.js Timeline (autoplay off). Scene code
 * only ADDS children to it; this controller owns play / pause / seek.
 * Parent app controls playback via postMessage; same-origin hosts (export,
 * verifier, compositor) drive it synchronously through window.__clock:
 *   __clock.seek(t)      frame-exact synchronous render at t seconds
 *   __clock.time() / duration() / isActive() / childCount() / play() / pause()
 * Scene-side helpers: window.__dreambyte.time(), window.__dreambyte.onTick(cb).
 *
 * Must be injected AFTER anime.js loads (anime-head.ts, which sets
 * anime.engine.timeUnit = 's') and scene globals are set, but BEFORE
 * scene-specific code runs.
 */

import { TYPOGRAPHY_PROPS } from '../code-text-slots'

// Build the iframe-side SVG attribute lookup from the same descriptor
// table the parent uses. Keeping these in sync by hand has bitten us
// before — fontStyle / textAlign were missing from the hand-written
// switch and silently failed to live-preview on <text> elements.
const SVG_TEXT_ATTR_MAP_JSON = JSON.stringify(
  Object.fromEntries(TYPOGRAPHY_PROPS.filter((d) => d.svgAttr).map((d) => [d.key, d.svgAttr])),
)

export const PLAYBACK_CONTROLLER = `
(function() {
  // ── Animation-runtime-missing guard (C4b) ─────────────────
  // The whole controller builds on an anime.js master timeline, so the FIRST thing
  // it does (anime.createTimeline(...)) throws when anime is undefined —
  // offline with a CDN-only <head>, or a vendored file that failed to load. That
  // throw kills the IIFE BEFORE the message listener below is installed, so the
  // scene reads as a dead transport: the parent's play/seek messages hit nothing,
  // and the only signal is the iframe 'load' event (which still fires), so there
  // is no safety net. Install a minimal listener + post an init_error beacon
  // FIRST, so the parent treats this scene like a verify-errored one (skippable)
  // instead of freezing the build. (anime-head.ts loads a LOCAL vendored copy
  // first to make this path rare; this is the belt-and-braces net.)
  if (typeof anime === 'undefined' || typeof anime.createTimeline !== 'function') {
    var _initErrSceneId = typeof SCENE_ID !== 'undefined' ? SCENE_ID : null;
    function _postInit(msg) {
      try {
        window.parent.postMessage(
          Object.assign({ source: 'dreambyte-scene', sceneId: _initErrSceneId }, msg),
          '*'
        );
      } catch (e) {}
    }
    // Minimal transport responder so parent polls don't hang on a dead scene.
    window.addEventListener('message', function(ev) {
      if (!ev.data || ev.data.target !== 'dreambyte-scene') return;
      if (ev.source && ev.source !== window.parent) return;
      if (ev.data.sceneId && _initErrSceneId && ev.data.sceneId !== _initErrSceneId) return;
      if (ev.data.type === 'get_state') {
        _postInit({ type: 'state', currentTime: 0, duration: 0, status: 'error' });
      }
      // play / pause / seek are intentionally no-ops — there is no timeline.
    });
    _postInit({ type: 'init_error', error: 'anime.js failed to load (offline / missing vendor asset)' });
    // Still emit 'ready' so any loader that only waits for ready doesn't hang,
    // but the init_error above is what the parent acts on.
    window.addEventListener('load', function() {
      _postInit({ type: 'ready', duration: 0, sceneId: _initErrSceneId, initError: true });
    });
    return;
  }

  // ── performance.now() interception ──────────────────────
  // Canvas2D scenes compute animation time via:
  //   getT() = (performance.now() - startWall) / 1000
  // When RAF is blocked (paused), elapsed wall-clock time
  // shouldn't count toward animation time. We subtract
  // cumulative paused duration from performance.now().
  var _perfNow = performance.now.bind(performance);
  var _pauseOffset = 0;
  var _pauseStart = _perfNow(); // starts paused

  performance.now = function() {
    return _perfNow() - _pauseOffset;
  };

  // ── RAF interception ─────────────────────────────────────
  // Prevent old canvas2d/three.js scenes from auto-starting
  // their requestAnimationFrame loops. We capture the callback
  // and only start it when the parent sends 'play'.
  var _realRAF = window.requestAnimationFrame.bind(window);
  var _realCAF = window.cancelAnimationFrame.bind(window);
  var _realSetTimeout = window.setTimeout.bind(window);
  var _realClearTimeout = window.clearTimeout.bind(window);
  var _realSetInterval = window.setInterval.bind(window);
  var _realClearInterval = window.clearInterval.bind(window);
  // Expose native RAF/CAF so runtime widgets can bypass interception.
  window.__nativeRAF = _realRAF;
  window.__nativeCAF = _realCAF;
  var _pendingRAFCallbacks = [];
  var _rafBlocked = true;  // starts blocked
  var _currentRAFId = null;
  var _timersBlocked = true; // starts blocked (playback paused)
  var _nextQueuedTimerId = 1;
  var _queuedTimeouts = [];
  var _queuedTimeoutMap = {};
  var _activeTimeouts = {};
  var _activeIntervals = {};

  function _flushQueuedTimeouts() {
    if (_timersBlocked || _queuedTimeouts.length === 0) return;
    var queue = _queuedTimeouts.slice();
    _queuedTimeouts = [];
    queue.forEach(function(item) {
      if (!item || !_queuedTimeoutMap[item.id]) return;
      delete _queuedTimeoutMap[item.id];
      var realId = _realSetTimeout(function() {
        delete _activeTimeouts[item.id];
        if (_timersBlocked) {
          _queuedTimeoutMap[item.id] = item;
          _queuedTimeouts.push(item);
          return;
        }
        try { item.cb(); } catch(e) {}
      }, Math.max(0, item.delay || 0));
      _activeTimeouts[item.id] = realId;
    });
  }

  window.setTimeout = function(cb, delay) {
    if (typeof cb !== 'function') {
      return _realSetTimeout(cb, delay);
    }
    var id = _nextQueuedTimerId++;
    var item = { id: id, cb: cb, delay: Number(delay) || 0 };
    if (_timersBlocked) {
      _queuedTimeoutMap[id] = item;
      _queuedTimeouts.push(item);
      return -id;
    }
    var realId = _realSetTimeout(function() {
      delete _activeTimeouts[id];
      if (_timersBlocked) {
        _queuedTimeoutMap[id] = item;
        _queuedTimeouts.push(item);
        return;
      }
      try { cb(); } catch(e) {}
    }, Math.max(0, item.delay));
    _activeTimeouts[id] = realId;
    return id;
  };

  window.clearTimeout = function(id) {
    var absId = Math.abs(Number(id));
    if (!absId) {
      _realClearTimeout(id);
      return;
    }
    if (_queuedTimeoutMap[absId]) {
      delete _queuedTimeoutMap[absId];
      _queuedTimeouts = _queuedTimeouts.filter(function(item) { return item.id !== absId; });
      return;
    }
    if (_activeTimeouts[absId]) {
      _realClearTimeout(_activeTimeouts[absId]);
      delete _activeTimeouts[absId];
      return;
    }
    _realClearTimeout(id);
  };

  window.setInterval = function(cb, delay) {
    if (typeof cb !== 'function') {
      return _realSetInterval(cb, delay);
    }
    var id = _nextQueuedTimerId++;
    var realId = _realSetInterval(function() {
      if (_timersBlocked) return;
      try { cb(); } catch(e) {}
    }, Math.max(1, Number(delay) || 0));
    _activeIntervals[id] = realId;
    return id;
  };

  window.clearInterval = function(id) {
    var absId = Math.abs(Number(id));
    if (absId && _activeIntervals[absId]) {
      _realClearInterval(_activeIntervals[absId]);
      delete _activeIntervals[absId];
      return;
    }
    _realClearInterval(id);
  };

  window.requestAnimationFrame = function(cb) {
    if (_rafBlocked) {
      // Queue the callback — multiple consumers (scene code + SDK runtimes) may register
      var queueId = -(_pendingRAFCallbacks.length + 1);
      _pendingRAFCallbacks.push(cb);
      return queueId;
    }
    _currentRAFId = _realRAF(cb);
    return _currentRAFId;
  };
  window.cancelAnimationFrame = function(id) {
    if (id < 0) {
      // Remove from pending queue
      var idx = (-id) - 1;
      if (idx < _pendingRAFCallbacks.length) _pendingRAFCallbacks[idx] = null;
      return;
    }
    _currentRAFId = null;
    _realCAF(id);
  };

  function _unblockRAF() {
    // Accumulate paused duration so performance.now() skips it
    if (_pauseStart !== null) {
      _pauseOffset += _perfNow() - _pauseStart;
      _pauseStart = null;
    }
    _rafBlocked = false;
    _timersBlocked = false;
    // Restore native requestAnimationFrame for future calls. Do NOT
    // restore native cancelAnimationFrame: the wrapper above delegates positive
    // (native) ids to _realCAF AND can still dequeue the negative ids minted
    // while blocked. Restoring native here meant a later re-pause re-blocked
    // requestAnimationFrame (negative queue ids) but left native CAF in place,
    // so those queued callbacks could never be cancelled and leaked into the
    // next play. Keeping the wrapper installed permanently closes that leak.
    window.requestAnimationFrame = _realRAF;
    // Reset the time origin for old canvas2d code that uses
    // window.startWall. (Local const startWall is handled by
    // the performance.now() interception above.)
    if (typeof window.startWall !== 'undefined') {
      window.startWall = performance.now();
    }
    // Also reset _startTime (used by some old Zdog/Three scenes)
    if (typeof window._startTime !== 'undefined') {
      window._startTime = performance.now();
    }
    _flushQueuedTimeouts();
    // Kick off all queued callbacks (scene code + SDK runtimes, etc.)
    var queued = _pendingRAFCallbacks.slice();
    _pendingRAFCallbacks = [];
    queued.forEach(function(cb) { if (cb) _realRAF(cb); });
    // Also call legacy __resume if scene code defined it
    if (window.__resume && window.__resume !== _legacyResume) {
      try { window.__resume(); } catch(e) {}
    }
  }

  function _blockRAF() {
    // Record pause start for performance.now() offset tracking
    if (_pauseStart === null) {
      _pauseStart = _perfNow();
    }
    _timersBlocked = true;
    _rafBlocked = true;
    // Cancel any in-flight RAF
    if (_currentRAFId) { _realCAF(_currentRAFId); _currentRAFId = null; }
    // Override RAF again to block new calls
    _pendingRAFCallbacks = [];
    window.requestAnimationFrame = function(cb) {
      var queueId = -(_pendingRAFCallbacks.length + 1);
      _pendingRAFCallbacks.push(cb);
      return queueId;
    };
    // Also call legacy __pause if scene code defined it
    if (window.__pause && window.__pause !== _legacyPause) {
      try { window.__pause(); } catch(e) {}
    }
  }

  // ── Master timeline + scene clock ────────────────────────
  // window.__tl is a plain anime.js Timeline that scene code fills (tl.add /
  // tl.set / tl.call / tl.label). It never plays on its own: the scene CLOCK
  // (an anime Timer spanning DURATION) is what plays, and every clock frame
  // renders __tl at the clock time. Keeping them apart means __tl stays an
  // idiomatic timeline (a child appended with no position lands after the
  // previous child, not after DURATION) while the scene always runs for exactly
  // DURATION and ends there even when the tweens finish earlier.
  // Edge case: if DURATION is missing or NaN, seek/play/scrub all break (duration 0).
  var _rawDur =
    typeof DURATION === 'number' && !isNaN(DURATION) && DURATION > 0
      ? DURATION
      : typeof window.DURATION === 'number' && !isNaN(window.DURATION) && window.DURATION > 0
        ? window.DURATION
        : 8;
  var _dreambyteDuration = Math.max(0.1, _rawDur);

  var masterTL = anime.createTimeline({ autoplay: false });
  var _tickCallbacks = [];
  var _primedChildCount = 0;

  function _childCount() {
    var n = 0;
    for (var c = masterTL._head; c; c = c._next) n++;
    return n;
  }

  // Render __tl at scene time t. anime.js only renders a child when the playhead
  // crosses it, so two things are needed for a frame-exact result regardless of
  // the previous time: (1) after children were added, init() force-renders every
  // child's end and then initial state (so a tween that starts later shows its
  // "from" values before it begins); (2) a forced render at the time the timeline
  // already sits at first nudges away with callbacks muted (seek(t) to the
  // current time is otherwise a no-op, so onUpdate proxies would not draw).
  // (3) anime.js renders values at exactly t=0 but fires no onUpdate/onRender
  // there, so a scrub back to 0 would leave proxy-drawn canvases on the old
  // frame: the timeline is rendered at 1µs instead (visually identical).
  function _renderTimeline(t, force) {
    var count = _childCount();
    if (count === 0) return;
    if (count !== _primedChildCount) {
      _primedChildCount = count;
      masterTL.init();
      force = true;
    }
    var d = masterTL.duration;
    var tt = Math.min(Math.max(0.000001, t), d);
    if (force && Math.abs(masterTL.currentTime - tt) < 1e-4) {
      masterTL.seek(tt >= 0.001 ? tt - 0.001 : Math.min(d, tt + 0.001), true);
    }
    masterTL.seek(tt);
    // (4) A jump that lands before a child's start (or after its end) resets its
    // values without calling its callbacks, so proxy-drawn output (canvas, three,
    // lottie frames) would stay on the previous frame. On host seeks, replay the
    // custom onUpdate / onRender of every child outside its active range — its
    // values are already correct, the callback just redraws from them.
    if (!force) return;
    var noop = anime.engine.defaults.onUpdate;
    for (var c = masterTL._head; c; c = c._next) {
      var start = c._offset + c._delay;
      if (tt >= start && tt <= start + c.duration) continue;
      try {
        if (c.onUpdate && c.onUpdate !== noop) c.onUpdate(c);
        else if (c.onRender && c.onRender !== noop) c.onRender(c);
      } catch(e) {}
    }
  }

  function _runTickCallbacks(t) {
    for (var i = 0; i < _tickCallbacks.length; i++) {
      try { _tickCallbacks[i](t); } catch(e) {}
    }
  }

  // Everything visual that must follow a (non-playing) seek: the timeline, tick
  // subscribers (React bridge), canvas draw(t), 3D __updateScene(t), registered
  // seek callbacks, anime / lottie instances. Media + CSS animations are synced
  // separately by the 'seek' message handler.
  function _renderSceneAt(t) {
    _renderTimeline(t, true);
    _runTickCallbacks(t);
    if (typeof window.draw === 'function') {
      try { window.draw(t); } catch(e) {}
    }
    // Three.js / 3d_world / void / studio: RAF is blocked while paused, so one shot per seek
    if (typeof window.__updateScene === 'function') {
      try { window.__updateScene(t); } catch(e) {}
    }
    var db = window.__dreambyte;
    if (db && db._seekCallbacks) {
      db._seekCallbacks.forEach(function(cb) { try { cb(t); } catch(e) {} });
    }
    // Manually registered anime.js instances (engine time unit is seconds)
    if (db && db._animeInstances) {
      db._animeInstances.forEach(function(inst) {
        try { if (inst && typeof inst.seek === 'function') inst.seek(Math.max(0, t)); } catch(e) {}
      });
    }
    // Raw lottie instances (direct lottie.loadAnimation)
    if (db && db._lottieInstances) {
      db._lottieInstances.forEach(function(inst) {
        try {
          if (!inst || typeof inst.getDuration !== 'function') return;
          var totalFrames = inst.getDuration(true);
          var durSec = inst.getDuration(false);
          if (durSec > 0 && totalFrames > 0) {
            // lottie-web uses 0-indexed frames; last valid frame is totalFrames - 1.
            // Offset by firstFrame so segmented animations (non-zero start) seek correctly.
            var firstFrame = typeof inst.firstFrame === 'number' ? inst.firstFrame : 0;
            var rel = Math.max(0, Math.min(totalFrames - 1, (t / durSec) * totalFrames));
            inst.goToAndStop(firstFrame + rel, true);
          }
        } catch(e) {}
      });
    }
  }

  var _clock = anime.createTimer({
    duration: _dreambyteDuration,
    autoplay: false,
    onUpdate: function(self) {
      var _t = self.currentTime;
      _renderTimeline(_t, false);
      _runTickCallbacks(_t);
      // Clock-drive the full-scene video (DOM-composite model): keep its
      // currentTime locked to the scene clock so it can't free-run or loop, and
      // so a stacked (V2) scene's video advances even when it's a slaved layer
      // that isn't getting its own play(). Native play() handles smoothness; we
      // only re-seek when it has actually drifted (e.g. it looped to 0, or a
      // slaved layer is stuck at frame 0 / black).
      try {
        var _svs = document.querySelectorAll('video[data-scene-video]');
        for (var _i = 0; _i < _svs.length; _i++) {
          var _v = _svs[_i];
          if (Math.abs((_v.currentTime || 0) - _t) > 0.25) {
            try { _v.currentTime = Math.max(0, _t); } catch(e) {}
          }
        }
      } catch(e) {}
      postToParent({
        type: 'timeupdate',
        currentTime: _t,
      });
    },
    onComplete: function() {
      postToParent({ type: 'ended' });
    },
  });

  function _clockTime() { return _clock.currentTime; }
  function _clockActive() { return !_clock.paused && !_clock.completed; }
  function _clockSeek(t) {
    var st = Math.max(0, Math.min(Number(t) || 0, _dreambyteDuration));
    _clock.seek(st, true);
    _renderSceneAt(st);
    return st;
  }

  // Public API for scene code
  window.__tl = masterTL;

  // ── Unified scrub registry ──────────────────────────────
  // React hooks, raw anime.js, raw lottie, and custom animations
  // register themselves here so a single seek message reaches
  // every scene type — not just the master timeline.
  if (!window.__dreambyte) window.__dreambyte = {};
  // Current scene time (seconds) + per-frame subscription (play ticks AND
  // seeks / scrubs / export frames). onTick replaces hooking the timeline's
  // own onUpdate, which scene code must not overwrite.
  window.__dreambyte.time = _clockTime;
  window.__dreambyte.onTick = function(cb) {
    if (typeof cb !== 'function') return function(){};
    _tickCallbacks.push(cb);
    return function off() {
      var idx = _tickCallbacks.indexOf(cb);
      if (idx >= 0) _tickCallbacks.splice(idx, 1);
    };
  };
  window.__dreambyte._seekCallbacks = [];
  window.__dreambyte._animeInstances = [];
  window.__dreambyte._lottieInstances = [];
  window.__dreambyte._scrubMutedState = null;
  window.__dreambyte.onSeek = function(cb) {
    if (typeof cb !== 'function') return function(){};
    window.__dreambyte._seekCallbacks.push(cb);
    return function off() {
      var idx = window.__dreambyte._seekCallbacks.indexOf(cb);
      if (idx >= 0) window.__dreambyte._seekCallbacks.splice(idx, 1);
    };
  };
  window.__dreambyte.registerAnime = function(inst) {
    if (inst && window.__dreambyte._animeInstances.indexOf(inst) < 0) {
      window.__dreambyte._animeInstances.push(inst);
    }
    return inst;
  };
  window.__dreambyte.registerLottie = function(inst) {
    if (inst && window.__dreambyte._lottieInstances.indexOf(inst) < 0) {
      window.__dreambyte._lottieInstances.push(inst);
    }
    return inst;
  };

  // ── Host clock (same-origin export / verifier / compositor) ──
  // Synchronous, frame-exact scene rendering without the postMessage round trip.
  window.__clock = {
    seek: _clockSeek,
    time: _clockTime,
    duration: function() { return _dreambyteDuration; },
    isActive: _clockActive,
    childCount: _childCount,
    play: function() { _clock.play(); },
    pause: function() { _clock.pause(); },
  };

  // Auto-register lottie.loadAnimation instances by wrapping the method.
  function _wrapLottie(lib) {
    if (!lib || typeof lib.loadAnimation !== 'function' || lib.__dreambyteWrapped) return lib;
    var orig = lib.loadAnimation.bind(lib);
    lib.loadAnimation = function() {
      var inst = orig.apply(null, arguments);
      window.__dreambyte.registerLottie(inst);
      return inst;
    };
    lib.__dreambyteWrapped = true;
    return lib;
  }
  if (window.lottie) {
    _wrapLottie(window.lottie);
  } else {
    try {
      var _lottieStore;
      Object.defineProperty(window, 'lottie', {
        configurable: true,
        enumerable: true,
        get: function() { return _lottieStore; },
        set: function(v) {
          _lottieStore = _wrapLottie(v);
        },
      });
    } catch(e) {}
  }

  // ── Multi-track audio integration ───────────────────────
  var ttsAudio = null;
  var sfxElements = [];
  var musicAudio = null;
  var legacyAudio = [];

  // ── Per-category timeline mix (v4 #3) ───────────────────
  // Faders / pan / solo / master from the timeline applied to scene audio so the
  // PREVIEW matches the EXPORTED mix (resolveSceneAudioMix is the shared source of
  // truth). Gain + drop go through el.volume (composes with the music duck dance,
  // and avoids the AudioContext autoplay trap that would silence routed audio). PAN
  // needs Web Audio, so a lazy StereoPanner graph is built ONLY for elements that
  // actually pan — gain/mute keep working even if that context can't resume.
  var _sceneMix = null; // { tts, file, music, sfx: {id:cat} }, cat = {trackGain, pan, drop}
  var _sceneMixCtx = null; // lazily created, only when something pans

  function _catMixForEl(el) {
    if (!_sceneMix || !el || !el.id) return null;
    if (el.id === 'scene-tts') return _sceneMix.tts || null;
    if (el.id === 'scene-audio') return _sceneMix.file || null;
    if (el.id === 'scene-music') return _sceneMix.music || null;
    if (el.id.indexOf('sfx-') === 0 && _sceneMix.sfx) return _sceneMix.sfx[el.id.slice(4)] || null;
    return null;
  }
  // Category gain to multiply INTO the element's base volume. A dropped category
  // (track muted / solo-excluded) returns 0 — silent, without touching el.muted (so
  // it never fights the set_audio_muted / engine-ownership baseline dances).
  function _mixGain(el) {
    var c = _catMixForEl(el);
    if (!c) return 1;
    if (c.drop) return 0;
    var g = Number(c.trackGain);
    return isFinite(g) && g >= 0 ? g : 1;
  }
  function _clampVol(v) {
    return Math.min(1, Math.max(0, isFinite(v) ? v : 0));
  }
  // Build (once) and update a StereoPanner for a panned element. createMediaElement-
  // Source is one-shot per element, so the source + panner are cached on the element.
  function _ensurePanner(el, pan) {
    try {
      if (!_sceneMixCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        _sceneMixCtx = new AC();
      }
      if (_sceneMixCtx.state === 'suspended') {
        try { _sceneMixCtx.resume(); } catch (e) {}
      }
      if (!el.__mixSource) {
        el.__mixSource = _sceneMixCtx.createMediaElementSource(el);
        el.__mixPanner = _sceneMixCtx.createStereoPanner();
        el.__mixSource.connect(el.__mixPanner);
        el.__mixPanner.connect(_sceneMixCtx.destination);
      }
      el.__mixPanner.pan.value = Math.min(1, Math.max(-1, Number(pan) || 0));
    } catch (e) {}
  }
  // Re-apply the current mix to live elements (after a mix message, or after init/
  // syncMedia reset volumes). Gain via el.volume, pan via the lazy graph.
  function applySceneMix() {
    var els = [];
    if (ttsAudio) els.push(ttsAudio);
    if (musicAudio) els.push(musicAudio);
    sfxElements.forEach(function (el) { els.push(el); });
    var fileEl = document.getElementById('scene-audio');
    if (fileEl && els.indexOf(fileEl) === -1) els.push(fileEl);
    els.forEach(function (el) {
      if (!el) return;
      var base = parseFloat(el.dataset.volume);
      if (!isFinite(base)) base = el.id === 'scene-music' ? 0.12 : el.id.indexOf('sfx-') === 0 ? 0.8 : 1;
      el.volume = _clampVol(base * _mixGain(el));
      var c = _catMixForEl(el);
      var pan = c ? Number(c.pan) || 0 : 0;
      if (pan !== 0) _ensurePanner(el, pan);
      else if (el.__mixPanner) { try { el.__mixPanner.pan.value = 0; } catch (e) {} }
    });
  }

  // ── Engine audio ownership (sticky) ─────────────────────
  // When the timeline audio engine takes ownership of this scene's sound
  // (tts/music/sfx/legacy <audio>), those elements must stay silent so audio
  // never plays twice. The flag is STICKY: it survives play/pause/seek/reset
  // because syncMedia re-applies it on every call, and the parent only needs to
  // send it once per iframe load. EXCEPTION: anything tagged data-avatar-audio
  // is left alone — avatar speech is played by its owner, not the engine, and
  // must never be muted by ownership.
  var _engineOwnsAudio = false;
  window.__engineOwnsAudio = false;

  function _isAvatarOwned(el) {
    return el && el.dataset && el.dataset.avatarAudio !== undefined;
  }

  // Mute (or restore) every <audio>/<video> the engine owns. Mirrors the
  // set_audio_muted baseline dance with its own dataset key so it composes with
  // track mute instead of fighting it.
  function applyEngineAudioOwnership() {
    var media = document.querySelectorAll('audio, video');
    media.forEach(function(el) {
      try {
        if (_isAvatarOwned(el)) return; // never touch avatar speech
        if (_engineOwnsAudio) {
          if (el.dataset.engineMuted === undefined) el.dataset.engineMuted = el.muted ? '1' : '0';
          el.muted = true;
        } else if (el.dataset.engineMuted !== undefined) {
          el.muted = el.dataset.engineMuted === '1';
          delete el.dataset.engineMuted;
        }
      } catch(e) {}
    });
  }

  window.addEventListener('load', function() {
    ttsAudio = document.getElementById('scene-tts') || document.getElementById('scene-audio');
    sfxElements = Array.from(document.querySelectorAll('[data-track="sfx"]'));
    musicAudio = document.getElementById('scene-music');
    legacyAudio = Array.from(document.querySelectorAll('audio')).filter(function(a) {
      return !a.dataset.track && a.id !== 'scene-tts' && a.id !== 'scene-audio' && a.id !== 'scene-music';
    });

    // Set initial volumes (Layers panel / audioLayer.volume on TTS + legacy track).
    // Each baseline is multiplied by the timeline category gain (_mixGain) so a fader
    // set in the parent is audible here; a dropped category goes to 0.
    if (ttsAudio) {
      var ttsVol = parseFloat(ttsAudio.dataset.volume || '1');
      ttsAudio.volume = _clampVol((Number.isFinite(ttsVol) ? ttsVol : 1) * _mixGain(ttsAudio));
      var ttsOff = parseFloat(ttsAudio.dataset.startOffset || '0');
      if (Number.isFinite(ttsOff) && ttsOff > 0) {
        try { ttsAudio.currentTime = ttsOff; } catch(e) {}
      }
    }
    if (musicAudio) {
      musicAudio.volume = _clampVol(parseFloat(musicAudio.dataset.volume || '0.12') * _mixGain(musicAudio));
    }
    sfxElements.forEach(function(el) {
      el.volume = _clampVol(parseFloat(el.dataset.volume || '0.8') * _mixGain(el));
    });

    // Schedule SFX triggers on the master timeline. Callbacks also fire when a
    // seek crosses them, so only sound while the clock is actually playing.
    sfxElements.forEach(function(el) {
      var triggerAt = parseFloat(el.dataset.triggerAt || '0');
      masterTL.call(function() {
        if (!_clockActive()) return;
        el.currentTime = 0;
        el.play().catch(function(){});
      }, Math.max(0, triggerAt || 0));
    });

    // Music ducking: reduce music volume during TTS playback. The duck/normal levels
    // are also scaled by the timeline music gain (_mixGain) so ducking composes with
    // the fader instead of overwriting it.
    if (musicAudio && ttsAudio && musicAudio.dataset.duck === 'true') {
      var normalVol = parseFloat(musicAudio.dataset.volume || '0.12');
      var duckLevel = parseFloat(musicAudio.dataset.duckLevel || '0.2');
      var duckVol = normalVol * duckLevel;
      ttsAudio.addEventListener('play', function() { musicAudio.volume = _clampVol(duckVol * _mixGain(musicAudio)); });
      ttsAudio.addEventListener('pause', function() { musicAudio.volume = _clampVol(normalVol * _mixGain(musicAudio)); });
      ttsAudio.addEventListener('ended', function() { musicAudio.volume = _clampVol(normalVol * _mixGain(musicAudio)); });
    }

    // Apply any mix that arrived before the elements existed (the parent may push
    // set_scene_audio_mix on load, before this handler ran).
    applySceneMix();

    // Web Speech API fallback
    var ttsConfig = document.getElementById('scene-tts-config');
    if (ttsConfig && !ttsAudio) {
      window.__webSpeechConfig = {
        provider: ttsConfig.dataset.provider,
        text: ttsConfig.dataset.text,
        voice: ttsConfig.dataset.voice,
      };
    }

    // Initial sync: refs exist now; timeline starts paused — keep media paused too
    try { syncMedia(false); } catch(e) {}
  });

  function syncMedia(playing) {
    // When the engine owns this scene's audio, the sound-producing elements
    // stay silent (the engine plays the mirror clips). Visuals — video frames,
    // CSS animations — still run, so only the audio branches consult this.
    var audioPlaying = playing && !_engineOwnsAudio;
    // TTS
    if (ttsAudio) {
      try {
        if (audioPlaying) {
          ttsAudio.play().catch(function(err) {
            console.warn('[dreambyte-playback] TTS play() failed (sandbox/autoplay?):', err);
            try {
              window.parent.postMessage({
                type: 'dreambyte:audio-error',
                error: (err && err.message) || 'Audio playback failed',
                track: 'tts'
              }, '*');
            } catch(pe) {}
          });
        } else {
          ttsAudio.pause();
        }
      } catch(e) {}
    }

    // Web Speech API fallback
    if (!ttsAudio && window.__webSpeechConfig && window.speechSynthesis) {
      if (audioPlaying) {
        if (!window.__webSpeechActive) {
          var u = new SpeechSynthesisUtterance(window.__webSpeechConfig.text);
          if (window.__webSpeechConfig.voice) {
            var voices = speechSynthesis.getVoices();
            var match = voices.find(function(v) { return v.name === window.__webSpeechConfig.voice; });
            if (match) u.voice = match;
          }
          speechSynthesis.speak(u);
          window.__webSpeechActive = true;
          u.onend = function() { window.__webSpeechActive = false; };
        }
      } else {
        speechSynthesis.cancel();
        window.__webSpeechActive = false;
      }
    }

    // Puter.js fallback
    if (!ttsAudio && window.__webSpeechConfig && window.__webSpeechConfig.provider === 'puter' && window.puter) {
      if (audioPlaying && !window.__puterAudioPlaying) {
        window.puter.ai.txt2speech(window.__webSpeechConfig.text, {
          provider: 'openai',
          voice: window.__webSpeechConfig.voice || 'nova',
        }).then(function(audioEl) {
          audioEl.play();
          window.__puterAudioPlaying = true;
          audioEl.onended = function() { window.__puterAudioPlaying = false; };
        }).catch(function(){});
      }
    }

    // Music
    if (musicAudio) {
      try {
        if (audioPlaying) musicAudio.play().catch(function(){});
        else musicAudio.pause();
      } catch(e) {}
    }

    // SFX are triggered by master-timeline callbacks, not play/pause
    // But stop them on pause (or whenever the engine owns the audio).
    if (!audioPlaying) {
      sfxElements.forEach(function(el) {
        try { el.pause(); } catch(e) {}
      });
    }

    // Legacy audio elements
    legacyAudio.forEach(function(a) {
      try {
        if (audioPlaying) a.play().catch(function(){});
        else a.pause();
      } catch(e) {}
    });

    // Videos (avatar, veo3 layers)
    var videos = document.querySelectorAll('video');
    videos.forEach(function(v) {
      try {
        if (playing) v.play().catch(function(){});
        else v.pause();
      } catch(e) {}
    });

    // CSS animations (legacy SVG scenes)
    var cssCtrl = document.getElementById('__dreambyte_css_ctrl');
    if (!cssCtrl) {
      cssCtrl = document.createElement('style');
      cssCtrl.id = '__dreambyte_css_ctrl';
      document.head.appendChild(cssCtrl);
    }
    cssCtrl.textContent = playing
      ? '*, *::before, *::after { animation-play-state: running !important; }'
      : '*, *::before, *::after { animation-play-state: paused !important; }';
    // After play(), WAAPI owns playback — CSS paused alone does not freeze animations.
    if (!playing) {
      _pauseCSSAnimations();
    }

    // Sticky: re-mute engine-owned media every sync (covers elements that loaded
    // after the ownership message, and re-asserts after seek/reset/play).
    applyEngineAudioOwnership();
  }

  // ── CSS animation control via Web Animations API ─────────
  // SVG scenes use CSS @keyframes, which the master timeline can't seek.
  // The Web Animations API gives us seekable Animation objects.
  // After seeking (which calls anim.pause()), we MUST call anim.play()
  // to resume — CSS animation-play-state alone can't override API pause.
  function _pauseCSSAnimations() {
    if (!document.getAnimations) return;
    function pauseEach(list) {
      list.forEach(function(anim) {
        try {
          anim.pause();
        } catch(e) {}
      });
    }
    var anims = document.getAnimations();
    pauseEach(anims);
    if (anims.length === 0) {
      _realRAF(function() {
        pauseEach(document.getAnimations ? document.getAnimations() : []);
      });
    }
  }

  function _seekCSSAnimations(timeMs) {
    if (!document.getAnimations) return;
    var anims = document.getAnimations();
    if (anims.length > 0) {
      anims.forEach(function(anim) {
        try {
          anim.currentTime = timeMs;
          anim.pause();
        } catch(e) {}
      });
    } else {
      // Animations may not exist yet (iframe just became visible).
      // Retry after the browser renders a frame.
      _realRAF(function() {
        var retryAnims = document.getAnimations ? document.getAnimations() : [];
        retryAnims.forEach(function(anim) {
          try {
            anim.currentTime = timeMs;
            anim.pause();
          } catch(e) {}
        });
      });
    }
  }

  function _resumeCSSAnimations() {
    if (!document.getAnimations) return;
    var anims = document.getAnimations();
    if (anims.length > 0) {
      anims.forEach(function(anim) {
        try { anim.play(); } catch(e) {}
      });
    } else {
      _realRAF(function() {
        var retryAnims = document.getAnimations ? document.getAnimations() : [];
        retryAnims.forEach(function(anim) {
          try { anim.play(); } catch(e) {}
        });
      });
    }
  }

  // ── postMessage bridge ───────────────────────────────────
  function postToParent(msg) {
    try {
      window.parent.postMessage(
        Object.assign({
          source: 'dreambyte-scene',
          sceneId: typeof SCENE_ID !== 'undefined' ? SCENE_ID : null,
        }, msg),
        '*'
      );
    } catch(e) {}
  }

  function refreshMediaRefs() {
    if (!ttsAudio) {
      ttsAudio = document.getElementById('scene-tts') || document.getElementById('scene-audio');
      if (ttsAudio) {
        var rv = parseFloat(ttsAudio.dataset.volume || '1');
        ttsAudio.volume = _clampVol((Number.isFinite(rv) ? rv : 1) * _mixGain(ttsAudio));
        var ro = parseFloat(ttsAudio.dataset.startOffset || '0');
        if (Number.isFinite(ro) && ro > 0) { try { ttsAudio.currentTime = ro; } catch(e) {} }
      }
    }
    if (!musicAudio) {
      musicAudio = document.getElementById('scene-music');
      if (musicAudio) {
        musicAudio.volume = _clampVol(parseFloat(musicAudio.dataset.volume || '0.12') * _mixGain(musicAudio));
      }
    }
  }

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.target !== 'dreambyte-scene') return;
    // Only accept playback commands from the parent window (the editor / published host).
    // Standalone scenes have parent === self, so same-frame messages still pass.
    // Nested iframes (embedded videos, widgets) are rejected — they can't spoof play/pause/scrub.
    if (event.source && event.source !== window.parent) return;
    // Ignore messages for other scenes
    if (
      event.data.sceneId &&
      typeof SCENE_ID !== 'undefined' &&
      event.data.sceneId !== SCENE_ID
    ) return;

    refreshMediaRefs();

    var cmd = event.data;

    switch (cmd.type) {

      case 'play':
        if (_clock.completed || _clockTime() >= _dreambyteDuration) {
          _clockSeek(0);
          _seekCSSAnimations(0);
          if (ttsAudio) {
            var rOff = parseFloat(ttsAudio.dataset.startOffset || '0');
            try { ttsAudio.currentTime = Number.isFinite(rOff) ? rOff : 0; } catch(e) {}
          }
        }
        _unblockRAF();   // let legacy RAF loops run
        _clock.play();
        syncMedia(true);
        _resumeCSSAnimations();  // Must call anim.play() via API — CSS rule alone can't override API pause
        postToParent({ type: 'playing' });
        break;

      case 'pause':
        _blockRAF();     // stop legacy RAF loops
        _clock.pause();
        syncMedia(false);  // CSS animation-play-state: paused handles SVG scenes
        postToParent({
          type: 'paused',
          currentTime: _clockTime(),
        });
        break;

      case 'seek':
        // Timeline, tick subscribers, draw(t), __updateScene(t), seek callbacks,
        // anime / lottie instances — all rendered synchronously at the exact time.
        var seekTime = _clockSeek(cmd.time);
        // Sync all audio to seek position (optional startOffset skips into the file)
        if (ttsAudio) {
          var sOff = parseFloat(ttsAudio.dataset.startOffset || '0');
          var ttsT = seekTime + (Number.isFinite(sOff) ? sOff : 0);
          try { ttsAudio.currentTime = Math.max(0, ttsT); } catch(e) {}
        }
        if (musicAudio) { try { musicAudio.currentTime = seekTime; } catch(e) {} }
        sfxElements.forEach(function(el) {
          try { el.pause(); el.currentTime = 0; } catch(e) {}
        });
        legacyAudio.forEach(function(a) {
          try { a.currentTime = seekTime; } catch(e) {}
        });
        document.querySelectorAll('video').forEach(function(v) {
          try { v.currentTime = seekTime; } catch(e) {}
        });
        // Seek CSS animations (SVG scenes with @keyframes)
        _seekCSSAnimations(seekTime * 1000);
        // Load choreography (C3b): a seek echo that lands while the timeline is
        // ACTIVELY playing must not pause media. The old code paused the master TL
        // (only when inactive) but ALWAYS ran syncMedia(false), so a deferred
        // post-play seek on a freshly-loaded scene froze its audio AND video right
        // after resume. Gate the media-pause half on isActive() — a paused-seek
        // (the common scrub/step case) still pauses identically; an active seek
        // leaves media playing.
        if (!_clockActive()) {
          _clock.pause();
          syncMedia(false);
        }
        postToParent({
          type: 'seeked',
          currentTime: _clockTime(),
        });
        break;

      case 'scrub_start':
        // Silence every audio/video element for the duration of the drag.
        // Capture prior .muted per element so we can restore exact state on scrub_end.
        if (!window.__dreambyte._scrubMutedState) {
          var seen = [];
          var record = [];
          var all = document.querySelectorAll('audio, video');
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (seen.indexOf(el) >= 0) continue;
            seen.push(el);
            record.push({ el: el, muted: !!el.muted });
            try { el.muted = true; } catch(e) {}
          }
          window.__dreambyte._scrubMutedState = record;
        }
        break;

      case 'scrub_end':
        if (window.__dreambyte._scrubMutedState) {
          window.__dreambyte._scrubMutedState.forEach(function(rec) {
            try { rec.el.muted = rec.muted; } catch(e) {}
          });
          window.__dreambyte._scrubMutedState = null;
        }
        break;

      case 'set_audio_muted':
        // Track mute: silence or restore all audio/video in this scene.
        // Respects existing per-element mute state (only overrides with true; restores dataset-muted baseline).
        var allMedia = document.querySelectorAll('audio, video');
        allMedia.forEach(function(el) {
          try {
            if (cmd.muted) {
              // Store original muted state once
              if (!el.dataset.trackMuted) el.dataset.trackMuted = el.muted ? '1' : '0';
              el.muted = true;
            } else {
              // Restore to original muted state
              var orig = el.dataset.trackMuted;
              if (orig !== undefined) {
                el.muted = orig === '1';
                delete el.dataset.trackMuted;
              } else {
                el.muted = false;
              }
            }
          } catch(e) {}
        });
        break;

      case 'set_scene_audio_mix':
        // Per-category timeline mix (v4 #3): faders / pan / solo / master from the
        // parent, applied so the preview matches the exported mix.
        _sceneMix = cmd.mix || null;
        applySceneMix();
        break;

      case 'set_engine_owns_audio':
        // Sticky ownership handoff: the timeline audio engine takes (or releases)
        // this scene's tts/music/sfx/legacy audio. Avatar speech (data-avatar-audio)
        // is never affected. Re-applied on every syncMedia, so
        // it survives seek/reset/play.
        _engineOwnsAudio = !!cmd.value;
        window.__engineOwnsAudio = _engineOwnsAudio;
        applyEngineAudioOwnership();
        // When ownership is taken mid-play, stop the now-owned elements so they
        // don't keep sounding until the next transport tick.
        if (_engineOwnsAudio) {
          try { if (ttsAudio) ttsAudio.pause(); } catch(e) {}
          try { if (musicAudio) musicAudio.pause(); } catch(e) {}
          sfxElements.forEach(function(el) { try { el.pause(); } catch(e) {} });
          legacyAudio.forEach(function(a) { try { a.pause(); } catch(e) {} });
        }
        break;

      case 'reset':
        _blockRAF();
        _clock.pause();
        _clockSeek(0);
        _seekCSSAnimations(0);
        if (ttsAudio) {
          var zOff = parseFloat(ttsAudio.dataset.startOffset || '0');
          try { ttsAudio.currentTime = Number.isFinite(zOff) ? zOff : 0; } catch(e) {}
        }
        if (musicAudio) { try { musicAudio.currentTime = 0; } catch(e) {} }
        legacyAudio.forEach(function(a) {
          var lo = parseFloat(a.dataset.startOffset || '0');
          try { a.currentTime = Number.isFinite(lo) ? lo : 0; } catch(e) {}
        });
        syncMedia(false);
        postToParent({ type: 'reset' });
        break;

      // ── Variable & interaction bridge (Phase 1b) ──────────
      case 'set_variable':
        if (cmd.name) {
          if (!window.__DREAMBYTE_VARIABLES) window.__DREAMBYTE_VARIABLES = {};
          window.__DREAMBYTE_VARIABLES[cmd.name] = cmd.value;
          // Dispatch custom event so React hooks (useVariable) can react
          try {
            window.dispatchEvent(new CustomEvent('dreambyte:variable-changed', {
              detail: { name: cmd.name, value: cmd.value, source: 'parent' }
            }));
          } catch(e) {}
        }
        break;

      case 'get_variables':
        postToParent({
          type: 'variables_state',
          variables: window.__DREAMBYTE_VARIABLES || {},
        });
        break;

      case 'fire_trigger':
        // Parent fires a named trigger into the scene
        if (cmd.name) {
          try {
            window.dispatchEvent(new CustomEvent('dreambyte:trigger', {
              detail: { name: cmd.name, payload: cmd.payload }
            }));
          } catch(e) {}
        }
        break;

      case 'get_state':
        postToParent({
          type: 'state',
          currentTime: _clockTime(),
          duration: _dreambyteDuration,
          status: _clockActive()
            ? 'playing'
            : _clockTime() >= _dreambyteDuration
            ? 'ended'
            : 'paused',
        });
        break;

      // ── Live preview from typography panel (no source rewrite) ──────
      // Parent sends either { slotId, ... } (preferred, set after Layer 2
      // tagging) OR { selector, matchText, occurrence, ... } (fallback when
      // tagging hasn't run yet). We mutate textContent + inline style; the
      // editor's debounced save persists the change to source in parallel.
      case 'live_apply':
        try {
          // Resolve target — element slot OR text-node sub-slot — by slotId
          // first, then fall back to selector+matchText. For text-node
          // slots, the style mutation applies to the parent element (text
          // nodes have no style), but textContent edits hit only the
          // specific Text node so child elements are preserved.
          var __target = null;
          var __textNode = null;
          if (cmd.slotId) {
            var __resolved = _resolveSlotTarget(cmd.slotId);
            if (__resolved) {
              __target = __resolved.el;
              if (__resolved.kind === 'text-node') __textNode = __resolved.textNode;
            }
          }
          if (!__target && cmd.selector) {
            var __nodes = document.querySelectorAll(cmd.selector);
            var __idx = 0;
            for (var __i = 0; __i < __nodes.length; __i++) {
              var __n = __nodes[__i];
              var __t = (__n.textContent || '').replace(/\\s+/g, ' ').trim();
              if (__t !== cmd.matchText) continue;
              if (__idx === (cmd.occurrence || 0)) { __target = __n; break; }
              __idx++;
            }
          }
          if (!__target) break;
          if (typeof cmd.newText === 'string') {
            if (__textNode) {
              // Per-text-node edit — preserves sibling element children.
              __textNode.nodeValue = cmd.newText;
            } else if (__target.children.length === 0) {
              __target.textContent = cmd.newText;
            }
            // else: mixed-content element edited via element slot —
            // refuse to overwrite (would clobber children). UI should
            // surface text-node sub-slots instead.
          }
          if (cmd.style && typeof cmd.style === 'object') {
            // SVG <text> uses attributes, not inline style, for font props.
            // The attribute mapping table is generated from TYPOGRAPHY_PROPS
            // in src/lib/code-text-slots.ts so adding a typography prop in one
            // place propagates here — no hand-edits to keep in sync.
            var __svgTextAttrMap = ${SVG_TEXT_ATTR_MAP_JSON};
            var __isSvg = __target.namespaceURI === 'http://www.w3.org/2000/svg' && __target.tagName.toLowerCase() === 'text';
            for (var __k in cmd.style) {
              if (!Object.prototype.hasOwnProperty.call(cmd.style, __k)) continue;
              var __v = cmd.style[__k];
              if (__isSvg) {
                var __attr = __svgTextAttrMap[__k] || null;
                if (__attr) __target.setAttribute(__attr, __v);
                else __target.style[__k] = __v;
              } else {
                __target.style[__k] = __v;
              }
            }
          }
        } catch (e) { console.warn('[Playback] live_apply error:', e); }
        break;

      // ── Enumerate text slots for the typography panel ──────────────
      // Parent asks for the current list of text-bearing elements with
      // tagName + textContent + computedStyle + bounding rect. The slot
      // tagger (runs at load + on MutationObserver) ensures each element
      // has a stable data-dreambyte-slot ID. We use computedStyle so the
      // panel sees the rendered values (Tailwind classes, CSS files,
      // inheritance) — not just what is in inline style props.
      case 'enumerate_text_slots':
        try {
          var __tagged = document.querySelectorAll('[data-dreambyte-slot]');
          var __slots = [];
          for (var __ti = 0; __ti < __tagged.length; __ti++) {
            var __el = __tagged[__ti];
            var __cs = window.getComputedStyle(__el);
            if (__cs.display === 'none' || __cs.visibility === 'hidden') continue;
            var __rect = __el.getBoundingClientRect();
            if (__rect.width === 0 && __rect.height === 0) continue;
            var __isSvgEl = __el.namespaceURI === 'http://www.w3.org/2000/svg';
            var __colorVal = __cs.color;
            if (__isSvgEl) {
              var __fillAttr = __el.getAttribute && __el.getAttribute('fill');
              __colorVal = __fillAttr || __cs.fill || __cs.color;
            }
            var __baseStyle = {
              fontFamily: __cs.fontFamily,
              fontSize: __cs.fontSize,
              fontWeight: __cs.fontWeight,
              fontStyle: __cs.fontStyle,
              color: __colorVal,
              lineHeight: __cs.lineHeight,
              letterSpacing: __cs.letterSpacing,
              textAlign: __cs.textAlign,
            };
            var __parentId = __el.getAttribute('data-dreambyte-slot');
            var __tagName = __el.tagName.toLowerCase();
            // Count text-node + element children to decide pure vs mixed.
            var __textNodes = [];
            var __hasElementChild = false;
            for (var __c = 0; __c < __el.childNodes.length; __c++) {
              var __ch = __el.childNodes[__c];
              if (__ch.nodeType === 3 && (__ch.textContent || '').trim()) __textNodes.push(__ch);
              else if (__ch.nodeType === 1) __hasElementChild = true;
            }
            if (!__hasElementChild) {
              // Pure-text element — single slot.
              __slots.push({
                id: __parentId,
                tagName: __tagName,
                textContent: (__el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
                style: __baseStyle,
                rect: { x: __rect.x, y: __rect.y, w: __rect.width, h: __rect.height },
                mode: 'element',
              });
            } else {
              // Mixed content — one slot per non-empty text node child.
              // Each sub-slot inherits the parent's computed style + tag.
              for (var __tn = 0; __tn < __textNodes.length; __tn++) {
                var __t = __textNodes[__tn];
                var __tt = (__t.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!__tt) continue;
                __slots.push({
                  id: __parentId + ':t' + __tn,
                  parentId: __parentId,
                  tagName: __tagName,
                  textContent: __tt.slice(0, 240),
                  style: __baseStyle,
                  rect: { x: __rect.x, y: __rect.y, w: __rect.width, h: __rect.height },
                  mode: 'text-node',
                  textNodeIndex: __tn,
                });
              }
            }
          }
          postToParent({
            type: 'text_slots',
            requestId: cmd.requestId || null,
            slots: __slots,
          });
        } catch (e) { console.warn('[Playback] enumerate_text_slots error:', e); }
        break;

      // ── Click-to-select (Layer 3) ────────────────────────────────────
      // Parent toggles select mode on while a typography panel is open.
      // When on, the iframe shows hover outlines on tagged text elements
      // and intercepts the next click on one to post slot_clicked back.
      case 'enable_select_mode':
        _enableSelectMode();
        break;

      case 'disable_select_mode':
        _disableSelectMode();
        break;

      case 'select_slot':
        // Parent tells us which slot is currently being edited — draw the
        // selection ring on the matching element.
        _setSelectionRing(cmd.slotId || null);
        break;

      case 'clear_selection':
        _setSelectionRing(null);
        break;

      case 'set-bg':
        if (cmd.color) {
          document.body.style.backgroundColor = cmd.color;
          // Walk down from #react-root to find the first element with an explicit
          // background (the AbsoluteFill wrapper that covers the scene)
          var rRoot = document.getElementById('react-root');
          if (rRoot) {
            var walker = rRoot;
            for (var d = 0; d < 6; d++) {
              var child = walker.firstElementChild;
              if (!child) break;
              var cs = window.getComputedStyle(child);
              var bg = cs.backgroundColor || cs.background;
              // If this element has a non-transparent background, override it
              if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
                child.style.background = cmd.color;
                break;
              }
              walker = child;
            }
          }
          // Also update #scene-camera background for non-React scenes
          var cam = document.getElementById('scene-camera');
          if (cam) cam.style.backgroundColor = cmd.color;
        }
        break;
    }
  });

  // ── Signal ready after all scripts execute ───────────────
  window.addEventListener('load', function() {
    _realSetTimeout(function() {
      // Paint the paused t=0 frame (tweens that start later show their "from"
      // state) unless the parent already started playback or seeked.
      if (!_clockActive() && _clockTime() === 0) {
        _renderTimeline(0, true);
        _runTickCallbacks(0);
      }
      postToParent({
        type: 'ready',
        duration: _dreambyteDuration,
        sceneId: typeof SCENE_ID !== 'undefined' ? SCENE_ID : null,
      });
    }, 50);
  });

  // ── Text-slot tagger (Layer 2: stable IDs for typography editing) ──
  // Walks text-bearing DOM elements and assigns a sequential
  // data-dreambyte-slot attribute. Survives React re-renders via a
  // MutationObserver. The typography panel uses these IDs to:
  //   1. Target live_apply messages directly (no textContent matching)
  //   2. Read computedStyle (so Tailwind and CSS-file styles surface in
  //      the panel, not just inline style values)
  var TEXT_TAG_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,button,li,div,span,text';

  // Stable slot ID = djb2 hash of the element's DOM path from body.
  // Survives iframe reloads as long as the React tree shape is unchanged
  // (text content changes don't shift IDs). Replaces the previous
  // sequential counter which broke on structural re-renders.
  function _slotIdFor(el) {
    var parts = [];
    var n = el;
    while (n && n !== document.body && n.parentNode) {
      var siblings = n.parentNode.children;
      var nth = 0;
      var sameCount = 0;
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i].tagName === n.tagName) {
          sameCount++;
          if (siblings[i] === n) nth = sameCount;
        }
      }
      parts.unshift(n.tagName.toLowerCase() + ':' + nth);
      n = n.parentNode;
    }
    var path = parts.join('/');
    var h = 5381;
    for (var k = 0; k < path.length; k++) h = ((h << 5) + h + path.charCodeAt(k)) | 0;
    // Unsigned 32-bit, base36 — short and selector-safe.
    return 'ct' + (h >>> 0).toString(36);
  }

  // Selector-attribute escape: slotId hashes can contain CSS-special chars
  // (\\, ", ], etc). CSS.escape handles all of them; fall back to escaping
  // the two characters that actually break the attr selector grammar.
  function _escSlotId(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[\\\\"]/g, '\\\\$&');
  }
  function _findBySlot(id) {
    if (id == null || id === '') return null;
    try { return document.querySelector('[data-dreambyte-slot="' + _escSlotId(id) + '"]'); }
    catch (e) { return null; }
  }
  function _tagTextSlots() {
    try {
      var nodes = document.querySelectorAll(TEXT_TAG_SELECTOR);
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.hasAttribute('data-dreambyte-slot')) continue;
        // Tag elements that have at least one non-whitespace text node
        // anywhere in their direct children. This includes mixed content
        // (text interleaved with child elements) — handled by enumerate
        // as per-text-node sub-slots so each run is independently editable.
        var hasAnyText = false;
        for (var c = 0; c < n.childNodes.length; c++) {
          var ch = n.childNodes[c];
          if (ch.nodeType === 3 && (ch.textContent || '').trim()) {
            hasAnyText = true;
            break;
          }
        }
        if (!hasAnyText) continue;
        n.setAttribute('data-dreambyte-slot', _slotIdFor(n));
      }
    } catch (e) { /* DOM not ready or removed; ignore */ }
  }

  // Resolve a slot ID — element-level (ct{hash}) or text-node sub-slot
  // (ct{hash}:t{N}, the Nth non-whitespace text-node child) — to its
  // target. Element targets return the element; text-node targets return
  // the underlying Text node. Used by live_apply for the actual mutation.
  function _resolveSlotTarget(id) {
    if (!id) return null;
    var sepIdx = String(id).indexOf(':t');
    if (sepIdx < 0) {
      var el = _findBySlot(id);
      return el ? { kind: 'element', el: el } : null;
    }
    var parentId = id.slice(0, sepIdx);
    var n = parseInt(id.slice(sepIdx + 2), 10);
    if (!isFinite(n)) return null;
    var parent = _findBySlot(parentId);
    if (!parent) return null;
    var k = 0;
    for (var c = 0; c < parent.childNodes.length; c++) {
      var ch = parent.childNodes[c];
      if (ch.nodeType !== 3) continue;
      if ((ch.textContent || '').trim() === '') continue;
      if (k === n) return { kind: 'text-node', el: parent, textNode: ch };
      k++;
    }
    return null;
  }

  // Initial tag pass — defer one tick so React has a chance to mount.
  function _initSlotTagger() {
    _tagTextSlots();
    try {
      var mo = new MutationObserver(function() {
        // Re-tag any newly inserted text-bearing elements. Existing tags
        // are preserved (the check inside _tagTextSlots is by attribute).
        _tagTextSlots();
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: false });
      window.__dreambyteSlotObserver = mo;
    } catch (e) { /* MutationObserver unavailable — fall back to one-shot tagging */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      _realSetTimeout(_initSlotTagger, 30);
    });
  } else {
    _realSetTimeout(_initSlotTagger, 30);
  }
  window.__dreambyteTagTextSlots = _tagTextSlots;

  // ── Select-mode + selection ring (Layer 3) ────────────────────────
  // Style sheet injected only while select mode is enabled. Cleans up
  // when disabled so normal interactive scenes aren't affected.
  var _selectStyleEl = null;
  var _selectClickHandler = null;
  var _ringEl = null;
  var _ringResizeTimer = null;
  var _ringObserver = null;
  var _ringTargetId = null;

  function _ensureRing() {
    if (_ringEl) return _ringEl;
    var r = document.createElement('div');
    r.id = 'dreambyte-selection-ring';
    r.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'box-sizing:border-box',
      'border:2px solid #2563eb',
      'border-radius:2px',
      'box-shadow:0 0 0 1px rgba(255,255,255,0.6)',
      'z-index:2147483646',
      'transition:left 80ms ease,top 80ms ease,width 80ms ease,height 80ms ease',
      'display:none'
    ].join(';');
    document.body.appendChild(r);
    _ringEl = r;
    return r;
  }

  function _updateRingPosition() {
    if (!_ringEl || !_ringTargetId) return;
    var el = _findBySlot(_ringTargetId);
    if (!el) { _ringEl.style.display = 'none'; return; }
    var rect = el.getBoundingClientRect();
    // Position relative to the document, not the viewport.
    var sx = window.scrollX || 0;
    var sy = window.scrollY || 0;
    _ringEl.style.display = 'block';
    _ringEl.style.left = (rect.left + sx) + 'px';
    _ringEl.style.top = (rect.top + sy) + 'px';
    _ringEl.style.width = rect.width + 'px';
    _ringEl.style.height = rect.height + 'px';
  }

  var _ringRafId = null;
  function _ringTickLoop() {
    if (!_ringTargetId) { _ringRafId = null; return; }
    _updateRingPosition();
    // Use native RAF (bypassing the playback-controller's intercepted RAF)
    // so the ring updates even while the timeline is paused.
    _ringRafId = window.__nativeRAF ? window.__nativeRAF(_ringTickLoop) : window.requestAnimationFrame(_ringTickLoop);
  }

  function _setSelectionRing(slotId) {
    _ringTargetId = slotId;
    if (!slotId) {
      if (_ringEl) _ringEl.style.display = 'none';
      if (_ringObserver) { _ringObserver.disconnect(); _ringObserver = null; }
      if (_ringRafId != null) {
        if (window.__nativeCAF) window.__nativeCAF(_ringRafId);
        else cancelAnimationFrame(_ringRafId);
        _ringRafId = null;
      }
      return;
    }
    _ensureRing();
    _updateRingPosition();
    if (!_ringObserver && typeof ResizeObserver !== 'undefined') {
      // Element-size changes (text reflow) — keep the ring in sync.
      try {
        _ringObserver = new ResizeObserver(_updateRingPosition);
        var el = _findBySlot(slotId);
        if (el) _ringObserver.observe(el);
      } catch (e) { /* ignore */ }
    }
    // CSS transforms / timeline-driven motion don't trigger ResizeObserver, so
    // also run an rAF poll for the position. Cheap (one getBoundingClientRect
    // per frame) and only active while a ring exists.
    if (_ringRafId == null) _ringTickLoop();
  }

  // Refresh ring position on viewport changes too.
  window.addEventListener('resize', function() {
    if (_ringResizeTimer) clearTimeout(_ringResizeTimer);
    _ringResizeTimer = setTimeout(_updateRingPosition, 60);
  });

  function _enableSelectMode() {
    if (_selectStyleEl) return; // already on
    var s = document.createElement('style');
    s.id = 'dreambyte-select-mode-style';
    s.textContent =
      '[data-dreambyte-slot]{cursor:text;}\\n' +
      '[data-dreambyte-slot]:hover{outline:1.5px dashed #2563eb;outline-offset:1px;}\\n';
    document.head.appendChild(s);
    _selectStyleEl = s;

    _selectClickHandler = function(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      // While editing, let clicks inside the contentEditable element flow
      // normally — they place the caret. Clicks outside commit + select
      // the new slot.
      if (_editingEl && _editingEl.contains(t)) return;
      var el = t.closest('[data-dreambyte-slot]');
      if (!el) return;
      // Block the click from reaching scene handlers so we don't
      // accidentally trigger an interactive button while in edit mode.
      ev.preventDefault();
      ev.stopPropagation();
      var slotId = el.getAttribute('data-dreambyte-slot');
      _setSelectionRing(slotId);
      postToParent({
        type: 'slot_clicked',
        slotId: slotId,
        tagName: el.tagName.toLowerCase(),
        textContent: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      });
    };

    _selectDblClickHandler = function(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var el = t.closest('[data-dreambyte-slot]');
      if (!el) return;
      // Skip elements with non-text children — editing them would clobber
      // the children. _tagTextSlots only tags elements with own text, but
      // children may have been added since.
      var hasChildren = false;
      for (var c = 0; c < el.childNodes.length; c++) {
        if (el.childNodes[c].nodeType === 1) { hasChildren = true; break; }
      }
      if (hasChildren) return;
      ev.preventDefault();
      ev.stopPropagation();
      _enterEditMode(el);
    };

    // Capture phase so we beat scene handlers.
    document.addEventListener('click', _selectClickHandler, true);
    document.addEventListener('dblclick', _selectDblClickHandler, true);
  }

  // ── Inline contentEditable (Layer 4) ─────────────────────────────
  var _editingEl = null;
  var _editingOrigText = null;
  var _editingOnInput = null;
  var _editingOnBlur = null;
  var _editingOnKeyDown = null;

  function _enterEditMode(el) {
    if (_editingEl) _exitEditMode(true);
    _editingEl = el;
    _editingOrigText = el.textContent || '';
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('spellcheck', 'false');
    el.style.outline = '2px solid #2563eb';
    el.style.outlineOffset = '2px';
    el.style.cursor = 'text';
    // Hide selection ring while editing — it's redundant with the
    // contentEditable outline and obscures the cursor.
    if (_ringEl) _ringEl.style.display = 'none';

    el.focus();
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection API may fail; not critical */ }

    _editingOnInput = function() {
      if (!_editingEl) return;
      var text = (_editingEl.textContent || '').replace(/\\s+/g, ' ').trim();
      postToParent({
        type: 'slot_text_input',
        slotId: _editingEl.getAttribute('data-dreambyte-slot'),
        text: text,
      });
    };
    _editingOnBlur = function() { _exitEditMode(true); };
    _editingOnKeyDown = function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (_editingEl && _editingEl.blur) _editingEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _exitEditMode(false);
      }
    };
    el.addEventListener('input', _editingOnInput);
    el.addEventListener('blur', _editingOnBlur);
    el.addEventListener('keydown', _editingOnKeyDown);
  }

  function _exitEditMode(commit) {
    if (!_editingEl) return;
    var el = _editingEl;
    if (_editingOnInput) el.removeEventListener('input', _editingOnInput);
    if (_editingOnBlur) el.removeEventListener('blur', _editingOnBlur);
    if (_editingOnKeyDown) el.removeEventListener('keydown', _editingOnKeyDown);
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.cursor = '';
    var finalText = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!commit) {
      el.textContent = _editingOrigText;
      finalText = (_editingOrigText || '').replace(/\\s+/g, ' ').trim();
    }
    postToParent({
      type: 'slot_text_committed',
      slotId: el.getAttribute('data-dreambyte-slot'),
      text: finalText,
      committed: !!commit,
    });
    _editingEl = null;
    _editingOrigText = null;
    _editingOnInput = null;
    _editingOnBlur = null;
    _editingOnKeyDown = null;
    // Restore selection ring on the just-edited element.
    if (_ringTargetId) _setSelectionRing(_ringTargetId);
  }

  var _selectDblClickHandler = null;

  function _disableSelectMode() {
    if (_editingEl) _exitEditMode(true);
    if (_selectStyleEl) {
      _selectStyleEl.parentNode && _selectStyleEl.parentNode.removeChild(_selectStyleEl);
      _selectStyleEl = null;
    }
    if (_selectClickHandler) {
      document.removeEventListener('click', _selectClickHandler, true);
      _selectClickHandler = null;
    }
    if (_selectDblClickHandler) {
      document.removeEventListener('dblclick', _selectDblClickHandler, true);
      _selectDblClickHandler = null;
    }
  }

  // ── Expose postToParent for DreambyteReact hooks ─────────────
  // React hooks (useVariable, useInteraction, useTrigger) call this
  // to send events across the iframe boundary.
  window.__dreambytePostToParent = postToParent;

  // Initialize variable store
  if (!window.__DREAMBYTE_VARIABLES) window.__DREAMBYTE_VARIABLES = {};

  // ── Legacy compatibility ─────────────────────────────────
  // Old code may call __pause/__resume directly.
  // Store refs so _blockRAF/_unblockRAF can detect our own functions.
  var _legacyPause = function() { _blockRAF(); _clock.pause(); syncMedia(false); };
  var _legacyResume = function() { _unblockRAF(); _clock.play(); syncMedia(true); };
  window.__pause = _legacyPause;
  window.__resume = _legacyResume;

  // SVG (and other CSS @keyframes) scenes: each rule uses the animation shorthand,
  // which sets animation-play-state back to running and wins over the scene's
  // weak universal paused rule. Without this, animations run at load while the
  // master clock is still paused. Match initial state to the paused clock
  // until parent sends play.
  syncMedia(false);

})();
`
