/**
 * Pure FFmpeg per-scene audio filtergraph builder.
 *
 * Extracted from mixAudioTracks() so it can be unit-tested without spawning
 * FFmpeg, and so both the web fallback (render-server) and the Electron Tier-3
 * path share ONE filtergraph implementation. Plain JS (no TS) so audio-mixer.js
 * can import it without a build step.
 *
 * `resolved` is the object from src/lib/audio/audio-processing.ts resolveAudioProcessing(),
 * or NULL when the scene has no audioProcessing. When NULL, the emitted filtergraph
 * is BYTE-IDENTICAL to the pre-E1 behavior (the critical regression guard) — gains
 * are 1, ducking uses the legacy hardcoded params + the music track's duckLevel.
 *
 * Normalization is NOT applied here — it's a single post-stitch loudnorm pass on
 * the final concatenated video (see the stitch step). This builder only does
 * per-scene gain + ducking + mixing.
 *
 * Returns { audioInputPaths, filterComplex, audioOutLabel } or null when there is
 * no audio. Video is always FFmpeg input 0; audioInputPaths map to inputs 1..N in
 * order.
 *
/**
 * Per-category timeline mix factor: `{trackGain, pan, drop}` from
 * resolveSceneAudioMix (track volume × project master, lane pan, mute/solo drop).
 * @typedef {{trackGain?:number, pan?:number, drop?:boolean}} CategoryMix
 */

const _g = (cat) => (cat && Number.isFinite(cat.trackGain) ? cat.trackGain : 1)
const _drop = (cat) => !!(cat && cat.drop)
const _pan = (cat) => (cat && Number.isFinite(cat.pan) ? cat.pan : 0)

/**
 * Constant-power pan stage matching the Web Audio StereoPannerNode law so the
 * exported MP4 matches the preview. The source is downmixed to mono first, then
 * positioned — exact for mono sources (narration / SFX), and a sensible
 * collapse-then-position for stereo sources. Returns a comma-joinable filter.
 */
function panStage(p) {
  const rad = (p * 0.5 + 0.5) * (Math.PI / 2)
  const gL = Math.cos(rad).toFixed(6)
  const gR = Math.sin(rad).toFixed(6)
  return `aformat=channel_layouts=mono,pan=stereo|c0=${gL}*c0|c1=${gR}*c0`
}

/**
 * @param {{tts?:{path?:string,isFile?:boolean}, sfx?:Array<{path?:string,triggerAt?:number,volume?:number}>, music?:{path?:string,volume?:number,loop?:boolean,duckDuringTTS?:boolean,duckLevel?:number}}} audioTracks
 *        `tts.isFile` ⇒ the slot carries a base/imported file (lane A1 `aud-`), not narration,
 *        so its timeline mix lives in `sceneMix.file`, not `sceneMix.tts`.
 * @param {number} duration
 * @param {null | {masterGain:number,ttsGain:number,musicGain:number,sfxGain:number,ducking:{duckLevel:number,attackMs:number,releaseMs:number,ratio:number}}} resolved
 * @param {null | {tts?:CategoryMix, file?:CategoryMix, music?:CategoryMix, sfx?:Record<string,CategoryMix>}} sceneMix
 *        Per-category timeline mix. Null ⇒ unity (byte-identical to pre-fix).
 * @param {string[]} [sfxIds] Scene SFX ids parallel to audioTracks.sfx, to look up each SFX's lane mix.
 */
