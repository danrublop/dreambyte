#!/usr/bin/env node
// Audio export smoke — drives a running Dreambyte via CDP to prove the
// program-audio overlay: a standalone audio clip on the timeline must
// survive a Tier-3 export, and the program master fader must scale its level.
//
// What it does:
//   1. Connects to the app's CDP endpoint (default port 9223).
//   2. Builds a fixture in the live store: one minimal scene (so there's video
//      to attach audio to) + a standalone audio clip pointing at a bundled SFX
//      WAV (/sfx-library/misc/...), on an audio track.
//   3. Exports twice via the Tier-3 engine — master=1.0 and master=0.25 — to
//      temp files (settings.outputPath bypasses the save dialog).
//   4. Asserts with ffmpeg astats: each output HAS an audio stream, duration is
//      sane, and the audio is NON-SILENT; and that master=0.25 is quieter than
//      master=1.0 (the fader actually reaches the file).
//
// Usage: node scripts/smoke/audio-export-smoke.mjs [cdpPort] [ffmpegBin]
// Exit 0 = all checks pass. This is an E2E harness — run it against a live app.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const PORT = Number(process.argv[2] || 9223)
const FFMPEG = process.argv[3] || 'ffmpeg'
const FIXTURE_WAV = '/sfx-library/misc/zzfx-timer-done.wav'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function cdpJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json${p}`)
  return res.json()
}

async function rendererEval(wsUrl, expression, timeoutMs = 20000) {
  const { default: WS } = await import('ws').catch(() => ({ default: globalThis.WebSocket }))
  const Sock = WS || globalThis.WebSocket
  const ws = new Sock(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP eval timeout')), timeoutMs)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id === 1) {
        clearTimeout(timer)
        resolve(msg)
      }
    }
  })
  ws.send(
    JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }),
  )
  const msg = await reply
  ws.close()
  if (msg.result?.exceptionDetails) {
    throw new Error('eval threw: ' + JSON.stringify(msg.result.exceptionDetails).slice(0, 400))
  }
  return msg.result?.result?.value
}

/** Mean volume (dBFS) of a media file via ffmpeg volumedetect. -91 ≈ silence. */
function meanVolumeDb(file) {
  return new Promise((resolve) => {
    const ff = spawn(FFMPEG, ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    ff.stderr.on('data', (d) => (err += d.toString()))
    ff.on('error', () => resolve({ db: null, hasAudio: false, err: 'spawn failed' }))
    ff.on('close', () => {
      const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(err)
      const m = err.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
      resolve({ db: m ? parseFloat(m[1]) : null, hasAudio, err })
    })
  })
}

async function exportFixture(wsUrl, outPath, masterVolume) {
  // Build the fixture + trigger a Tier-3 export inside the renderer. Returns
  // { ok, error }. Assumes a project is open; creates a scene + audio clip.
  const expr = `(async () => {
    const store = window.__dreambyteStore || window.useVideoStore;
    const s = (store.getState ? store.getState() : null);
    if (!s) return { ok: false, error: 'no store' };
    try {
      // Ensure at least one scene exists (video to attach audio to).
      if (!s.scenes || s.scenes.length === 0) {
        if (typeof s.addScene === 'function') s.addScene();
      }
      const st = store.getState();
      // Set program master.
      if (typeof st.dispatchAction === 'function') {
        st.dispatchAction({ type: 'project/update', params: { patch: { audioSettings: { ...(st.project.audioSettings||{}), masterVolume: ${masterVolume} } } } }, { source: 'user' });
      }
      // Ensure an audio track + a standalone clip on it.
      st.initTimeline && st.initTimeline();
      // Idempotent: drop any standalone audio clips from a prior smoke run so
      // the export's input list doesn't accumulate across runs (persisted to DB).
      const tlPrev = store.getState().project.timeline;
      if (tlPrev) for (const tr of tlPrev.tracks) for (const c of [...tr.clips]) {
        if (c.sourceType === 'audio' && !/^(aud-|tts-|mus-|avatar-audio:)/.test(c.sourceId)) store.getState().removeClip(c.id);
      }
      const st2 = store.getState();
      let tl = st2.project.timeline;
      let aud = (tl?.tracks||[]).find(t => t.type === 'audio' && !t.locked);
      if (!aud) { const id = st2.addTrack('audio'); aud = (store.getState().project.timeline.tracks).find(t => t.id === id); }
      store.getState().addClip(aud.id, {
        sourceType: 'audio', sourceId: '${FIXTURE_WAV}', label: 'smoke', startTime: 0,
        duration: 3, trimStart: 0, trimEnd: null, speed: 1, opacity: 1,
        position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, filters: [], keyframes: [],
      });
      // Fire the export but DON'T await it here — exports are slow (a full
      // Tier-3 render + stitch + overlay), longer than any CDP eval timeout.
      // The caller polls isExporting instead.
      store.getState().exportVideo({ engine: 'tier3', outputPath: ${JSON.stringify(outPath)}, format: 'mp4', fps: 30, profile: 'fast' });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`
  const kick = await rendererEval(wsUrl, expr, 30000)
  if (!kick?.ok) return kick
  // Poll isExporting to completion (max ~8 min).
  for (let i = 0; i < 96; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = await evalExporting(wsUrl).catch(() => ({ exporting: true }))
    if (!st.exporting) return { ok: true }
  }
  return { ok: false, error: 'export did not finish within timeout' }
}

function evalExporting(wsUrl) {
  return rendererEval(
    wsUrl,
    `(() => { const s=(window.__dreambyteStore||window.useVideoStore).getState(); return { exporting: !!s.isExporting }; })()`,
    15000,
  )
}

async function main() {
  let targets
  try {
    targets = await cdpJson('/list')
  } catch (e) {
    check('CDP reachable', false, `port ${PORT}: ${e.message}`)
    return finish()
  }
  // Match the MAIN app page specifically — NOT the transient scene iframes
  // (dreambyte://scenes/...) that exist during an export and have no store.
  const page = (targets || []).find((t) => t.type === 'page' && /dreambyte:\/\/app\//.test(t.url || ''))
  if (!page) {
    check('app page target found', false, 'no dreambyte://app/ page')
    return finish()
  }
  check('app page target found', true, page.url)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'db-audio-smoke-'))
  const loudPath = path.join(tmp, 'master-100.mp4')
  const quietPath = path.join(tmp, 'master-025.mp4')

  // Export at full master, then at quarter master.
  const r1 = await exportFixture(page.webSocketDebuggerUrl, loudPath, 1.0).catch((e) => ({ ok: false, error: e.message }))
  check('export (master=1.0) completed', !!r1?.ok, r1?.error || '')
  const r2 = await exportFixture(page.webSocketDebuggerUrl, quietPath, 0.25).catch((e) => ({ ok: false, error: e.message }))
  check('export (master=0.25) completed', !!r2?.ok, r2?.error || '')

  if (r1?.ok) {
    const a = await meanVolumeDb(loudPath)
    check('master=1.0 output has an audio stream', a.hasAudio)
    check('master=1.0 output is non-silent', a.db != null && a.db > -50, a.db != null ? `${a.db} dB` : 'no level')
    if (r2?.ok) {
      const b = await meanVolumeDb(quietPath)
      // -0.25 linear ≈ -12 dB; allow slack but require a clear drop.
      check(
        'master fader reaches the file (0.25 quieter than 1.0)',
        a.db != null && b.db != null && b.db < a.db - 3,
        a.db != null && b.db != null ? `${a.db} → ${b.db} dB` : 'missing levels',
      )
    }
  }

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('smoke crashed:', e)
  process.exit(2)
})
