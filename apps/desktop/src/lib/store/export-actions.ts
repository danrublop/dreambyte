'use client'

import type { ExportSettings, ExportProgress } from '../types'
import { generateSceneHTML } from '../sceneTemplate'
import { resolveProjectDimensions } from '../dimensions'
import { buildExportCaptionBundle, hasXfadeTransitions } from '../export/caption-burnin'
import { reconcileSceneExportDuration } from '../export/reconcile-scene-duration'
import { chooseIntermediateCodec } from '../export/intermediate-codec'
import { normalizeExportSettings } from '../export/export-settings-validation'
import { resolveProgramNormalizeTarget } from '../audio/audio-processing'
import { buildProgramAudioClips } from '../audio/program-audio'
import { getCompositeDuration, getSequenceClips } from '../timeline/sequence'
import { buildAudioUrlMap } from '../audio/audio-url-map'
import { resolveMasterGain } from '../audio/mix-math'
import { resolveSceneAudioMix } from '../audio/scene-audio-mix'
import { shouldCancel, cancelledProgress } from './export-cancel'
import type { Set, Get } from './types'

export function createExportActions(set: Set, get: Get) {
  return {
    openExportModal: () => set({ isExportModalOpen: true }),
    closeExportModal: () => set({ isExportModalOpen: false, exportProgress: null }),

    exportVideo: async (settings: ExportSettings) => {
      // Harden at the source: the agent entry paths (src/electron/main.ts,
      // use-agent-run.ts) validate before calling, but exportVideo itself
      // trusted its caller — a hand-built settings object with out-of-range
      // fps/resolution reached the WebCodecs encoder config unchecked
      // (TODOS "Agent export pipeline" item 4). Normalize here so every
      // caller is covered.
      const requestedFps = settings.fps
      const requestedResolution = settings.resolution
      settings = { ...settings, ...normalizeExportSettings(settings) }
      const { scenes } = get()

      // Path 2 (Electron): WebCodecs + Pixi exporter (single scene v1).
      // This runs only in Electron where preload exposes window.electronAPI.
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        // Re-entrancy guard: isExporting / exportProgress are a single shared
        // slot. A second concurrent export (manual + agent, or two agents)
        // would clobber the in-flight one's progress and corrupt main.ts's
        // progress poll. Reject the newcomer before touching shared state so
        // the running export is untouched. Thrown (not phase='error') so we
        // don't overwrite the live export's progress; headless callers catch it.
        if (get().isExporting) {
          throw new Error('An export is already in progress')
        }

        // Materialize the timeline from the current scenes BEFORE resolving the
        // export audio mix. In-editor exports already have a synced timeline (the
        // Timeline component syncs on mount), but a headless export of a project
        // never opened in the editor would mix against a stale/unmaterialized
        // projection — silently ignoring track faders / pan / mute on scene audio
        // that wasn't placed on a track yet. Idempotent: re-syncing a current
        // timeline just re-derives the same gapless layout. (Placed AFTER the
        // re-entrancy guard so a rejected concurrent export never mutates state.)
        // Optional-call: defensive if the action is ever absent (and lets export
        // unit tests that stub a partial store skip it).
        get().syncTimelineFromScenes?.()

        // PIXEL-UNIFY: the single pixel path is the composite
        // (planCompositeFrame), and the router below takes it whenever a composite
        // timeline exists. The `syncTimelineFromScenes()` above derives one from
        // scenes[], so a normal scene export always lands on the composite.
        //
        // We deliberately do NOT re-call syncTimelineFromScenes here as a "safety
        // net": it is deterministic on (scenes, timeline), so a second call on the
        // unchanged state can only return the same result — a null timeline already
        // routed through initTimeline() above (duration > 0), a timeline with no V1
        // video track hits the `if (!v1) return` early-out identically on both
        // calls, and all-zero scene durations stay zero. A re-sync would be a
        // confirmed no-op (an earlier draft of P1a shipped exactly that, advertising
        // a guarantee it could not provide — removed). When a composite timeline is
        // genuinely absent the router still falls to the pixi second path; that is
        // not silenced but made traceable by the loud P1b diagnostics below (which
        // name *why* the unified path was skipped).

        // Why the export router skipped the unified composite path, if it did — set
        // at the fall-through points below so the all-legacy P1b diagnostic can
        // report the real reason instead of guessing (a video/avatar scene with no
        // composite timeline is NOT an "IPC unavailable" case).
        let legacyReason: 'incompatible-scene' | null = null

        const diagnostics: string[] = []
        const pushDiag = (msg: string) => {
          diagnostics.push(msg)
          if (diagnostics.length > 60) diagnostics.shift()
          const p = get().exportProgress
          if (!p) return
          set({
            exportProgress: {
              ...p,
              diagnostics: [...diagnostics],
            },
          })
        }

        // Native completion notification (desktop polish). Fires only when
        // the window is unfocused (the IPC enforces that) so a user watching the
        // export bar isn't double-notified. Best-effort: no-op on web / when the
        // bridge is absent.
        const notifyExportDone = (outPath: string | null) => {
          try {
            // Respect the General → Notifications preference (default on).
            const pref =
              typeof window !== 'undefined'
                ? window.localStorage.getItem('dreambyte:settings:systemNotifications')
                : null
            if (pref === 'false') return
            const appApi = (globalThis as { dreambyteApi?: { app?: { notify?: (p: unknown) => unknown } } })
              .dreambyteApi?.app
            const name = outPath ? outPath.split(/[\\/]/).pop() : null
            void appApi?.notify?.({
              title: 'Export complete',
              body: name ? `${name} is ready.` : 'Your video finished exporting.',
            })
          } catch {
            // Notification is pure polish — never let it affect the export result.
          }
        }

        // 11b: stamp which scene a per-scene render failure belongs to. The
        // error catch at the bottom reads these fields — explicit tagging at
        // the throw site beats inferring from the progress slot, which only
        // advances once frames start flowing (an immediate scene-start throw
        // would be attributed to the PREVIOUS scene). The slot stays as the
        // fallback for the tier3 batch path, whose per-scene errors arrive
        // through one IPC call.
        // NAMING MAP (the same concept wears three names; they never coexist
        // on one object): these `exportScene*` fields live on the in-renderer
        // Error only — the executeJavaScript bridge STRIPS custom fields, so
        // src/electron/main.ts re-derives `sceneIndex`/`sceneId` from the progress
        // slot, and both store/registry persist them as `errorSceneIndex`/
        // `errorSceneId`.
        const tagSceneError = (err: unknown, idx: number, scene: { id: string; name?: string | null }) => {
          const e = err instanceof Error ? err : new Error(String(err))
          if (e.message === CANCEL_SENTINEL) return e // a user cancel is not a scene failure
          const tagged = e as Error & { exportSceneIndex?: number; exportSceneId?: string; exportSceneName?: string }
          tagged.exportSceneIndex ??= idx + 1
          tagged.exportSceneId ??= scene.id
          tagged.exportSceneName ??= scene.name ?? undefined
          return tagged
        }

        // Per-scene export duration reconciliation — a READY avatar/Veo
        // clip (or its paired lipsync narration track) that runs past the
        // authored scene duration extends the exported scene (per-layer
        // timingPolicy, default 'extend-scene') instead of being silently cut
        // off mid-sentence. Memoized per scene id so spec builds, caption
        // offsets and diagnostics all agree on ONE effective duration —
        // captions cut from a different duration than the video renders would
        // drift on every scene after the extended one.
        const reconciledDurations = new Map<string, number>()
        const reconcileForExport = (scene: (typeof scenes)[number], idx?: number): number => {
          const cached = reconciledDurations.get(scene.id)
          if (cached !== undefined) return cached
          const r = reconcileSceneExportDuration(scene)
          if (r.extended) {
            pushDiag(
              `scene ${idx !== undefined ? idx + 1 : scene.id}: extended ${scene.duration}s → ${r.duration.toFixed(2)}s to fit generated clip (${r.limitingLayerId})`,
            )
          }
          reconciledDurations.set(scene.id, r.duration)
          return r.duration
        }

        // One home for caption-bundle assembly (was triplicated across the
        // three export paths' sidecar blocks). Null on NLE-timeline projects.
        // Transition fields let the bundle compensate for xfade shortening so
        // sidecar cue offsets match the stitched output, not the raw durations.
        // Durations are the reconciled ones for the same reason.
        //
        // LAZY ON PURPOSE (review #147): nothing here may call reconcileForExport
        // before the render loops do — the loops reconcile the DB-HYDRATED
        // fullScene, and the memo is first-caller-wins. An eager call here would
        // seed the cache from the IN-MEMORY scene, and a stale in-memory copy
        // (multi-window edits, a poller that updated the DB after this window's
        // snapshot) would silently re-cut the clip that reconciliation protects. All
        // three paths call getCaptionBundle AFTER their render loop, so the
        // hydrated values win and captions reuse exactly what the video used.
        const captionSceneInputs = () =>
          scenes.map((s, i) => ({
            duration: reconcileForExport(s, i),
            words: s.audioLayer?.tts?.captions?.words,
            transitionToNext: s.transition,
            transitionToNextDuration: 0.5, // every export path requests 0.5s joins
          }))
        const getCaptionBundle = () => buildExportCaptionBundle(captionSceneInputs(), !!get().project?.timeline)
        // Burn-in is gated to cuts-only exports: one real transition flips the
        // stitcher onto its xfade path, whose re-encode is meant to be the ONLY
        // lossy pass — burning on top would compound a second full re-encode.
        // ExportPanel disables the checkbox too; this is defense-in-depth.
        // Transitions-only check — deliberately does NOT touch durations (see
        // the lazy-on-purpose note above).
        const burnGatedByXfade = scenes.slice(0, -1).some((s) => (s.transition ?? 'none') !== 'none')
        // Burn-timeout hint; lazy for the same cache-seeding reason.
        const totalCaptionSeconds = () => scenes.reduce((sum, s, i) => sum + reconcileForExport(s, i), 0)
        const BURN_GATED_WARNING =
          "Captions were NOT burned in — burn-in isn't supported with scene transitions yet; sidecar .srt/.vtt files were written instead."
        const BURN_FAILED_WARNING =
          'Captions were NOT burned in — the burn step failed; the video exported without them (sidecar .srt/.vtt written).'
        let captionWarning: string | null = null
        // v5 A1/D3: standalone timeline audio (files on audio tracks), computed
        // ONCE for all three engines. The all-tier3 path overlays it inside
        // runTier3Export; the mixed/legacy paths pass it to concatMp4, which
        // overlays between stitch and loudnorm (same ordering as tier3). A
        // 'failed' status means the user's music is NOT in the MP4 — that must
        // surface as a visible warning, never a silent miss.
        const PROGRAM_AUDIO_FAILED_WARNING =
          'Timeline audio was NOT included — the audio-overlay step failed; the video exported without your standalone music/audio clips.'
        let programAudioWarning: string | null = null
        // Narration whose only voice came from a client-only TTS provider
        // (web-speech / puter) can't render to audio in the export pipeline, so
        // the MP4 is silent. Surface it instead of shipping a silent video.
        const CLIENT_ONLY_NARRATION_WARNING =
          'Narration was NOT included — the selected voice is a preview-only (in-browser) provider that cannot render to audio. Pick a server voice (e.g. ElevenLabs) and re-export for narrated audio.'
        let clientOnlyNarrationWarning: string | null = null
        const exportTimelineAudio = buildProgramAudioClips(
          get().project?.timeline,
          buildAudioUrlMap(get().scenes ?? []),
          get().project?.audioSettings,
          // D3: pass scenes so avatar voice rides the overlay — existing
          // avatar-audio mirror clips are resolved to their video URL, and a
          // ready avatar layer with no mirror clip yet is synthesized (OV#9).
          get().scenes ?? [],
        )
        const exportMasterVolume = resolveMasterGain(get().project?.audioSettings?.masterVolume)
        const exportWarning = () =>
          [programAudioWarning, clientOnlyNarrationWarning, captionWarning].filter(Boolean).join(' ') || null
        const noteProgramAudio = (status: 'applied' | 'failed' | null | undefined) => {
          if (status === 'failed') {
            programAudioWarning = PROGRAM_AUDIO_FAILED_WARNING
            pushDiag('timeline audio: overlay FAILED — exported without standalone audio clips')
          } else if (status === 'applied') {
            pushDiag(`timeline audio: ${exportTimelineAudio.length} clip(s) overlaid`)
          }
        }

        set({
          isExporting: true,
          // Fresh run — clear any cancel request left from a prior export.
          exportCancelRequested: false,
          exportProgress: {
            phase: 'rendering',
            currentScene: 1,
            totalScenes: scenes.length,
            sceneProgress: 0,
            downloadUrl: null,
            error: null,
            diagnostics: [],
          },
        })

        // Surface a silent value substitution: if normalization changed the
        // caller's fps/resolution (agent-requested 50fps → 60, bogus res →
        // 1080p), say so in the diagnostics instead of encoding a different
        // rate than the caller asked for with no trace.
        if (settings.fps !== requestedFps || settings.resolution !== requestedResolution) {
          pushDiag(
            `export settings normalized: fps ${String(requestedFps)} → ${settings.fps}, ` +
              `resolution ${String(requestedResolution)} → ${settings.resolution}`,
          )
        }

        // Cancellation seam. The real per-frame encode lives in the main
        // process behind one IPC, so we check this at every renderer-side scene
        // boundary and before each finalize/mux step. When tripped we set phase
        // 'cancelled' + status 'cancelled' and bail — a cancelled export NEVER
        // reports success or presents a partial MP4. Throws a sentinel so the
        // single try/catch unwinds without recording phase='error'/'success'.
        const CANCEL_SENTINEL = '__dreambyte_export_cancelled__'

        // COMMIT 3: track every artifact written to disk so a cancel/error can
        // clean them up. `.scene-NNN.mp4` parts (both the legacy and mixed
        // paths) plus the tier3 output file. The catch best-effort deletes these
        // via the cleanupExportArtifacts IPC (main enforces strict containment).
        const writtenArtifacts = new Set<string>()
        const trackArtifact = (p: string) => writtenArtifacts.add(p)
        const cleanupArtifacts = async () => {
          const paths = [...writtenArtifacts]
          if (paths.length === 0) return { deleted: [] as string[], ok: true }
          try {
            const api = (window as any).electronAPI
            if (typeof api?.cleanupExportArtifacts === 'function') {
              const res = await api.cleanupExportArtifacts({ paths })
              return { deleted: res?.deleted ?? [], ok: true }
            }
          } catch {
            // Best-effort — a cleanup failure must not mask the export outcome.
          }
          return { deleted: [] as string[], ok: false }
        }

        const bailIfCancelled = () => {
          if (!shouldCancel(get().exportCancelRequested, get().isExporting)) return
          pushDiag('export: cancelled by user')
          set({
            exportProgress: cancelledProgress(get().exportProgress, scenes.length),
            lastExportStatus: 'cancelled',
          })
          throw new Error(CANCEL_SENTINEL)
        }

        try {
          // A MEDIA-ONLY timeline (bare video/image clips, no scenes) is a valid
          // export — the single-stream composite renders the clips directly and
          // getCompositeDuration spans them. Only bail when there is genuinely
          // nothing to render (no scenes AND no composite-renderable timeline).
          if (scenes.length === 0 && !(getCompositeDuration(get().project?.timeline) > 0)) {
            throw new Error('Nothing to export — add a scene or a clip to the timeline')
          }

          let filePath: string
          if (settings.outputPath) {
            // Headless mode: skip save dialog
            filePath = settings.outputPath
          } else {
            const suggested = `${settings.outputName || 'export'}.mp4`
            const pick = await (window as any).electronAPI.saveDialog(suggested)
            if (pick.canceled || !pick.filePath) {
              set({ exportProgress: null })
              return
            }
            filePath = pick.filePath
          }
          pushDiag(`save: ${filePath}`)

          // ── Tier 3 real-compositor capture (additive, behind engine flag) ──
          // generateSceneHTML emits a fully self-contained scene (text
          // overlays, AI image layers, camera motion, watermark all baked in) —
          // exactly what the editor preview / published embed render. The
          // legacy pixi path re-rasterizes it with html2canvas, which drops
          // Chrome's gradient dither (→ banding) + box-shadow/filter/blend.
          // Capturing the real Chromium compositor reproduces them. A
          // frame-stepped deterministic seek can't sync an HTML <video>, so
          // scenes with a background video / avatar / veo3 layer fall back to
          // the legacy path below.
          // Tier 3 (real-compositor capture) is the default. Falls back to the
          // legacy pixi path automatically for scenes with a video/avatar layer
          // (below), and can be forced off with settings.engine='legacy' or
          // DREAMBYTE_EXPORT_ENGINE=legacy (surfaced as window.__DREAMBYTE_EXPORT_ENGINE).
          const engine =
            settings.engine ??
            (typeof window !== 'undefined'
              ? ((window as any).__DREAMBYTE_EXPORT_ENGINE as 'tier3' | 'legacy' | undefined)
              : undefined) ??
            'tier3'
          const tier3Capable = (s: (typeof scenes)[number]) =>
            !s.videoLayer?.enabled && !(s.aiLayers ?? []).some((l) => l.type === 'avatar' || l.type === 'veo3')
          const electronAPI = (window as any).electronAPI
          if (engine === 'tier3' && typeof electronAPI?.exportTier3 === 'function') {
            const incompatible = scenes.find((s) => !tier3Capable(s))
            // T7b: when an NLE timeline exists, the single-stream COMPOSITE renders
            // EVERY scene — including video/avatar scenes — through the host's <video>
            // frame-seek, so it supersedes the mixed/legacy split. Only fall to the
            // mixed engine for NON-timeline projects that contain a video scene.
            const compositeTl = get().project?.timeline
            const usingCompositeEngine = !!compositeTl && getCompositeDuration(compositeTl) > 0
            if (incompatible && !usingCompositeEngine) {
              const someTier3 = scenes.some(tier3Capable)
              if (someTier3 && typeof electronAPI?.exportTier3Scene === 'function') {
                // ── Mixed engine (Lane C) ──────────────────────────────────
                // tier3 (real-compositor) for capable scenes, legacy pixi for
                // video/avatar/veo3 scenes, then one stitch. Only triggers for
                // genuinely mixed projects — all-tier3 and all-legacy keep their
                // own validated paths (the else branch + the fallthrough below).
                // NOTE: typechecked but not yet run end-to-end — validate with an
                // in-app mixed export (text + video scene + crossfade).
                pushDiag('engine: mixed (tier3 + legacy per scene)')
                // PIXEL-UNIFY (P1b): we are LEAVING the unified composite
                // pixel path (this video/avatar scene renders via pixi, not
                // planCompositeFrame), so the export can diverge from the preview.
                // Make that explicit + traceable rather than a silent split. A
                // composite timeline normally exists here (the sync at the top of
                // exportVideo derives one from scenes[]); this branch fires only for
                // a no-composite project with a
                // video/avatar scene.
                pushDiag(
                  'pixel-path: NOT unified — no composite timeline + a video/avatar scene → pixi fallback (preview may differ)',
                )
                const mixDims = resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, settings.resolution)
                const sceneDims = resolveProjectDimensions(
                  get().project.mp4Settings?.aspectRatio,
                  get().project.mp4Settings?.resolution,
                )
                const mixFps = settings.fps
                const mixCodec = chooseIntermediateCodec(
                  scenes.slice(0, -1).map((s) => ({ type: s.transition ?? 'none' })),
                )
                const { exportSolidSceneMp4 } = await import('../export2/pixi-mp4')
                const mixPartPaths: string[] = []
                for (let idx = 0; idx < scenes.length; idx++) {
                  bailIfCancelled() // cancel between scenes
                  const scene = scenes[idx]
                  set({
                    exportProgress: {
                      phase: 'rendering',
                      currentScene: idx + 1,
                      totalScenes: scenes.length,
                      sceneProgress: 0,
                      downloadUrl: null,
                      error: null,
                      diagnostics: [...diagnostics],
                    },
                  })
                  let fullScene = scene
                  try {
                    const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
                    if (sceneIpc) {
                      const fullData = await sceneIpc.get({ projectId: get().project.id, sceneId: scene.id })
                      if (fullData?.scene) fullScene = { ...scene, ...(fullData.scene as Partial<typeof scene>) }
                    }
                  } catch (e) {
                    // Non-fatal: fall back to the in-memory scene if the DB
                    // hydrate fails. Surface it in the export diagnostics so a
                    // missing svgContent/sceneCode has a breadcrumb.
                    pushDiag(`scene ${idx + 1}: DB hydrate failed (${String(e)}); using in-memory scene`)
                  }
                  const html = generateSceneHTML(
                    fullScene,
                    get().globalStyle,
                    undefined,
                    get().audioSettings,
                    sceneDims,
                  )
                  // Reconciled duration — avatar/veo scenes (always legacy
                  // here) grow to fit their generated clip + narration.
                  const mixDuration = reconcileForExport(fullScene, idx)
                  if (tier3Capable(scene)) {
                    pushDiag(`render: scene ${idx + 1} (tier3)`)
                    let res: { outputPath: string }
                    try {
                      res = await electronAPI.exportTier3Scene({
                        spec: {
                          id: fullScene.id,
                          html,
                          durationSeconds: mixDuration,
                          sceneType: fullScene.sceneType,
                          bgColor: scene.bgColor || '#000000',
                          transition: scene.transition,
                          audioLayer: scene.audioLayer as any,
                          sceneAudioMix: resolveSceneAudioMix(
                            fullScene,
                            get().project?.timeline?.tracks ?? [],
                            get().project?.audioSettings?.masterVolume,
                          ),
                        },
                        fps: mixFps,
                        width: mixDims.width,
                        height: mixDims.height,
                        profile: settings.profile ?? 'quality',
                        intermediateCodec: mixCodec,
                      })
                    } catch (sceneErr) {
                      throw tagSceneError(sceneErr, idx, fullScene) // 11b
                    }
                    mixPartPaths.push(res.outputPath)
                  } else {
                    pushDiag(`render: scene ${idx + 1} (legacy)`)
                    const partPath = `${filePath}.scene-${String(idx + 1).padStart(3, '0')}.mp4`
                    const bytes = await exportSolidSceneMp4({
                      sceneId: fullScene.id,
                      width: mixDims.width,
                      height: mixDims.height,
                      fps: mixFps,
                      durationSeconds: mixDuration,
                      sceneType: fullScene.sceneType,
                      svgContent: fullScene.svgContent,
                      sceneHTML: html,
                      bgColor: scene.bgColor || '#000000',
                      videoSrc: scene.videoLayer?.enabled ? scene.videoLayer.src : null,
                      videoOpacity: scene.videoLayer?.opacity ?? 1,
                      trimStart: scene.videoLayer?.trimStart ?? 0,
                      trimEnd: scene.videoLayer?.trimEnd ?? null,
                      textOverlays: scene.textOverlays as any,
                      svgObjects: scene.svgObjects as any,
                      aiLayers: scene.aiLayers as any,
                      layerHiddenIds: scene.layerHiddenIds ?? [],
                      layerPanelOrder: scene.layerPanelOrder ?? [],
                      cameraMotion: scene.cameraMotion as any,
                      audioSrc: scene.audioLayer?.enabled ? scene.audioLayer.src : null,
                      audioStartOffset: scene.audioLayer?.startOffset ?? 0,
                      audioVolume: scene.audioLayer?.volume ?? 1,
                      audioFadeIn: scene.audioLayer?.fadeIn ?? false,
                      audioFadeOut: scene.audioLayer?.fadeOut ?? false,
                      audioLayer: scene.audioLayer as any,
                      sceneAudioMix: resolveSceneAudioMix(
                        fullScene,
                        get().project?.timeline?.tracks ?? [],
                        get().project?.audioSettings?.masterVolume,
                      ),
                      profile: settings.profile ?? 'quality',
                      onProgress: (ratio) =>
                        set({
                          exportProgress: {
                            phase: 'rendering',
                            currentScene: idx + 1,
                            totalScenes: scenes.length,
                            sceneProgress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
                            downloadUrl: null,
                            error: null,
                            diagnostics: [...diagnostics],
                          },
                        }),
                      onLog: (message) => pushDiag(`s${idx + 1}: ${message}`),
                    }).catch((sceneErr) => {
                      throw tagSceneError(sceneErr, idx, fullScene) // 11b
                    })
                    await electronAPI.writeFile({ filePath: partPath, bytes })
                    mixPartPaths.push(partPath)
                    trackArtifact(partPath) // COMMIT 3: clean up on cancel/error
                  }
                }
                // Last chance to cancel before the finalize/mux phase — after
                // concat starts a torn MP4 could result, so cancel is gated off.
                bailIfCancelled()
                set({
                  exportProgress: {
                    phase: 'stitching',
                    currentScene: scenes.length,
                    totalScenes: scenes.length,
                    sceneProgress: 100,
                    downloadUrl: null,
                    error: null,
                    diagnostics: [...diagnostics],
                  },
                })
                pushDiag(`concat: ${mixPartPaths.length} scene files (mixed)`)
                const mixTransitions = scenes.slice(0, -1).map((s) => ({ type: s.transition, duration: 0.5 }))
                // Same program-normalize policy as the pure-pixi path below.
                const mixNorm = resolveProgramNormalizeTarget(
                  scenes.map((s) => ({ audioProcessing: s.audioLayer?.audioProcessing })),
                )
                if (mixNorm.targetLufs != null) pushDiag(`normalize: ${mixNorm.targetLufs} LUFS`)
                const mixConcat = await electronAPI.concatMp4({
                  inputs: mixPartPaths,
                  output: filePath,
                  transitions: mixTransitions,
                  cleanup: true,
                  // Mixed parts come from two different H.264 encoders — force a
                  // re-encode so the cuts path doesn't stream-copy incompatible
                  // streams into a glitching file.
                  reencode: true,
                  normalizeTargetLufs: mixNorm.targetLufs ?? undefined,
                  // Per-scene tier3 sub-exports deliberately get NO
                  // timelineAudio (Tier3SingleSceneArgs has no such field) — the
                  // overlay happens exactly once, here at the final concat.
                  timelineAudio: exportTimelineAudio,
                  masterVolume: exportMasterVolume,
                })
                pushDiag('concat: done')
                noteProgramAudio(mixConcat.programAudio)
                try {
                  const bundle = getCaptionBundle()
                  if (bundle) {
                    const base = filePath.replace(/\.mp4$/i, '')
                    const encoder = new TextEncoder()
                    await electronAPI.writeFile({ filePath: `${base}.srt`, bytes: encoder.encode(bundle.srt) })
                    await electronAPI.writeFile({ filePath: `${base}.vtt`, bytes: encoder.encode(bundle.vtt) })
                    pushDiag(`captions: wrote ${bundle.cues.length} cues (.srt + .vtt)`)
                    if (settings.burnCaptions && burnGatedByXfade) {
                      pushDiag('captions: burn-in skipped — scene transitions present (would double re-encode)')
                      captionWarning = BURN_GATED_WARNING
                    } else if (settings.burnCaptions) {
                      pushDiag(`captions: burning ${bundle.cues.length} cues into video`)
                      const r = await electronAPI.exportBurnCaptions({
                        filePath,
                        srt: bundle.srt,
                        width: mixDims.width,
                        height: mixDims.height,
                        totalSeconds: totalCaptionSeconds(),
                        fps: settings.fps,
                      })
                      pushDiag(
                        r.ok ? 'captions: burn-in done' : 'captions: burn-in FAILED — exported without burned captions',
                      )
                      if (!r.ok) captionWarning = BURN_FAILED_WARNING
                    }
                  } else if (settings.burnCaptions) {
                    pushDiag('captions: burn-in requested but no caption cues exist — skipped')
                  }
                } catch (capErr) {
                  pushDiag(`captions: skipped (${String(capErr)})`)
                }
                set({
                  exportProgress: {
                    phase: 'complete',
                    currentScene: scenes.length,
                    totalScenes: scenes.length,
                    sceneProgress: 100,
                    downloadUrl: null,
                    filePath,
                    error: null,
                    warning: exportWarning(),
                    diagnostics: [...diagnostics],
                  },
                  lastExportStatus: 'success',
                })
                notifyExportDone(filePath)
                return
              }
              // Falls through to the all-legacy pixi path below (no mixable split
              // available). Record the real reason so its P1b diagnostic doesn't
              // mislabel this as "IPC unavailable" — the IPC is present; the scene
              // is a video/avatar with no composite timeline to route through.
              legacyReason = 'incompatible-scene'
              pushDiag(
                `tier3: scene "${incompatible.name ?? incompatible.id}" has a video/avatar layer — using legacy engine`,
              )
            } else {
              pushDiag('engine: tier3 (real-compositor capture)')
              const { resolution: tier3Resolution, fps: tier3Fps } = settings
              const tier3Dims = resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, tier3Resolution)
              const specs: Array<{
                id: string
                html: string
                durationSeconds: number
                sceneType?: string
                bgColor?: string
                transition?: string
                audioLayer?: any
                sceneAudioMix?: import('../audio/scene-audio-mix').SceneAudioMix | null
                isVideoScene?: boolean
              }> = []
              for (let idx = 0; idx < scenes.length; idx++) {
                const scene = scenes[idx]
                pushDiag(`prepare: scene ${idx + 1}/${scenes.length}`)
                let fullScene = scene
                try {
                  const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
                  if (sceneIpc) {
                    const fullData = await sceneIpc.get({ projectId: get().project.id, sceneId: scene.id })
                    if (fullData?.scene) fullScene = { ...scene, ...(fullData.scene as Partial<typeof scene>) }
                  }
                } catch (e) {
                  // Non-fatal: fall back to in-memory scene; record a
                  // breadcrumb in the export diagnostics.
                  pushDiag(`scene ${idx + 1}: DB hydrate failed (${String(e)}); using in-memory scene`)
                }
                const html = generateSceneHTML(
                  fullScene,
                  get().globalStyle,
                  undefined,
                  get().audioSettings,
                  resolveProjectDimensions(
                    get().project.mp4Settings?.aspectRatio,
                    get().project.mp4Settings?.resolution,
                  ),
                )
                specs.push({
                  id: fullScene.id,
                  html,
                  // Reconciled (tier3-capable scenes have no avatar/veo
                  // layers, so this is a no-op here — kept for one invariant:
                  // every spec carries the reconciled duration).
                  durationSeconds: reconcileForExport(fullScene, idx),
                  sceneType: fullScene.sceneType,
                  bgColor: scene.bgColor || '#000000',
                  transition: scene.transition,
                  audioLayer: scene.audioLayer as any,
                  sceneAudioMix: resolveSceneAudioMix(
                    fullScene,
                    get().project?.timeline?.tracks ?? [],
                    get().project?.audioSettings?.masterVolume,
                  ),
                  // T7b: a video/avatar scene carries a <video> the composite host
                  // must frame-seek (await 'seeked') — flag it for the seek path.
                  isVideoScene:
                    !!fullScene.videoLayer?.enabled ||
                    (fullScene.aiLayers ?? []).some((l) => l.type === 'avatar' || l.type === 'veo3'),
                })
              }

              const unsub = electronAPI.onExportTier3Progress(
                (p: { phase: string; currentScene: number; totalScenes: number; sceneProgress: number }) => {
                  const phase: ExportProgress['phase'] =
                    p.phase === 'mixing_audio' ? 'mixing_audio' : p.phase === 'stitching' ? 'stitching' : 'rendering'
                  set({
                    exportProgress: {
                      phase,
                      currentScene: p.currentScene,
                      totalScenes: p.totalScenes,
                      sceneProgress: Math.max(0, Math.min(100, Math.round(p.sceneProgress))),
                      downloadUrl: null,
                      error: null,
                      diagnostics: [...diagnostics],
                    },
                  })
                },
              )
              try {
                // With an NLE timeline, the all-tier3 path exports via the
                // single-stream COMPOSITE (true gaps + V2-over-V1) instead of
                // per-scene+stitch. Scene audio then rides the program bus
                // (includeSceneMirror — no per-scene bake) and captions offset by
                // real clip startTimes; neither is valid for the legacy path, so
                // both are computed only in this branch.
                const compositeTimeline = get().project?.timeline
                const usingComposite = !!compositeTimeline && getCompositeDuration(compositeTimeline) > 0
                const tier3Audio = usingComposite
                  ? buildProgramAudioClips(
                      compositeTimeline,
                      buildAudioUrlMap(get().scenes ?? []),
                      get().project?.audioSettings,
                      get().scenes ?? [],
                      { includeSceneMirror: true },
                    )
                  : exportTimelineAudio
                const tier3CaptionBundle = !settings.burnCaptions
                  ? null
                  : usingComposite
                    ? (() => {
                        // Offset each scene's captions by its real clip startTime
                        // (composite renders in timeline order, not scenes[] order).
                        const startById = new Map(
                          getSequenceClips(compositeTimeline).map((c) => [c.sourceId, c.startTime]),
                        )
                        return buildExportCaptionBundle(
                          captionSceneInputs(),
                          true,
                          scenes.map((s) => (startById.has(s.id) ? (startById.get(s.id) as number) : null)),
                        )
                      })()
                    : !burnGatedByXfade
                      ? getCaptionBundle()
                      : null
                if (settings.burnCaptions && !usingComposite && burnGatedByXfade) {
                  pushDiag('captions: burn-in skipped — scene transitions present (would double re-encode)')
                  captionWarning = BURN_GATED_WARNING
                } else if (settings.burnCaptions && !tier3CaptionBundle) {
                  pushDiag('captions: burn-in requested but no caption cues exist — skipped')
                } else if (tier3CaptionBundle) {
                  pushDiag(`captions: burning ${tier3CaptionBundle.cues.length} cues into video`)
                }
                const tier3Result = await electronAPI.exportTier3({
                  scenes: specs,
                  outputPath: filePath,
                  fps: tier3Fps,
                  width: tier3Dims.width,
                  height: tier3Dims.height,
                  profile: settings.profile ?? 'quality',
                  // Scene audio (composite) or standalone-only (legacy). The scene
                  // url-map resolves mirror ids; includeSceneMirror folds scene
                  // audio onto the bus for the composite (no per-scene bake).
                  timelineAudio: tier3Audio,
                  masterVolume: exportMasterVolume,
                  // The composite trigger: main routes to captureCompositeToVideo.
                  ...(usingComposite ? { timeline: compositeTimeline } : {}),
                  ...(tier3CaptionBundle ? { burnCaptionsSrt: tier3CaptionBundle.srt } : {}),
                })
                if (tier3CaptionBundle && tier3Result.captionsBurned === false) {
                  pushDiag('captions: burn-in FAILED — exported without burned captions')
                  captionWarning = BURN_FAILED_WARNING
                } else if (tier3CaptionBundle && tier3Result.captionsBurned) {
                  pushDiag('captions: burn-in done')
                }
                // v5 D3: tier3's overlay failure used to be a buried log line —
                // surface it exactly like the mixed/legacy paths do.
                noteProgramAudio(tier3Result.programAudio)
                // Client-only narration (web-speech/puter) renders silent —
                // surface it so a narrated export doesn't ship without audio.
                if (tier3Result.clientOnlyNarration) {
                  clientOnlyNarrationWarning = CLIENT_ONLY_NARRATION_WARNING
                  pushDiag('narration: client-only TTS provider — exported WITHOUT narration audio')
                }
              } finally {
                try {
                  unsub?.()
                } catch {
                  // Non-fatal: unsubscribing the tier3 progress listener
                  // is best-effort cleanup in a finally — a throw here must not
                  // mask the export's real outcome.
                }
              }
              pushDiag('tier3: render complete')

              // The all-tier3 encode runs in one main-process call we can't
              // interrupt, so a cancel only lands AFTER exportTier3 has already
              // written a COMPLETE MP4 at filePath. Track it so the discard
              // below (and the catch) can delete it.
              trackArtifact(filePath)

              // If cancel was requested during the tier3 render,
              // DISCARD the result — delete the written output so we never leave
              // a complete MP4 on disk while status says cancelled. If deletion
              // fails, be honest: the cancelled-progress error states a file WAS
              // written at <path> rather than silently implying nothing remains.
              if (shouldCancel(get().exportCancelRequested, get().isExporting)) {
                pushDiag('export: cancelled by user (tier3 — discarding written output)')
                const { deleted } = await cleanupArtifacts()
                // The IPC resolves the path it deleted; if it removed anything we
                // treat the output as discarded (filePath was the tracked output).
                const removed = deleted.length > 0
                const cancelled = cancelledProgress(get().exportProgress, scenes.length)
                set({
                  exportProgress: removed
                    ? cancelled
                    : {
                        ...cancelled,
                        error: `Export cancelled, but a finished file was already written at ${filePath} and could not be removed automatically — delete it manually.`,
                      },
                  lastExportStatus: 'cancelled',
                })
                throw new Error(CANCEL_SENTINEL)
              }

              // Caption sidecar (mirrors the legacy path below).
              try {
                const bundle = getCaptionBundle()
                if (bundle) {
                  const base = filePath.replace(/\.mp4$/i, '')
                  const encoder = new TextEncoder()
                  await electronAPI.writeFile({ filePath: `${base}.srt`, bytes: encoder.encode(bundle.srt) })
                  await electronAPI.writeFile({ filePath: `${base}.vtt`, bytes: encoder.encode(bundle.vtt) })
                  pushDiag(`captions: wrote ${bundle.cues.length} cues (.srt + .vtt)`)
                }
              } catch (capErr) {
                pushDiag(`captions: skipped (${String(capErr)})`)
              }

              set({
                exportProgress: {
                  phase: 'complete',
                  currentScene: scenes.length,
                  totalScenes: scenes.length,
                  sceneProgress: 100,
                  downloadUrl: null,
                  filePath,
                  error: null,
                  warning: exportWarning(),
                  diagnostics: [...diagnostics],
                },
                lastExportStatus: 'success',
              })
              notifyExportDone(filePath)
              return
            }
          }

          // PIXEL-UNIFY (P1b): the all-legacy pixi path — the second pixel
          // path. Reached three ways, each named honestly: engine==='legacy' (the
          // explicit escape hatch), a video/avatar scene with no composite timeline
          // that couldn't take the mixed split (legacyReason, set above — the IPC IS
          // present here), or exportTier3 IPC genuinely missing. Emit WHY so a
          // preview≠export divergence is never silent and never mislabeled.
          pushDiag(
            engine === 'legacy'
              ? 'pixel-path: NOT unified — engine=legacy forced → pixi (preview may differ)'
              : legacyReason === 'incompatible-scene'
                ? 'pixel-path: NOT unified — video/avatar scene + no composite timeline (not mixable) → pixi fallback (preview may differ)'
                : 'pixel-path: NOT unified — exportTier3 IPC unavailable → pixi fallback (preview may differ)',
          )
          const { exportSolidSceneMp4 } = await import('../export2/pixi-mp4')
          const { resolution, fps } = settings
          const dims = resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, resolution)

          const partPaths: string[] = []
          for (let idx = 0; idx < scenes.length; idx++) {
            bailIfCancelled() // cancel between scenes
            const scene = scenes[idx]
            const partPath = `${filePath}.scene-${String(idx + 1).padStart(3, '0')}.mp4`
            partPaths.push(partPath)
            pushDiag(`render: scene ${idx + 1}/${scenes.length}`)

            // Fetch full scene from DB — in-memory fields may be empty
            // (localStorage partialize strips svgContent, sceneCode, etc.)
            let fullScene = scene
            try {
              const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
              if (sceneIpc) {
                const fullData = await sceneIpc.get({ projectId: get().project.id, sceneId: scene.id })
                if (fullData?.scene) fullScene = { ...scene, ...(fullData.scene as Partial<typeof scene>) }
              }
            } catch (e) {
              // Non-fatal: fall back to in-memory scene; record a
              // breadcrumb in the export diagnostics.
              pushDiag(`scene ${idx + 1}: DB hydrate failed (${String(e)}); using in-memory scene`)
            }
            const freshHTML = generateSceneHTML(
              fullScene,
              get().globalStyle,
              undefined,
              get().audioSettings,
              resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, get().project.mp4Settings?.resolution),
            )

            const bytes = await exportSolidSceneMp4({
              sceneId: fullScene.id,
              width: dims.width,
              height: dims.height,
              fps,
              // Avatar/veo scenes grow to fit their generated clip — the
              // pixi exporter clamps each video's localT to its real length,
              // so the extension renders as continued speech, then a hold.
              durationSeconds: reconcileForExport(fullScene, idx),
              sceneType: fullScene.sceneType,
              svgContent: fullScene.svgContent,
              sceneHTML: freshHTML,
              bgColor: scene.bgColor || '#000000',
              videoSrc: scene.videoLayer?.enabled ? scene.videoLayer.src : null,
              videoOpacity: scene.videoLayer?.opacity ?? 1,
              trimStart: scene.videoLayer?.trimStart ?? 0,
              trimEnd: scene.videoLayer?.trimEnd ?? null,
              textOverlays: scene.textOverlays as any,
              svgObjects: scene.svgObjects as any,
              aiLayers: scene.aiLayers as any,
              layerHiddenIds: scene.layerHiddenIds ?? [],
              layerPanelOrder: scene.layerPanelOrder ?? [],
              cameraMotion: scene.cameraMotion as any,
              audioSrc: scene.audioLayer?.enabled ? scene.audioLayer.src : null,
              audioStartOffset: scene.audioLayer?.startOffset ?? 0,
              audioVolume: scene.audioLayer?.volume ?? 1,
              audioFadeIn: scene.audioLayer?.fadeIn ?? false,
              audioFadeOut: scene.audioLayer?.fadeOut ?? false,
              audioLayer: scene.audioLayer as any,
              sceneAudioMix: resolveSceneAudioMix(
                fullScene,
                get().project?.timeline?.tracks ?? [],
                get().project?.audioSettings?.masterVolume,
              ),
              profile: settings.profile ?? 'quality',
              onProgress: (ratio) => {
                set({
                  exportProgress: {
                    phase: 'rendering',
                    currentScene: idx + 1,
                    totalScenes: scenes.length,
                    sceneProgress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
                    downloadUrl: null,
                    error: null,
                    diagnostics: [...diagnostics],
                  },
                })
              },
              onLog: (message) => pushDiag(`s${idx + 1}: ${message}`),
            }).catch((sceneErr) => {
              throw tagSceneError(sceneErr, idx, fullScene) // 11b
            })

            // Deliberately NOT wrapped in tagSceneError: a writeFile failure of
            // scene N's part is scene-scoped and the slot fallback attributes it
            // correctly (currentScene/sceneProgress advanced during the render
            // above) — wrapping would change nothing (review #151).
            await (window as any).electronAPI.writeFile({ filePath: partPath, bytes })
            trackArtifact(partPath) // COMMIT 3: clean up on cancel/error
            pushDiag(`render: scene ${idx + 1} written`)
          }

          // Last chance to cancel before finalize/concat — after this a
          // torn MP4 could result, so the Cancel button is gated off in the UI.
          bailIfCancelled()
          set({
            exportProgress: {
              phase: 'stitching', // reuse UI phase slot for "writing file"
              currentScene: scenes.length,
              totalScenes: scenes.length,
              sceneProgress: 100,
              downloadUrl: null,
              error: null,
              diagnostics: [...diagnostics],
            },
          })

          pushDiag(`concat: ${partPaths.length} scene files`)
          const transitions = scenes.slice(0, -1).map((s) => ({ type: s.transition, duration: 0.5 }))
          transitions.forEach((tr, i) => {
            pushDiag(`transition ${i + 1}: ${tr.type} (${tr.duration}s)`)
          })
          // Program loudness normalization, applied once to the final video
          // (post-stitch, engine-agnostic). Shared selection policy with Tier-3.
          const { targetLufs: progTarget, conflict: normConflict } = resolveProgramNormalizeTarget(
            scenes.map((s) => ({ audioProcessing: s.audioLayer?.audioProcessing })),
          )
          const normalizeTargetLufs = progTarget ?? undefined
          if (normConflict) pushDiag(`normalize: scenes disagree on LUFS — using ${normalizeTargetLufs}`)
          else if (normalizeTargetLufs != null) pushDiag(`normalize: ${normalizeTargetLufs} LUFS`)
          const legacyConcat = await (window as any).electronAPI.concatMp4({
            inputs: partPaths,
            output: filePath,
            transitions,
            cleanup: true,
            normalizeTargetLufs,
            // Standalone timeline audio rides the final concat (between
            // stitch and loudnorm) — the all-legacy path previously dropped it.
            timelineAudio: exportTimelineAudio,
            masterVolume: exportMasterVolume,
          })
          pushDiag('concat: done')
          noteProgramAudio(legacyConcat.programAudio)

          // Caption sidecar: stitch per-scene word timings into a project-
          // level SRT + VTT and drop them next to the MP4. Skipped when
          // the project is on an NLE timeline (scene-order duration
          // accumulation would misalign tracks).
          try {
            const bundle = getCaptionBundle()
            if (bundle) {
              const base = filePath.replace(/\.mp4$/i, '')
              const encoder = new TextEncoder()
              await (window as any).electronAPI.writeFile({
                filePath: `${base}.srt`,
                bytes: encoder.encode(bundle.srt),
              })
              await (window as any).electronAPI.writeFile({
                filePath: `${base}.vtt`,
                bytes: encoder.encode(bundle.vtt),
              })
              pushDiag(`captions: wrote ${bundle.cues.length} cues (.srt + .vtt)`)
              if (settings.burnCaptions && burnGatedByXfade) {
                pushDiag('captions: burn-in skipped — scene transitions present (would double re-encode)')
                captionWarning = BURN_GATED_WARNING
              } else if (settings.burnCaptions) {
                pushDiag(`captions: burning ${bundle.cues.length} cues into video`)
                const r = await (window as any).electronAPI.exportBurnCaptions({
                  filePath,
                  srt: bundle.srt,
                  width: dims.width,
                  height: dims.height,
                  totalSeconds: totalCaptionSeconds(),
                  fps: settings.fps,
                })
                pushDiag(
                  r.ok ? 'captions: burn-in done' : 'captions: burn-in FAILED — exported without burned captions',
                )
                if (!r.ok) captionWarning = BURN_FAILED_WARNING
              }
            } else if (settings.burnCaptions) {
              pushDiag('captions: burn-in requested but no caption cues exist — skipped')
            }
          } catch (capErr) {
            pushDiag(`captions: skipped (${String(capErr)})`)
          }

          set({
            exportProgress: {
              phase: 'complete',
              currentScene: scenes.length,
              totalScenes: scenes.length,
              sceneProgress: 100,
              // Keep downloadUrl null (Electron save path is already chosen)
              downloadUrl: null,
              filePath,
              error: null,
              warning: exportWarning(),
              diagnostics: [...diagnostics],
            },
            lastExportStatus: 'success',
          })
          notifyExportDone(filePath)
        } catch (err) {
          // COMMIT 3: any non-success exit (cancel OR error) may have left
          // partial `.scene-NNN.mp4` parts (and, in tier3, the output) on disk.
          // Best-effort delete them — main enforces strict containment. Idempotent
          // with the tier3 discard above (re-deleting an already-removed file is a
          // no-op). Runs in the catch, NOT finally, so a successful export keeps
          // its files. The cancelled/error progress slot already stands.
          if (writtenArtifacts.size > 0) {
            const { deleted } = await cleanupArtifacts()
            pushDiag(
              `export: cleaned up ${deleted.length} artifact(s) after ${err instanceof Error && err.message === CANCEL_SENTINEL ? 'cancel' : 'error'}`,
            )
          }
          // A user cancel unwinds via the sentinel — the 'cancelled' slot +
          // status were already set by bailIfCancelled(). Swallow it (don't
          // record error, don't rethrow as a failure) so the UI shows cancelled,
          // not an error, and headless callers don't see a rejection.
          if (err instanceof Error && err.message === CANCEL_SENTINEL) {
            return
          }
          // Fail loud. We STILL record phase='error'
          // on the shared slot so the in-app export modal (ExportPanel) can
          // render its error state — but we ALSO rethrow so headless callers
          // (the MCP exportRunner in src/electron/main.ts, the export_request
          // handler in AgentChat.tsx) see a rejected promise instead of a
          // resolved one and can mark the job/export failed. Previously this
          // swallowed the error and returned, so callers reported success with
          // a path to a file that was never written. ExportPanel's call site
          // catches this rejection (it reads the outcome from the store slot).
          // 11b: name the failing scene. Primary source: the explicit
          // tagSceneError stamp from the per-scene render wrap (exact even
          // when the throw happens before any frame renders). Fallback: the
          // pre-error progress slot's currentScene — covers the tier3 batch
          // path, whose per-scene errors arrive through one IPC call. Later-
          // phase failures (stitching / mixing_audio) stay untagged rather
          // than mislabeling the last-rendered scene.
          const stamped = err as Error & { exportSceneIndex?: number; exportSceneId?: string; exportSceneName?: string }
          const preError = get().exportProgress
          // The slot must have ACTUALLY ADVANCED past the run-start literal
          // ({currentScene: 1, sceneProgress: 0}) before we trust it — the
          // tier3 batch disk preflight throws before any scene renders, and
          // blaming "scene 1" for a disk-full error would send the agent off
          // to regenerate a perfectly fine scene (review #151). A genuine
          // scene-1 failure on the batch path before its first progress event
          // goes honestly UNTAGGED instead; the per-scene paths are covered
          // by the explicit stamp regardless of slot state.
          const slotIndex =
            preError?.phase === 'rendering' && ((preError.currentScene ?? 0) > 1 || (preError.sceneProgress ?? 0) > 0)
              ? preError.currentScene
              : null
          const failingIndex = stamped.exportSceneIndex ?? slotIndex
          const failingScene = stamped.exportSceneId
            ? { id: stamped.exportSceneId, name: stamped.exportSceneName ?? null }
            : failingIndex != null
              ? scenes[failingIndex - 1]
              : undefined
          const sceneTag =
            failingIndex != null
              ? `scene ${failingIndex}/${scenes.length}${failingScene?.name ? ` ("${failingScene.name}")` : ''}: `
              : ''
          const taggedMessage = `${sceneTag}${err instanceof Error ? err.message : String(err)}`
          set({
            exportProgress: {
              phase: 'error',
              currentScene: 0,
              totalScenes: scenes.length,
              sceneProgress: 0,
              downloadUrl: null,
              error: taggedMessage,
              errorSceneIndex: failingIndex ?? null,
              errorSceneId: failingScene?.id ?? null,
              diagnostics: [...diagnostics],
            },
            lastExportStatus: 'error',
          })
          throw new Error(taggedMessage, { cause: err })
        } finally {
          // Clear the in-flight + cancel-request flags. The 'cancelled' progress
          // slot persists for the UI; only the request latch is reset.
          set({ isExporting: false, exportCancelRequested: false })
        }
        return
      }

      // Reaching here means the desktop runtime is missing — every supported
      // shell injects window.electronAPI. Surface an explicit error instead of
      // silently failing on a vanished /api/export HTTP fallback. Record the
      // error state for the UI modal AND throw so headless callers fail loud
      // rather than resolving as if the export succeeded.
      const noRuntimeError = 'Export requires the desktop runtime (window.electronAPI unavailable).'
      set({
        isExporting: false,
        exportProgress: {
          phase: 'error',
          currentScene: 0,
          totalScenes: scenes.length,
          sceneProgress: 0,
          downloadUrl: null,
          error: noRuntimeError,
        },
        lastExportStatus: 'error',
      })
      throw new Error(noRuntimeError)
    },

    /**
     * Request cancellation of the in-flight WebCodecs export. Only mutates
     * a flag — exportVideo's loop observes it at the next scene/finalize boundary
     * and transitions to phase 'cancelled'. No-op when nothing is exporting.
     */
    cancelExport: () => {
      if (!get().isExporting) return
      set({ exportCancelRequested: true })
    },

    setExportProgress: (progress: ExportProgress | null) => set({ exportProgress: progress }),
  }
}