export function buildSceneAudioFilter(audioTracks, duration, resolved, sceneMix = null, sfxIds = []) {
  const filterParts = []
  const audioInputPaths = []
  let idx = 0 // 1-based FFmpeg input index for audio (video is 0)

  const ttsGain = resolved ? resolved.ttsGain : 1
  const sfxGain = resolved ? resolved.sfxGain : 1
  const musicGain = resolved ? resolved.musicGain : 1
  const masterGain = resolved ? resolved.masterGain : 1

  // Timeline mix for the A1 slot. TTS and base/file audio share lane A1, but the
  // slot carries only ONE of them per scene. When it's a file (isFile — routed to
  // the tts slot upstream as the single source), its fader/mute/pan live in the
  // `aud-` clip → sceneMix.file; otherwise it's narration → sceneMix.tts. (The old
  // `sceneMix.tts || sceneMix.file` always picked tts, since tts is a unity object
  // even with no narration clip, so a file's lane mix was silently dropped.)
  const ttsMix = sceneMix ? (audioTracks.tts && audioTracks.tts.isFile ? sceneMix.file : sceneMix.tts) : null
  const musicMix = sceneMix ? sceneMix.music : null
  const sfxMixFor = (i) => (sceneMix && sceneMix.sfx ? sceneMix.sfx[sfxIds[i]] : null)
  // When any category pans, every stream must be stereo or amix mixes layouts
  // unpredictably; force the non-panned ones to stereo too.
  const anyPan =
    _pan(ttsMix) !== 0 ||
    _pan(musicMix) !== 0 ||
    (audioTracks.sfx || []).some((_, i) => _pan(sfxMixFor(i)) !== 0)
  const stereoize = (p) => (p !== 0 ? panStage(p) : anyPan ? 'aformat=channel_layouts=stereo' : null)

  // v5 A3/D13#8: sidechain ducking is a NARRATION feature — a base/imported
  // file in the tts slot (isFile, now coexisting with music since the fallback
  // guard relaxed) must not duck the music under it; the preview has no such
  // behavior and the file is often itself ambience/music.
  const hasDucking = !!(
    audioTracks.music &&
    !_drop(musicMix) &&
    audioTracks.music.duckDuringTTS &&
    audioTracks.tts &&
    audioTracks.tts.path &&
    !audioTracks.tts.isFile &&
    !_drop(ttsMix)
  )

  // ── TTS ────────────────────────────────────────────────────────────────────
  if (audioTracks.tts && audioTracks.tts.path && !_drop(ttsMix)) {
    audioInputPaths.push(audioTracks.tts.path)
    idx++
    // Build the pre-[tts] filter chain as discrete stages (no trailing commas).
    // startOffset: seek into the source so export matches the preview (the
    // playback controller sets currentTime = startOffset). Without this the
    // mixer always baked from 0:00, dropping the offset.
    const stages = []
    const off = Number(audioTracks.tts.startOffset)
    if (Number.isFinite(off) && off > 0) stages.push(`atrim=start=${off.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
    // ttsGain (bus) × trackGain (lane fader × project master).
    const ttsVol = Number((ttsGain * _g(ttsMix)).toFixed(6))
    if (ttsVol !== 1) stages.push(`volume=${ttsVol}`)
    const ttsPanStage = stereoize(_pan(ttsMix))
    if (ttsPanStage) stages.push(ttsPanStage)
    if (hasDucking) {
      // split into the mix copy [tts] and the sidechain key [tts_sc]
      const pre = stages.length ? stages.join(',') + ',' : ''
      filterParts.push(`[${idx}:a]${pre}asplit=2[tts][tts_sc]`)
    } else if (stages.length) {
      filterParts.push(`[${idx}:a]${stages.join(',')}[tts]`)
    } else {
      filterParts.push(`[${idx}:a]acopy[tts]`)
    }
  }

  // ── SFX (each: delay + volume) ───────────────────────────────────────────────
  const sfxLabels = []
  ;(audioTracks.sfx || []).forEach((sfx, i) => {
    if (!sfx.path) return
    const sfxMix = sfxMixFor(i)
    if (_drop(sfxMix)) return // SFX track muted / solo-excluded
    audioInputPaths.push(sfx.path)
    idx++
    const delayMs = Math.round((sfx.triggerAt || 0) * 1000)
    const label = `sfx${sfxLabels.length}`
    const baseVol = sfx.volume == null ? 0.8 : sfx.volume
    // toFixed(6) avoids 22-digit float artifacts (0.0000012000000000000002) and
    // scientific notation leaking into the FFmpeg volume= filter string.
    // baseVol × sfxGain (bus) × trackGain (lane fader × master).
    const vol = Number((baseVol * sfxGain * _g(sfxMix)).toFixed(6))
    const chain = [`adelay=${delayMs}:all=1`, `volume=${vol}`]
    const sfxPanStage = stereoize(_pan(sfxMix))
    if (sfxPanStage) chain.push(sfxPanStage)
    filterParts.push(`[${idx}:a]${chain.join(',')}[${label}]`)
    sfxLabels.push(label)
  })

  // ── Music (optional loop, ducking when TTS present) ──────────────────────────
  let musicLabel = null
  if (audioTracks.music && audioTracks.music.path && !_drop(musicMix)) {
    audioInputPaths.push(audioTracks.music.path)
    idx++
    const baseVol = audioTracks.music.volume == null ? 0.12 : audioTracks.music.volume
    // baseVol × musicGain (bus) × trackGain (lane fader × master).
    const vol = Number((baseVol * musicGain * _g(musicMix)).toFixed(6))
    const musicPanStage = stereoize(_pan(musicMix))

    const chain = []
    if (audioTracks.music.loop) {
      const sampleCount = 999999999
      chain.push(`aloop=${sampleCount}:size=2147483647`, `atrim=0:${duration}`, `volume=${vol}`)
    } else {
      chain.push(`volume=${vol}`)
    }
    // Pan before ducking so the sidechain operates on the positioned signal.
    if (musicPanStage) chain.push(musicPanStage)
    filterParts.push(`[${idx}:a]${chain.join(',')}[music_raw]`)

    if (hasDucking) {
      // attack/release/ratio come from resolved (new E1 params) when present,
      // else the legacy hardcoded values. duckLevel is authoritative on the
      // MusicTrack (set_audio_mix mirrors ducking.duckLevel there), so a gain-only
      // mix change never resets it. Epsilon guard mirrors the resolver: a stored
      // 0 must not emit level_sc=1/0=Infinity.
      const ratio = resolved ? resolved.ducking.ratio : 10
      const attack = resolved ? resolved.ducking.attackMs : 100
      const release = resolved ? resolved.ducking.releaseMs : 500
      const duckLevel = Math.max(audioTracks.music.duckLevel || 0.2, 0.01)
      filterParts.push(
        `[music_raw][tts_sc]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=${attack}:release=${release}:level_in=1:level_sc=${(1 / duckLevel).toFixed(2)}[music]`,
      )
      musicLabel = 'music'
    } else {
      musicLabel = 'music_raw'
    }
  }

  if (audioInputPaths.length === 0) return null

  // ── Mix all audio streams ────────────────────────────────────────────────────
  const mixInputs = []
  // Must mirror the [tts] label-creation guard above — a dropped (muted/solo-
  // excluded) narration produces no [tts], so referencing it here would make
  // ffmpeg fail to bind the filtergraph and silence the WHOLE scene.
  if (audioTracks.tts && audioTracks.tts.path && !_drop(ttsMix)) mixInputs.push('[tts]')
  sfxLabels.forEach((l) => mixInputs.push(`[${l}]`))
  if (musicLabel) mixInputs.push(`[${musicLabel}]`)

  // Final output layout MUST be deterministic across scenes: the cuts-only stitch
  // concatenates per-scene MP4s with `-c copy`, so a mono scene next to a stereo
  // (panned) scene corrupts audio with no error. When a sceneMix is present at all
  // (i.e. the export path) force every scene's [aout] to stereo. When it's absent
  // (preview / legacy callers) keep the mono path → byte-identical to pre-fix.
  const forceStereo = !!sceneMix
  // With a sceneMix present (the desktop export path), multi-source
  // scenes sum at FULL gain (normalize=0) to match the preview, which sums
  // element volumes 1:1 — ffmpeg's default 1/N input scaling exported
  // narration+music ~−6 dB (and +SFX ~−9.5 dB) quieter than the player, and
  // dropout_transition=2 swelled the music for 2 s after narration ended.
  // Full-gain summing can clip where 1/N couldn't, so a soft limiter caps the
  // chain — LAST in the gain chain, after volume=masterGain (limiting before
  // it would re-clip whenever masterGain > 1). sceneMix=null callers
  // (preview / web-fallback legacy) keep the old graph byte-identical.
  const fullGainMix = !!sceneMix && mixInputs.length > 1
  // Where the mix + master land before the optional stereo normalize.
  const preLabel = forceStereo ? '[prestereo]' : '[aout]'
  const limitOut = fullGainMix ? '[prelimit]' : preLabel
  const mixOut = masterGain !== 1 ? '[premaster]' : limitOut
  if (mixInputs.length === 1) {
    filterParts.push(`${mixInputs[0]}apad=pad_dur=${duration}${mixOut}`)
  } else {
    const mixOpts = fullGainMix ? 'normalize=0:dropout_transition=0' : 'dropout_transition=2'
    filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:${mixOpts}${mixOut}`)
  }
  if (masterGain !== 1) {
    filterParts.push(`[premaster]volume=${masterGain}${limitOut}`)
  }
  if (fullGainMix) {
    filterParts.push(`[prelimit]alimiter=limit=0.97:level=false${preLabel}`)
  }
  if (forceStereo) {
    filterParts.push(`${preLabel}aformat=channel_layouts=stereo[aout]`)
  }

  return { audioInputPaths, filterComplex: filterParts.join(';'), audioOutLabel: 'aout' }
}
