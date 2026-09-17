import type { APIName, Scene } from '@/lib/types'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { ok, err, findScene, updateScene, type ToolResult } from './_shared'
import { emitAgentAction, emitterDepsForWorld as emitterDeps } from './action-emitter'
import { synthesizeTTS, searchSFX, searchMusic, generateMusic } from '@/lib/services/audio'
import { audioModel } from '@/lib/audio/audio-models'
import { resolveAudioProcessing, mergeAudioProcessing } from '@/lib/audio/audio-processing'
import { createLogger } from '@/lib/logger'
import { plannedDurationFor, PLAN_OVERRUN_FACTOR } from '@/lib/agents/scene-duration'

const log = createLogger('agent.audio-tools')
import type { AudioProcessing, MusicTrack, MusicProvider, SFXTrack } from '@/lib/types/audio'

/**
 * Attach a music track to a scene's audio layer — the single chokepoint shared by
 * add_background_music, generate_music, and compose_music. It honors a
 * ducking intent set via set_audio_mix BEFORE music existed (a pre-set
 * audioProcessing.ducking wins over the tool default), clamps volume to [0,1],
 * merges into the audio layer, updates the scene, and emits audio/setLayer so undo
 * works through the action layer. Returns the built track for the result message.
 */
function attachMusicTrack(
  world: WorldStateMutable,
  scene: Scene,
  input: {
    name: string
    provider: MusicProvider
    src: string
    volume: number
    loop: boolean
    duckDuringTTS: boolean
  },
): MusicTrack {
  const sceneId = scene.id
  const preDuck = scene.audioLayer?.audioProcessing?.ducking
  const safeVolume = Math.max(0, Math.min(1, Number.isFinite(input.volume) ? input.volume : 0.12))
  const musicTrack: MusicTrack = {
    name: input.name,
    provider: input.provider,
    src: input.src,
    volume: safeVolume,
    loop: input.loop,
    duckDuringTTS: typeof preDuck?.enabled === 'boolean' ? preDuck.enabled : input.duckDuringTTS,
    duckLevel:
      preDuck?.duckLevel != null ? resolveAudioProcessing(scene.audioLayer?.audioProcessing).ducking.duckLevel : 0.2,
  }
  const audioLayer = scene.audioLayer || {
    enabled: false,
    src: null,
    volume: 1,
    fadeIn: false,
    fadeOut: false,
    startOffset: 0,
  }
  const nextLayer = { ...audioLayer, enabled: true, music: musicTrack }
  updateScene(world, sceneId, { audioLayer: nextLayer })
  emitAgentAction(
    { type: 'audio/setLayer', params: { sceneId, patch: nextLayer, prior: audioLayer } },
    emitterDeps(world),
  )
  return musicTrack
}

/**
 * Append an SFX clip to a scene's audio layer — the chokepoint shared by
 * add_sound_effect (library search) and synthesize_sfx (native ZzFX synthesis).
 * Merges into audioLayer.sfx, updates the scene, and emits audio/setLayer for undo.
 */
function attachSfxClip(world: WorldStateMutable, scene: Scene, clip: SFXTrack): SFXTrack {
  const audioLayer = scene.audioLayer || {
    enabled: false,
    src: null,
    volume: 1,
    fadeIn: false,
    fadeOut: false,
    startOffset: 0,
  }
  const existingSfx = audioLayer.sfx ?? []
  const nextLayer = { ...audioLayer, enabled: true, sfx: [...existingSfx, clip] }
  updateScene(world, scene.id, { audioLayer: nextLayer })
  emitAgentAction(
    { type: 'audio/setLayer', params: { sceneId: scene.id, patch: nextLayer, prior: audioLayer } },
    emitterDeps(world),
  )
  return clip
}

/**
 * P1b-fanout-audio: emit `audio/setLayer` after each successful mutation
 * so the action_log captures the diff and undo works through the action
 * layer. Each call uses the existing patched `audioLayer` as both the
 * patch and the prior payload — the reducer merges by key.
 */

export const AUDIO_TOOL_NAMES = [
  'add_narration',
  'add_music',
  'add_sfx',
  'set_audio_mix',
  'dub_video',
  'clone_voice',
] as const

export function createAudioToolHandler(deps: {
  checkApiPermission: (
    world: WorldStateMutable,
    api: APIName,
    context?: {
      reason?: string
      details?: {
        prompt?: string
        duration?: number
        model?: string
        resolution?: string
        textLength?: number
      }
    },
  ) => ToolResult | null | Promise<ToolResult | null>
  enrichPermission: (
    result: ToolResult,
    context: {
      generationType: import('@/lib/types').GenerationType
      prompt?: string
      provider?: string
      availableProviders?: import('@/lib/types').GenerationProviderOption[]
      config?: Record<string, any>
      toolArgs?: Record<string, any>
    },
  ) => ToolResult
}) {
  return async function handleAudioTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
  ): Promise<ToolResult> {
    // Merged tools route to an internal op via a discriminator arg (add_music/add_sfx);
    // the rich per-provider case bodies below are unchanged.
    let op = toolName
    if (toolName === 'add_music') {
      const s = (args as { source?: string }).source
      op = s === 'generate' ? 'generate_music' : s === 'compose' ? 'compose_music' : 'add_background_music'
    } else if (toolName === 'add_sfx') {
      op = (args as { source?: string }).source === 'synthesize' ? 'synthesize_sfx' : 'add_sound_effect'
    }
    switch (op) {
      case 'add_narration': {
        const { sceneId, voiceId, provider, instructions } = args as Record<string, any>
        let text = (args as Record<string, any>).text as string
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        // Cap narration to the scene's PLANNED time budget. add_narration grows a
        // scene to fit its voiceover through a separate, UNCLAMPED path (scene-duration.ts),
        // so over-long VO silently doubled every scene (a 71s plan built to 144s). Trim
        // the text at the source: ~2.5 words/sec × planned, with the same 1.3 tolerance
        // as clampSceneDuration. No active plan (single-scene / chat edit) → no cap.
        const plannedSec = plannedDurationFor(world, sceneId)
        if (plannedSec && typeof text === 'string') {
          const maxWords = Math.ceil(plannedSec * 2.5 * PLAN_OVERRUN_FACTOR)
          const words = text.trim().split(/\s+/)
          if (words.length > maxWords) {
            const clipped = words.slice(0, maxWords).join(' ')
            // Trim back to the last COMPLETE sentence so VO doesn't end mid-phrase
            // ("...and that's why the—"). Fall back to the word-cut only if the clip
            // has no sentence break past its midpoint (else we'd throw away most of it).
            const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '))
            text = lastStop > clipped.length * 0.5 ? clipped.slice(0, lastStop + 1) : clipped
            log.info(`add_narration: capped VO to plan budget (${words.length}→~${maxWords} words, scene ${sceneId})`)
          }
        }

        const ttsApiMap: Record<string, APIName | null> = {
          elevenlabs: 'elevenLabs',
          'openai-tts': 'openaiTts',
          'gemini-tts': 'geminiTts',
          'google-tts': 'googleTts',
        }
        const isProviderEnabled = (id: string) =>
          !world.audioProviderEnabled || (world.audioProviderEnabled[id] ?? true)
        const explicitProvider = provider && provider !== 'auto' ? provider : null
        if (explicitProvider && !isProviderEnabled(explicitProvider)) {
          return err(`TTS provider "${explicitProvider}" is disabled in audio settings`)
        }
        // Delegate to the scorer-backed resolver. It reads the per-project
        // enabled map, localMode, platform, and env vars, and returns the
        // single best provider for this call — replacing the old inline
        // cascade. Explicit user picks still short-circuit.
        const { resolveTTSForNarration } = await import('@/lib/audio/resolve-best-tts-provider')
        // Narration that's meant to land in an exported MP4 must come from a
        // SERVER provider — client-only voices (web-speech / puter) play in the
        // browser preview but write no audio file, so the export is silent. We
        // require server output by default so the scorer prefers a real,
        // exportable provider whenever one is configured. (Edge-TTS-Local
        // counts as server output, so localMode still gets a free real file.)
        const resolved = explicitProvider
          ? { provider: explicitProvider as any, reason: `user-picked (${explicitProvider})`, ranking: [] }
          : resolveTTSForNarration({
              settings: world.audioSettings,
              localMode: world.localMode,
              audioProviderEnabled: world.audioProviderEnabled,
              textLength: typeof text === 'string' ? text.length : undefined,
              requiresServerOutput: true,
            })
        // No server TTS provider is configured (the scorer drops all
        // client-only voices under requiresServerOutput, leaving nothing).
        //
        // FAIL HONESTLY (not ok() with a warning): with no tts layer written the
        // agent would read `success: true` and report the video as narrated. The
        // model is told the two ways to actually get audio.
        // Skip in sandbox, which forces native-tts (a real local file) below.
        if (!world.sandboxMode && !explicitProvider && resolved.provider === null) {
          return err(
            'No TTS provider can produce an exportable voiceover — nothing was added to the scene. ' +
              'Add an ElevenLabs (or OpenAI, Gemini, or Google Cloud) TTS API key in Settings, or start a ' +
              'local TTS server. To narrate the browser preview ONLY (the exported MP4 stays SILENT), ' +
              'call add_narration again with provider="web-speech".',
          )
        }
        // Sandbox forces the free local system voice, so skip the paid-provider gate.
        const effectiveProvider = world.sandboxMode ? 'native-tts' : resolved.provider
        if (!world.sandboxMode && effectiveProvider && ttsApiMap[effectiveProvider]) {
          const ttsProviderOptions: import('@/lib/types').GenerationProviderOption[] = [
            { id: 'elevenlabs', name: 'ElevenLabs', cost: '~$0.01–0.10', isFree: false },
            { id: 'openai-tts', name: 'OpenAI TTS', cost: '~$0.015–0.03/1K chars', isFree: false },
            { id: 'gemini-tts', name: 'Gemini TTS', cost: '~$0.01–0.02/1K chars', isFree: false },
            { id: 'google-tts', name: 'Google Cloud TTS', cost: '~$0.004/100 chars', isFree: false },
            { id: 'openai-edge-tts', name: 'Edge TTS (Local)', cost: 'Free', isFree: true },
            { id: 'web-speech', name: 'Web Speech', cost: 'Free', isFree: true },
            { id: 'puter', name: 'Puter TTS', cost: 'Free', isFree: true },
          ].filter((p) => isProviderEnabled(p.id))
          const blocked = await deps.checkApiPermission(world, ttsApiMap[effectiveProvider]!, {
            reason: 'Generate narration audio',
            details: {
              prompt: text as string,
              model: effectiveProvider,
              textLength: typeof text === 'string' ? text.length : undefined,
            },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'tts',
              prompt: text as string,
              provider: effectiveProvider,
              availableProviders: ttsProviderOptions,
              config: { voiceId, instructions },
              toolArgs: args as Record<string, any>,
            })
        }

        try {
          // Re-check abort immediately before the (paid) TTS provider call. The
          // choke-point gate covers pre-dispatch; a Stop after dispatch must still skip the bill.
          // Skip in sandbox (native-tts is free + local).
          if (!world.sandboxMode) {
            const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
            if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — narration not started')
          }
          const data = await synthesizeTTS({
            text,
            sceneId,
            voiceId,
            provider: effectiveProvider ?? undefined,
            instructions,
            localMode: world.localMode,
          })

          if ('mode' in data) {
            const audioLayer = scene.audioLayer || {
              enabled: false,
              src: null,
              volume: 1,
              fadeIn: false,
              fadeOut: false,
              startOffset: 0,
            }
            const nextLayer = {
              ...audioLayer,
              enabled: true,
              tts: {
                text,
                provider: data.provider,
                voiceId: voiceId || null,
                src: null,
                status: 'ready' as const,
                duration: null,
                instructions: instructions || null,
              },
            }
            updateScene(world, sceneId, { audioLayer: nextLayer })
            emitAgentAction(
              { type: 'audio/setLayer', params: { sceneId, patch: nextLayer, prior: audioLayer } },
              emitterDeps(world),
            )
            // Client-only TTS (web-speech / puter) plays in the browser
            // preview but writes no audio file. MP4 exports of this scene
            // will be silent. Reached only when the user explicitly picked a
            // client-only provider (the auto path now requires server output).
            // Surface a prominent warning so it isn't a silent failure.
            return ok(
              sceneId,
              `WARNING: Narration set up for browser preview only (${data.provider}) — the exported MP4 will be SILENT for this scene because this provider writes no audio file. Add a server TTS API key (ElevenLabs, OpenAI, Gemini, or Google Cloud TTS) to generate a real, exportable voiceover.`,
              { audioUrl: null, clientOnly: true, exportSilent: true, provider: data.provider },
            )
          }

          // After the `'mode' in data` branch returns, TypeScript narrows
          // `data` to the server-audio variant for the rest of this case.
          const audioLayer = scene.audioLayer || {
            enabled: false,
            src: null,
            volume: 1,
            fadeIn: false,
            fadeOut: false,
            startOffset: 0,
          }
          const captions =
            data.captions && data.captions.srtUrl && data.captions.vttUrl
              ? {
                  srtUrl: data.captions.srtUrl as string,
                  vttUrl: data.captions.vttUrl as string,
                  kind: (data.captions.kind === 'naive' ? 'naive' : 'aligned') as 'aligned' | 'naive',
                  words: Array.isArray(data.captions.words)
                    ? (data.captions.words as Array<{ text: string; start: number; end: number }>)
                    : [],
                }
              : null
          const nextLayer = {
            ...audioLayer,
            enabled: true,
            src: data.url,
            tts: {
              text,
              provider: data.provider,
              voiceId: voiceId || null,
              src: data.url,
              status: 'ready' as const,
              duration: data.duration || null,
              instructions: instructions || null,
              captions,
            },
          }
          updateScene(world, sceneId, { audioLayer: nextLayer })
          emitAgentAction(
            { type: 'audio/setLayer', params: { sceneId, patch: nextLayer, prior: audioLayer } },
            emitterDeps(world),
          )
          // Grow the scene to FIT the narration so the VO isn't clipped on export.
          // The scene duration is the export length (reconcile-scene-duration); an
          // untrimmed VO longer than the scene is cut at the scene boundary. We only
          // ever GROW (never shrink — the agent's chosen duration stands when the VO
          // is shorter) and add a ~0.4s tail so the last word isn't clipped.
          const voDur = typeof data.duration === 'number' && data.duration > 0 ? data.duration : null
          const priorDur = scene.duration
          let grewTo: number | null = null
          if (voDur != null && priorDur < voDur + 0.3) {
            grewTo = Math.round((voDur + 0.4) * 10) / 10
            updateScene(world, sceneId, { duration: grewTo })
            emitAgentAction(
              { type: 'scene/update', params: { sceneId, patch: { duration: grewTo } } },
              emitterDeps(world),
            )
          }
          // Commit spend so the in-run/session/monthly cap accumulates for agent narration
          // (mirrors generateNarrationGated on the IPC path). Bill under the SAME paid apiName this
          // call resolved + gated on (elevenLabs / openaiTts / geminiTts / googleTts) — never a cheaper
          // one. Free providers (sandbox native-tts, web-speech/puter, edge-tts) have no apiName here →
          // no spend. Match the gate's details (prompt + model + textLength) so gated == committed.
          const narrationApiName = effectiveProvider ? ttsApiMap[effectiveProvider] : null
          if (narrationApiName && world.projectId) {
            try {
              const { logSpend } = await import('@/lib/db')
              const { estimateApiCostUsd } = await import('@/lib/permissions')
              const cost = estimateApiCostUsd(narrationApiName, {
                prompt: text as string,
                model: effectiveProvider,
                textLength: typeof text === 'string' ? text.length : undefined,
              })
              if (cost > 0 && Number.isFinite(cost)) {
                await logSpend(
                  world.projectId,
                  narrationApiName,
                  cost,
                  `${effectiveProvider}: ${String(text).slice(0, 80)}`,
                )
              }
            } catch {
              /* spend logging is best-effort; the audio is already generated */
            }
          } else if (narrationApiName) {
            log.warn(`add_narration: paid narration generated via ${effectiveProvider} but not metered (no projectId)`)
          }
          const captionSuffix = captions ? ', captions generated' : ''
          const grewSuffix = grewTo != null ? `; scene grown to ${grewTo}s to fit the narration` : ''
          return ok(
            sceneId,
            `Narration generated (${data.provider})${data.duration ? `, ${data.duration.toFixed(1)}s` : ''}${captionSuffix}${grewSuffix}`,
            {
              audioUrl: data.url,
              sceneDuration: grewTo ?? priorDur,
              ...(captions ? { captionsUrl: captions.vttUrl } : {}),
            },
          )
        } catch (e: any) {
          // A configured LOCAL TTS server (pocket-tts / voxcpm / edge-tts-local)
          // was chosen but is unreachable — almost always because it isn't
          // running (a fast connection-refused, not a real synthesis error).
          // The scorer treats a configured-but-dead local server as available
          // (it can't ping from a pure/client-safe resolver), so this is where
          // we recover. Don't hard-fail the scene with an opaque "Narration
          // failed" the model can't act on and leave it silent: fall back to a
          // browser voice so the PREVIEW still narrates, and tell the user
          // honestly that the export will be silent + exactly how to fix it.
          const LOCAL_SERVER_TTS = new Set(['pocket-tts', 'voxcpm', 'openai-edge-tts'])
          const localServerDown = !!effectiveProvider && LOCAL_SERVER_TTS.has(effectiveProvider) && !world.sandboxMode

          // Prefer a REAL, EXPORTABLE local voice (System Voice) over web-speech
          // (browser-only → SILENT export). On macOS/Windows `native-tts` writes a
          // real mp3, so a down pocket-tts/voxcpm/edge server degrades to an
          // exportable voiceover + a "start your server" nudge — never a silent
          // scene, and safe to hard-pin pocket-tts as the default.
          if (localServerDown && (process.platform === 'darwin' || process.platform === 'win32')) {
            try {
              const nd = await synthesizeTTS({
                text,
                sceneId,
                voiceId,
                provider: 'native-tts',
                instructions,
                localMode: world.localMode,
              })
              if (!('mode' in nd) && nd.url) {
                const priorLayer = scene.audioLayer || {
                  enabled: false,
                  src: null,
                  volume: 1,
                  fadeIn: false,
                  fadeOut: false,
                  startOffset: 0,
                }
                const voDur = typeof nd.duration === 'number' && nd.duration > 0 ? nd.duration : null
                let grewTo: number | null = null
                if (voDur != null && scene.duration < voDur + 0.3) {
                  grewTo = Math.round((voDur + 0.4) * 10) / 10
                  updateScene(world, sceneId, { duration: grewTo })
                  emitAgentAction(
                    { type: 'scene/update', params: { sceneId, patch: { duration: grewTo } } },
                    emitterDeps(world),
                  )
                }
                const nextLayer = {
                  ...priorLayer,
                  enabled: true,
                  src: nd.url,
                  tts: {
                    text,
                    provider: 'native-tts' as import('@/lib/types').TTSProvider,
                    voiceId: voiceId || null,
                    src: nd.url,
                    status: 'ready' as const,
                    duration: nd.duration ?? null,
                    instructions: instructions || null,
                  },
                }
                updateScene(world, sceneId, { audioLayer: nextLayer })
                emitAgentAction(
                  { type: 'audio/setLayer', params: { sceneId, patch: nextLayer, prior: priorLayer } },
                  emitterDeps(world),
                )
                return ok(
                  sceneId,
                  `NOTE: the local ${effectiveProvider} TTS server was unreachable (${e.message}) — used the System Voice instead (real + exportable, but lower quality). Start your ${effectiveProvider} server (or set its URL in Settings) for the intended voice.`,
                  {
                    audioUrl: nd.url,
                    sceneDuration: grewTo ?? scene.duration,
                    provider: 'native-tts',
                    localServerUnreachable: effectiveProvider,
                  },
                )
              }
            } catch {
              /* System Voice also failed — fall through to the web-speech preview path */
            }
          }

          if (localServerDown && isProviderEnabled('web-speech')) {
            const priorLayer = scene.audioLayer || {
              enabled: false,
              src: null,
              volume: 1,
              fadeIn: false,
              fadeOut: false,
              startOffset: 0,
            }
            const fallbackLayer = {
              ...priorLayer,
              enabled: true,
              tts: {
                text,
                provider: 'web-speech' as import('@/lib/types').TTSProvider,
                voiceId: voiceId || null,
                src: null,
                status: 'ready' as const,
                duration: null,
                instructions: instructions || null,
              },
            }
            updateScene(world, sceneId, { audioLayer: fallbackLayer })
            emitAgentAction(
              { type: 'audio/setLayer', params: { sceneId, patch: fallbackLayer, prior: priorLayer } },
              emitterDeps(world),
            )
            return ok(
              sceneId,
              `WARNING: the local ${effectiveProvider} TTS server was unreachable (${e.message}). Narration will play in the browser preview via web-speech, but the exported MP4 will be SILENT for this scene. Start the local TTS server (or set its URL in Settings), or add a server TTS API key (ElevenLabs, OpenAI, Gemini, or Google Cloud) for a real, exportable voiceover.`,
              {
                audioUrl: null,
                clientOnly: true,
                exportSilent: true,
                provider: 'web-speech',
                localServerUnreachable: effectiveProvider,
              },
            )
          }
          return err(`Narration failed: ${e.message}`)
        }
      }

      case 'add_sound_effect': {
        const { sceneId, query, triggerAt = 0, volume = 0.8, provider } = args as Record<string, any>
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        // Validate + clamp BEFORE building the clip. The scene video is only
        // `duration` long and export (-shortest) drops any audio past the end,
        // so an SFX at triggerAt > duration was reported "added at 12s" but
        // never played. Clamp it into the scene and report the clamp honestly;
        // also guard against NaN/negative inputs.
        const sceneDur = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : null
        const rawTrigger = Number.isFinite(triggerAt) ? Math.max(0, triggerAt) : 0
        const safeTrigger = sceneDur != null ? Math.min(rawTrigger, Math.max(0, sceneDur - 0.05)) : rawTrigger
        const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 0.8

        const sfxApiMap: Record<string, APIName | null> = {
          'elevenlabs-sfx': 'elevenLabs',
          freesound: 'freesound',
          pixabay: 'pixabay',
        }
        const isSfxEnabled = (id: string) => !world.audioProviderEnabled || (world.audioProviderEnabled[id] ?? true)
        const explicitSfxProvider = provider && provider !== 'auto' ? provider : null
        if (explicitSfxProvider && !isSfxEnabled(explicitSfxProvider)) {
          return err(`SFX provider "${explicitSfxProvider}" is disabled in audio settings`)
        }
        let effectiveSfxProvider =
          explicitSfxProvider ??
          (() => {
            if (process.env.ELEVENLABS_API_KEY && isSfxEnabled('elevenlabs-sfx')) return 'elevenlabs-sfx'
            if (process.env.FREESOUND_API_KEY && isSfxEnabled('freesound')) return 'freesound'
            if (process.env.PIXABAY_API_KEY && isSfxEnabled('pixabay')) return 'pixabay'
            return null
          })()
        // Sandbox: the only PAID/generative SFX provider (elevenlabs-sfx) must never
        // run — demote to a free library provider, else the local bundled library
        // ($0) via the null path below. Mirrors how add_narration forces native-tts,
        // so a $0 run never fail-closes on the SFX gate.
        if (world.sandboxMode && effectiveSfxProvider === 'elevenlabs-sfx') {
          effectiveSfxProvider =
            process.env.FREESOUND_API_KEY && isSfxEnabled('freesound')
              ? 'freesound'
              : process.env.PIXABAY_API_KEY && isSfxEnabled('pixabay')
                ? 'pixabay'
                : null
        }

        // Local bundled library: $0, offline. Used when explicitly requested ('local')
        // OR as the FREE fallback when no remote SFX provider is configured — so the agent
        // can pull a real bundled sound instead of failing or paying.
        if (explicitSfxProvider === 'local' || effectiveSfxProvider === null) {
          const { loadLocalSfxManifest } = await import('@/lib/audio/load-local-sfx-manifest')
          const { searchLocalSfx } = await import('@/lib/audio/sfx-local-manifest')
          const matches = searchLocalSfx(loadLocalSfxManifest(), String(query), 1)
          if (matches.length > 0) {
            const m = matches[0]
            const newSfx = attachSfxClip(world, scene, {
              id: `sfx-${Date.now()}`,
              name: m.name,
              provider: 'local',
              src: m.audioUrl,
              triggerAt: safeTrigger,
              volume: safeVolume,
              duration: m.duration,
            })
            const clampNote =
              sceneDur != null && rawTrigger > safeTrigger
                ? ` (clamped from ${rawTrigger}s to fit the ${sceneDur}s scene)`
                : ''
            return ok(sceneId, `Added bundled sound "${m.name}" at ${safeTrigger}s${clampNote} — $0, local library`, {
              sfx: newSfx,
            })
          }
          if (explicitSfxProvider === 'local') {
            return err(
              `No bundled sound matched "${query}". Try synthesize_sfx for a generated effect, or a different query.`,
            )
          }
          if (effectiveSfxProvider === null) {
            return err(
              `No SFX provider configured and no bundled sound matched "${query}". Use synthesize_sfx for a free ` +
                `generated effect, or add a Freesound/Pixabay/ElevenLabs key for library/AI search.`,
            )
          }
        }

        if (effectiveSfxProvider && sfxApiMap[effectiveSfxProvider]) {
          const blocked = await deps.checkApiPermission(world, sfxApiMap[effectiveSfxProvider]!, {
            reason: 'Generate/search sound effect',
            details: { prompt: query as string, model: effectiveSfxProvider },
          })
          if (blocked) return blocked
        }

        try {
          // Re-check abort before the provider call (elevenlabs-sfx GENERATES = paid).
          if (!world.sandboxMode) {
            const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
            if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — sound effect not started')
          }
          const data = await searchSFX({
            query,
            prompt: query,
            provider: effectiveSfxProvider ?? undefined,
            limit: 1,
            download: true,
          })
          if (!data.results || data.results.length === 0) return err(`No sound effects found for: ${query}`)

          const sfxResult = data.results[0] as Record<string, any>
          const newSfx = attachSfxClip(world, scene, {
            id: `sfx-${Date.now()}`,
            name: sfxResult.name || query,
            provider: sfxResult.provider || data.provider,
            src: sfxResult.audioUrl,
            triggerAt: safeTrigger,
            volume: safeVolume,
            duration: sfxResult.duration || null,
          })
          // Commit spend so the in-run/session/monthly cap accumulates for agent SFX
          // (mirrors generateSfxGated on the IPC path). Bill under the SAME apiName this call gated
          // on (sfxApiMap: elevenlabs-sfx → elevenLabs is the only GENERATIVE/paid provider; freesound
          // & pixabay are $0 searches → estimateApiCostUsd returns 0 → the cost>0 guard skips them).
          const sfxApiName = effectiveSfxProvider ? sfxApiMap[effectiveSfxProvider] : null
          if (sfxApiName && world.projectId) {
            try {
              const { logSpend } = await import('@/lib/db')
              const { estimateApiCostUsd } = await import('@/lib/permissions')
              const cost = estimateApiCostUsd(sfxApiName, {
                prompt: query as string,
                model: effectiveSfxProvider,
              })
              if (cost > 0 && Number.isFinite(cost)) {
                await logSpend(
                  world.projectId,
                  sfxApiName,
                  cost,
                  `${effectiveSfxProvider}: ${String(query).slice(0, 80)}`,
                )
              }
            } catch {
              /* spend logging is best-effort; the SFX is already generated */
            }
          } else if (sfxApiName && effectiveSfxProvider === 'elevenlabs-sfx') {
            log.warn('add_sound_effect: paid SFX generated but not metered (no projectId)')
          }
          const clampNote =
            sceneDur != null && rawTrigger > safeTrigger
              ? ` (clamped from ${rawTrigger}s to fit the ${sceneDur}s scene)`
              : ''
          return ok(sceneId, `Sound effect "${sfxResult.name}" added at ${safeTrigger}s${clampNote}`, { sfx: newSfx })
        } catch (e: any) {
          return err(`SFX failed: ${e.message}`)
        }
      }

      case 'add_background_music': {
        const {
          sceneId,
          query,
          volume = 0.12,
          loop = true,
          duckDuringTTS = true,
          provider,
        } = args as Record<string, any>
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        const musicApiMap: Record<string, APIName | null> = {
          'pixabay-music': 'pixabay',
          'freesound-music': 'freesound',
        }
        const isMusicEnabled = (id: string) => !world.audioProviderEnabled || (world.audioProviderEnabled[id] ?? true)
        const explicitMusicProvider = provider && provider !== 'auto' ? provider : null
        if (explicitMusicProvider && !isMusicEnabled(explicitMusicProvider)) {
          return err(`Music provider "${explicitMusicProvider}" is disabled in audio settings`)
        }
        const effectiveMusicProvider =
          explicitMusicProvider ??
          (() => {
            if (process.env.PIXABAY_API_KEY && isMusicEnabled('pixabay-music')) return 'pixabay-music'
            if (process.env.FREESOUND_API_KEY && isMusicEnabled('freesound-music')) return 'freesound-music'
            return null
          })()
        if (effectiveMusicProvider && musicApiMap[effectiveMusicProvider]) {
          const blocked = await deps.checkApiPermission(world, musicApiMap[effectiveMusicProvider]!, {
            reason: 'Generate/search background music',
            details: { prompt: query as string, model: effectiveMusicProvider },
          })
          if (blocked) return blocked
        }

        try {
          const data = await searchMusic({
            query,
            provider: effectiveMusicProvider ?? undefined,
            limit: 1,
            download: true,
          })
          if (!data.results || data.results.length === 0) return err(`No music found for: ${query}`)

          const musicResult = data.results[0] as Record<string, any>
          const musicTrack = attachMusicTrack(world, scene, {
            name: musicResult.name || query,
            provider: musicResult.provider || data.provider,
            src: musicResult.audioUrl,
            volume,
            loop,
            duckDuringTTS,
          })
          return ok(
            sceneId,
            `Background music "${musicResult.name}" added (vol: ${(musicTrack.volume * 100).toFixed(0)}%, duck: ${musicTrack.duckDuringTTS})`,
            { music: musicTrack },
          )
        } catch (e: any) {
          return err(`Music failed: ${e.message}`)
        }
      }

      case 'generate_music': {
        const {
          sceneId,
          prompt,
          provider,
          duration,
          volume = 0.12,
          loop = true,
          duckDuringTTS = true,
        } = args as Record<string, any>
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)
        if (!prompt || !String(prompt).trim()) {
          return err('A music prompt is required — describe the music to generate.')
        }

        // Generative providers only (their `search` throws). Library search → add_background_music.
        const GENERATIVE: Record<string, string> = {
          musicgen: 'MUSICGEN_URL',
          'elevenlabs-music': 'ELEVENLABS_API_KEY',
          lyria: 'GOOGLE_AI_KEY',
          'stable-audio': 'FAL_KEY',
        }
        const isMusicEnabled = (id: string) => !world.audioProviderEnabled || (world.audioProviderEnabled[id] ?? true)
        const explicit = provider && provider !== 'auto' ? String(provider) : null
        if (explicit && !(explicit in GENERATIVE)) {
          return err(
            `"${explicit}" is not a generative music provider. Use add_background_music for library search ` +
              `(pixabay-music / freesound-music), or choose elevenlabs-music / lyria / stable-audio.`,
          )
        }
        if (explicit && !isMusicEnabled(explicit))
          return err(`Music provider "${explicit}" is disabled in audio settings`)
        if (explicit && !process.env[GENERATIVE[explicit]]) {
          return err(`Music provider "${explicit}" needs ${GENERATIVE[explicit]} configured.`)
        }
        // auto: prefer the local $0 MusicGen sidecar, then the clean-licensed cloud
        // providers (ElevenLabs Music), then Stable Audio.
        let effective =
          explicit ??
          (() => {
            if (process.env.MUSICGEN_URL && isMusicEnabled('musicgen')) return 'musicgen'
            if (process.env.ELEVENLABS_API_KEY && isMusicEnabled('elevenlabs-music')) return 'elevenlabs-music'
            if (process.env.FAL_KEY && isMusicEnabled('stable-audio')) return 'stable-audio'
            // Lyria last in the auto-chain: its REST transport is unverified (see
            // src/lib/audio/providers/lyria.ts), so only auto-pick it when no verified generative
            // provider is configured. It stays explicitly selectable.
            if (process.env.GOOGLE_AI_KEY && isMusicEnabled('lyria')) return 'lyria'
            return null
          })()
        // Sandbox: only the local $0 MusicGen sidecar may run — never a paid cloud
        // provider. Demote to the local sidecar if available, else redirect to
        // compose_music (instant local template music, $0) so the run never fail-closes.
        if (world.sandboxMode && effective && effective !== 'musicgen') {
          effective = process.env.MUSICGEN_URL && isMusicEnabled('musicgen') ? 'musicgen' : null
          if (!effective) {
            return err(
              'Sandbox: paid music generation is disabled. Use compose_music for instant local template music ($0), ' +
                'or start the local MusicGen sidecar (npm run music-sidecar:start).',
            )
          }
        }
        if (!effective) {
          return err(
            'No generative music provider configured. Start the local MusicGen sidecar (npm run music-sidecar:start, ' +
              '$0) or add ELEVENLABS_API_KEY / GOOGLE_AI_KEY / FAL_KEY. Or use compose_music for instant template music.',
          )
        }

        const apiName = audioModel(effective)?.apiName ?? null
        if (apiName) {
          const blocked = await deps.checkApiPermission(world, apiName, {
            reason: 'Generate background music',
            details: {
              prompt: String(prompt),
              model: effective,
              duration: typeof duration === 'number' ? duration : undefined,
            },
          })
          // Paid path: enrich the denial so the in-app always-ask card can render + re-dispatch
          // (mirrors add_narration; add_background_music returns raw because it's a free search).
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'music',
              prompt: String(prompt),
              provider: effective,
            })
        }

        try {
          // Idempotency: request-hash dedupe (mirrors the video path's start-cache).
          // Music is the one agent media tool that COMMITS spend (logSpend below), so a retry of
          // an identical prompt would re-bill. Key the cache on (provider, prompt, duration) — the
          // only inputs that change the clip — and serve a prior clip (if its file still exists) with
          // NO provider call and NO logSpend. On a miss we generate, then alias the produced clip
          // under the hash so the NEXT identical call is free. Stored once; never deleted on rollback.
          const { computeCacheHash } = await import('@/lib/apis/cache-hash')
          const musicRequestHash = computeCacheHash({
            kind: 'agentMusicGen',
            provider: effective,
            prompt: String(prompt),
            duration: typeof duration === 'number' ? duration : null,
          })
          let result: Record<string, any> | undefined
          let servedFromCache = false
          if (world.projectId) {
            try {
              const { getCachedMedia } = await import('@/lib/db')
              const { resolvePublicMediaPath } = await import('@/lib/media-paths')
              const cached = await getCachedMedia(musicRequestHash).catch(() => null)
              if (cached?.filePath) {
                const abs = resolvePublicMediaPath(cached.filePath)
                const fsmod = await import('node:fs/promises')
                const exists = abs
                  ? await fsmod.access(abs).then(
                      () => true,
                      () => false,
                    )
                  : false
                if (exists) {
                  result = { audioUrl: cached.filePath, name: String(prompt).slice(0, 80), provider: effective }
                  servedFromCache = true
                }
              }
            } catch {
              /* cache lookup is best-effort — fall through to generate on any failure */
            }
          }

          if (!result) {
            // Don't START a paid generation for a run the user already stopped — the
            // choke-point gate (tool-executor) covers pre-dispatch, this re-checks immediately
            // before the provider bills (mirrors generateLayerContent's in-handler guard).
            const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
            if (getWorldAbortSignal(world)?.aborted) {
              return err('Run aborted by user — music generation not started')
            }
            const data = await generateMusic({
              prompt: String(prompt),
              provider: effective as Parameters<typeof generateMusic>[0]['provider'],
              duration: typeof duration === 'number' ? duration : undefined,
            })
            result = data.result as Record<string, any> | undefined
            if (!result?.audioUrl) return err(`No music generated for: ${prompt}`)
            // Alias the produced clip under the request hash so an identical retry dedupes.
            // Best-effort: a cache-write failure must not lose the already-paid clip.
            if (world.projectId) {
              try {
                const { setCachedMedia } = await import('@/lib/db')
                await setCachedMedia(
                  musicRequestHash,
                  apiName ?? effective,
                  result.audioUrl,
                  String(prompt).slice(0, 200),
                  effective,
                  '{}',
                ).catch(() => {})
              } catch {
                /* alias is best-effort */
              }
            }
          }
          if (!result?.audioUrl) return err(`No music generated for: ${prompt}`)

          // Commit spend so the session/monthly cap actually accumulates for agent music gen
          // (mirrors generateMusicGated on the IPC path). Best-effort: a logging failure must not
          // lose the already-generated (paid) clip. NOTE: add_sound_effect/add_background_music do
          // not yet commit — retrofitting them is a separate follow-up. A cache HIT did not bill the
          // provider, so it must NOT log spend again (that would be the double-spend we just prevented).
          if (apiName && world.projectId && !servedFromCache) {
            try {
              const { logSpend } = await import('@/lib/db')
              const { estimateApiCostUsd } = await import('@/lib/permissions')
              // Use the SAME details as the gate so gated cost == committed cost, and guard
              // against a 0/Infinity estimate poisoning the ledger (mirrors audio-gen.ts commitSpend).
              const cost = estimateApiCostUsd(apiName, {
                prompt: String(prompt),
                model: effective,
                duration: typeof duration === 'number' ? duration : undefined,
              })
              if (cost > 0 && Number.isFinite(cost)) {
                await logSpend(world.projectId, apiName, cost, `${effective}: ${String(prompt).slice(0, 80)}`)
              }
            } catch {
              /* spend logging is best-effort; the clip is already generated */
            }
          } else if (apiName) {
            // Paid generation with no projectId (some MCP/subagent contexts) → not metered. Make
            // it auditable rather than a silent unbilled spend.
            log.warn(`generate_music: paid music generated via ${effective} but not metered (no projectId)`)
          }

          const musicTrack = attachMusicTrack(world, scene, {
            name: result.name || String(prompt).slice(0, 80),
            provider: result.provider || effective,
            src: result.audioUrl,
            volume: typeof volume === 'number' ? volume : 0.12,
            loop,
            duckDuringTTS,
          })
          return ok(
            sceneId,
            `Generated background music with ${result.provider || effective}: "${musicTrack.name}" ` +
              `(vol ${(musicTrack.volume * 100).toFixed(0)}%, duck ${musicTrack.duckDuringTTS})`,
            { music: musicTrack },
          )
        } catch (e: any) {
          return err(`Music generation failed: ${e.message}`)
        }
      }

      // Native music composer: the agent composes ORIGINAL background music ITSELF,
      // fully local, $0, no external provider, no API key. It picks + parameterizes a
      // hand-authored arrangement template; a pure-JS sample sequencer (spessasynth_core
      // + the bundled GeneralUser GS soundfont) renders it to a WAV offline. NO spend
      // gate and NO logSpend — being free is the whole point.
      case 'compose_music': {
        const {
          sceneId,
          templateId = 'lofi',
          key,
          tempo,
          intensity,
          duration,
          melody = 'template',
          groove = 'template',
          instrument,
          texture,
          // 0.6, NOT a 0.18 bed level: the composed stem masters to ~-16 LUFS, so a
          // music-ONLY export (no opt-in loudnorm) lands ~-20 LUFS (present content),
          // while duckDuringTTS still pulls it to a proper bed under narration (T1b).
          volume = 0.6,
          loop = true,
          duckDuringTTS = true,
        } = args as Record<string, any>
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)

        // Target length: explicit arg → scene duration → 8s default.
        const sceneDurationSec =
          typeof duration === 'number' && duration > 0
            ? duration
            : typeof scene.duration === 'number' && scene.duration > 0
              ? scene.duration
              : 8

        try {
          // CPU-bound render. Re-check abort right before spending CPU (mirrors the paid
          // tools' pre-provider guard). The 25s race bounds the ASYNC parts (soundfont I/O,
          // synth init); the sync mix loop is bounded by the arrange-layer spec caps
          // (MAX_BARS etc.), which is the real protection against a runaway render (D3).
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — music composition not started')

          const { composeMusicToFile, resolveSoundfontPath, COMPOSER_VERSION, compose } =
            await import('@/lib/audio/composer')
          if (!resolveSoundfontPath()) {
            return err(
              'Native music needs the bundled soundfont. Install it once with: node scripts/assets/fetch-soundfont.mjs',
            )
          }

          // Either ML path (melody or groove) makes the render STOCHASTIC → no cache.
          const isStochastic = melody === 'ml' || groove === 'ml'
          const params = {
            templateId: String(templateId),
            key: key != null ? String(key) : undefined,
            tempo: typeof tempo === 'number' ? tempo : undefined,
            intensity: typeof intensity === 'number' ? intensity : undefined,
            sceneDurationSec,
            melody: (melody === 'ml' ? 'ml' : 'template') as 'ml' | 'template',
            groove: (groove === 'ml' ? 'ml' : 'template') as 'ml' | 'template',
            instrument: typeof instrument === 'string' && instrument.trim() ? instrument.trim() : undefined,
            texture: (['full', 'minimal', 'solo'].includes(texture) ? texture : undefined) as
              | 'full'
              | 'minimal'
              | 'solo'
              | undefined,
          }

          const { computeCacheHash } = await import('@/lib/apis/cache-hash')
          const { getAudioDir, audioUrlFor } = await import('@/lib/audio/paths')
          const { join } = await import('node:path')
          const fsmod = await import('node:fs/promises')
          const renderTimeout = () =>
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('compose timed out after 25s')), 25_000))

          let meta: ReturnType<typeof compose>['meta']
          let corrections: string[]
          let melodySource: 'template' | 'ml' = melody === 'ml' ? 'ml' : 'template'
          let grooveSource: 'template' | 'ml' = groove === 'ml' ? 'ml' : 'template'
          let publicUrl: string

          if (isStochastic) {
            // ML melody/groove is STOCHASTIC → never cache: a unique filename per take
            // (nonce in the salt). Each generation is its own file; no stale-serving risk.
            const uniq = computeCacheHash({
              kind: 'composeMusicMl',
              ...params,
              v: COMPOSER_VERSION,
              nonce: `${Date.now()}-${world.currentRunId ?? ''}`,
            })
            const absPath = join(getAudioDir(), `composed-ml-${uniq}.wav`)
            publicUrl = audioUrlFor(`composed-ml-${uniq}.wav`)
            const res = await Promise.race([composeMusicToFile(params, { absPath, publicUrl }), renderTimeout()])
            meta = res.meta
            corrections = res.corrections
            melodySource = res.melodySource
            grooveSource = res.grooveSource
          } else {
            // Deterministic dedupe: identical spec → identical file, salted on the
            // engine+soundfont version so a bump never serves a stale render.
            const hash = computeCacheHash({ kind: 'composeMusic', ...params, v: COMPOSER_VERSION })
            const absPath = join(getAudioDir(), `composed-${hash}.wav`)
            publicUrl = audioUrlFor(`composed-${hash}.wav`)
            const cached = await fsmod.access(absPath).then(
              () => true,
              () => false,
            )
            if (cached) {
              const c = compose(params)
              meta = c.meta
              corrections = c.corrections
            } else {
              const res = await Promise.race([composeMusicToFile(params, { absPath, publicUrl }), renderTimeout()])
              meta = res.meta
              corrections = res.corrections
              melodySource = res.melodySource
            }
          }

          const mlNote = (melodySource === 'ml' ? ', ML melody' : '') + (grooveSource === 'ml' ? ', ML groove' : '')
          const musicTrack = attachMusicTrack(world, scene, {
            name: `${meta.templateId} (${meta.key}, ${meta.tempo}bpm${mlNote})`,
            provider: 'native-sequencer',
            src: publicUrl,
            volume: typeof volume === 'number' ? volume : 0.6,
            loop,
            duckDuringTTS,
          })

          const fixNote = corrections.length ? ` — adjusted: ${corrections.join('; ')}` : ''
          return ok(
            sceneId,
            `Composed ${meta.templateId} music (${meta.key}, ${meta.tempo}bpm, ${meta.bars} bars, ` +
              `${meta.sections.join('→')}${mlNote}) — $0, no provider${fixNote}`,
            { music: musicTrack, corrections, meta, melodySource, grooveSource },
          )
        } catch (e: any) {
          return err(`Music composition failed: ${e.message}`)
        }
      }

      // Native SFX synth: the agent SYNTHESIZES a sound effect ITSELF via ZzFX, fully
      // local, $0, no external provider/key. It picks an archetype (laser/explosion/
      // coin/jump/hit/click…) and tunes pitch/duration/variation; the sound is rendered
      // to a WAV and attached to the scene. The SFX twin of compose_music. NO spend gate.
      case 'synthesize_sfx': {
        const {
          sceneId,
          archetype,
          layers,
          generate,
          nature,
          material,
          intensity,
          pitch,
          duration,
          variation,
          triggerAt = 0,
          volume = 0.8,
        } = args as Record<string, any>
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene not found: ${sceneId}`)
        // Five modes, in priority order: nature (noise-based ambience) > modal
        // (struck-object impact) > generate (jsfxr generative) > layers (ZzFX
        // compound) > archetype (ZzFX preset).
        const natureCategory = typeof nature === 'string' && nature.trim() ? nature.trim() : null
        const modalMaterial = typeof material === 'string' && material.trim() ? material.trim() : null
        const genCategory = typeof generate === 'string' && generate.trim() ? generate.trim() : null
        const layerList = Array.isArray(layers) && layers.length > 0 ? layers : null
        if (
          !natureCategory &&
          !modalMaterial &&
          !genCategory &&
          !layerList &&
          (!archetype || !String(archetype).trim())
        ) {
          return err(
            'Provide "nature" (ambience: wind/rain/fire/ocean/…), "material" (struck impact: ' +
              'metal/wood/glass/ceramic/membrane), "generate" (a fresh jsfxr sound: explosion/laser/coin/…), ' +
              '"layers" (stack of archetypes), or "archetype" (an exact ZzFX preset, e.g. "laser").',
          )
        }

        // Clamp triggerAt into the scene (export -shortest drops anything past the end)
        // and clamp volume — mirrors add_sound_effect.
        const sceneDur = typeof scene.duration === 'number' && scene.duration > 0 ? scene.duration : null
        const rawTrigger = Number.isFinite(triggerAt) ? Math.max(0, triggerAt) : 0
        const safeTrigger = sceneDur != null ? Math.min(rawTrigger, Math.max(0, sceneDur - 0.05)) : rawTrigger
        const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 0.8

        try {
          // CPU work is tiny (a few ms) but re-check abort for consistency with the other tools.
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — SFX synthesis not started')

          const {
            synthesizeSfxToFile,
            synthesizeLayeredSfxToFile,
            generateSfxrToFile,
            synthesizeNatureToFile,
            synthesizeModalToFile,
            SFX_ARCHETYPE_NAMES,
            SFXR_CATEGORY_NAMES,
            NATURE_CATEGORIES,
            MODAL_MATERIALS,
            SFX_SYNTH_VERSION,
          } = await import('@/lib/audio/sfx')

          // Build the cache key + a human label from whichever mode is active.
          const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
          const genVariation = num(variation) ?? 0
          // In nature mode `duration` is SECONDS (natural ambiences are timed, 1-30s),
          // not the 0.25-4 multiplier the ZzFX modes use.
          const natureSpec = { durationSec: num(duration) ?? 4, intensity: num(intensity) ?? 0.6, seed: genVariation }
          // Modal reuses the shared knobs: pitch → size, duration → decay length,
          // intensity → brightness (harder strike), variation → per-strike jitter.
          const modalSpec = {
            pitch: num(pitch),
            decay: num(duration),
            brightness: num(intensity),
            variation: num(variation),
          }
          const spec = natureCategory
            ? { nature: natureCategory, ...natureSpec }
            : modalMaterial
              ? { material: modalMaterial, ...modalSpec }
              : genCategory
                ? { generate: genCategory, variation: genVariation }
                : layerList
                  ? {
                      layers: layerList.map((l: any) => ({
                        archetype: String(l.archetype),
                        pitch: num(l.pitch),
                        duration: num(l.duration),
                        variation: num(l.variation),
                        volume: num(l.volume),
                        offsetMs: num(l.offsetMs),
                      })),
                    }
                  : {
                      archetype: String(archetype),
                      pitch: num(pitch),
                      duration: num(duration),
                      variation: num(variation),
                    }
          const label = natureCategory
            ? `${natureCategory} (ambience)`
            : modalMaterial
              ? `${modalMaterial} (impact)`
              : genCategory
                ? `${genCategory} (generated)`
                : layerList
                  ? layerList.map((l: any) => String(l.archetype)).join('+')
                  : String(archetype)

          // Deterministic dedupe: identical spec → identical file (salted on synth version).
          const { computeCacheHash } = await import('@/lib/apis/cache-hash')
          const hash = computeCacheHash({ kind: 'synthSfx', ...spec, v: SFX_SYNTH_VERSION })
          const fileName = `sfx-${hash}.wav`
          const { getAudioDir, audioUrlFor } = await import('@/lib/audio/paths')
          const { join } = await import('node:path')
          const absPath = join(getAudioDir(), fileName)
          const publicUrl = audioUrlFor(fileName)

          const fsmod = await import('node:fs/promises')
          const cached = await fsmod.access(absPath).then(
            () => true,
            () => false,
          )
          let result = cached ? { durationSec: null as number | null, resolvedId: label } : null
          if (!cached) {
            const r = natureCategory
              ? await synthesizeNatureToFile(natureCategory, natureSpec, absPath)
              : modalMaterial
                ? await synthesizeModalToFile(modalMaterial, modalSpec, absPath)
                : genCategory
                  ? await generateSfxrToFile(genCategory, genVariation, absPath)
                  : layerList
                    ? await synthesizeLayeredSfxToFile((spec as any).layers, absPath)
                    : await synthesizeSfxToFile(spec as any, absPath)
            if (!r) {
              const kind = natureCategory
                ? 'nature category'
                : modalMaterial
                  ? 'material'
                  : genCategory
                    ? 'category'
                    : 'archetype'
              const valid = natureCategory
                ? NATURE_CATEGORIES.join(', ')
                : modalMaterial
                  ? MODAL_MATERIALS.join(', ')
                  : genCategory
                    ? SFXR_CATEGORY_NAMES.join(', ')
                    : SFX_ARCHETYPE_NAMES.slice(0, 24).join(', ') + '…'
              return err(`Unknown SFX ${kind} in "${label}". Try one of: ${valid}`)
            }
            result = r
          }

          const newSfx = attachSfxClip(world, scene, {
            id: `sfx-${Date.now()}`,
            name: label,
            provider: natureCategory || modalMaterial || genCategory ? 'local' : 'zzfx',
            src: publicUrl,
            triggerAt: safeTrigger,
            volume: safeVolume,
            duration: result?.durationSec ?? null,
          })
          const clampNote =
            sceneDur != null && rawTrigger > safeTrigger
              ? ` (clamped from ${rawTrigger}s to fit the ${sceneDur}s scene)`
              : ''
          return ok(sceneId, `Synthesized SFX "${newSfx.name}" at ${safeTrigger}s${clampNote} — $0, no provider`, {
            sfx: newSfx,
          })
        } catch (e: any) {
          return err(`SFX synthesis failed: ${e.message}`)
        }
      }

      case 'set_audio_mix': {
        const a = args as Record<string, any>
        const sceneId = a.sceneId as string
        const scene = findScene(world, sceneId)
        if (!scene) return err(`Scene ${sceneId} not found`)

        // Always persist the patch, even when the scene has no audio yet —
        // attachMusicTrack honors "a ducking intent set via set_audio_mix BEFORE
        // music existed". Only the wording changes.
        const audioLayer = scene.audioLayer ?? {
          enabled: false,
          src: null,
          volume: 1,
          fadeIn: false,
          fadeOut: false,
          startOffset: 0,
        }
        const hasAudio =
          !!audioLayer.tts?.src || (audioLayer.sfx?.length ?? 0) > 0 || !!audioLayer.music?.src || !!audioLayer.src

        // Build a partial patch from only the provided fields (partial-update).
        const patch: AudioProcessing = {}
        if (typeof a.masterGain === 'number') patch.masterGain = a.masterGain
        if (typeof a.ttsGain === 'number') patch.ttsGain = a.ttsGain
        if (typeof a.musicGain === 'number') patch.musicGain = a.musicGain
        if (typeof a.sfxGain === 'number') patch.sfxGain = a.sfxGain
        if (a.normalize && typeof a.normalize === 'object') {
          patch.normalize = {
            enabled: a.normalize.enabled === true,
            ...(typeof a.normalize.targetLufs === 'number' ? { targetLufs: a.normalize.targetLufs } : {}),
          }
        }
        if (a.ducking && typeof a.ducking === 'object') {
          patch.ducking = {
            ...(typeof a.ducking.enabled === 'boolean' ? { enabled: a.ducking.enabled } : {}),
            ...(typeof a.ducking.duckLevel === 'number' ? { duckLevel: a.ducking.duckLevel } : {}),
            ...(typeof a.ducking.attackMs === 'number' ? { attackMs: a.ducking.attackMs } : {}),
            ...(typeof a.ducking.releaseMs === 'number' ? { releaseMs: a.ducking.releaseMs } : {}),
            ...(typeof a.ducking.ratio === 'number' ? { ratio: a.ducking.ratio } : {}),
          }
        }

        const merged = mergeAudioProcessing(audioLayer.audioProcessing, patch)
        const resolved = resolveAudioProcessing(merged) // clamp/validate for the summary

        // Mirror the ducking gate to the legacy MusicTrack fields so BOTH export
        // mixers (which gate on music.duckDuringTTS) honor enable/disable + level.
        let nextMusic = audioLayer.music
        if (nextMusic && a.ducking && typeof a.ducking === 'object') {
          nextMusic = {
            ...nextMusic,
            ...(typeof a.ducking.enabled === 'boolean' ? { duckDuringTTS: a.ducking.enabled } : {}),
            ...(typeof a.ducking.duckLevel === 'number' ? { duckLevel: resolved.ducking.duckLevel } : {}),
          }
        }

        const nextLayer = { ...audioLayer, audioProcessing: merged, music: nextMusic }
        updateScene(world, sceneId, { audioLayer: nextLayer })
        emitAgentAction(
          { type: 'audio/setLayer', params: { sceneId, patch: nextLayer, prior: audioLayer } },
          emitterDeps(world),
        )

        const notes: string[] = [
          `master ${resolved.masterGain}×`,
          `tts ${resolved.ttsGain}× music ${resolved.musicGain}× sfx ${resolved.sfxGain}×`,
        ]
        if (resolved.normalize.enabled)
          notes.push(`normalize ${resolved.normalize.targetLufs} LUFS (applied at export)`)
        if (nextMusic?.duckDuringTTS)
          notes.push(
            `duck→${resolved.ducking.duckLevel} (${resolved.ducking.attackMs}/${resolved.ducking.releaseMs}ms)`,
          )
        return ok(
          sceneId,
          hasAudio
            ? `Audio mix set: ${notes.join(', ')}.`
            : `Audio mix stored (${notes.join(', ')}) — the scene has no audio yet, so it applies to narration / music / SFX you add next.`,
          { applied: hasAudio, stored: true, resolved },
        )
      }

      // Tier 3: dub a source video into another language — transcribe → translate → TTS (preset or a
      // cloned voice) → relip the source video, with segment-level sync. The heavy pipeline runs in the
      // dub runtime (ffmpeg + Whisper, main-side); this handler gates the paid steps (TTS + relip) and
      // delegates. voiceId (an existing cloned voice) dubs in the original speaker's voice.
      case 'dub_video': {
        const { sourceVideoUrl, targetLanguage, sourceLanguage, voiceId, provider } = args as Record<string, any>
        if (!sourceVideoUrl || !targetLanguage) {
          return err('dub_video requires sourceVideoUrl and targetLanguage')
        }
        const projectId = world.projectId
        if (!projectId) return err('projectId not available in world state')

        if (world.sandboxMode) {
          return ok(null, `Sandbox: dubbing into ${targetLanguage} skipped (no transcription/TTS/relip, $0).`, {
            sandbox: true,
          })
        }

        // Gate the two paid stages: TTS (elevenLabs) and the fal relip (falAvatar).
        const ttsBlocked = await deps.checkApiPermission(world, 'elevenLabs', {
          reason: `Dub video into ${targetLanguage} (translate + speak)`,
          details: { prompt: `dub → ${targetLanguage}`, model: 'voice-clone-dub' },
        })
        if (ttsBlocked)
          return deps.enrichPermission(ttsBlocked, {
            generationType: 'tts',
            prompt: `Dub into ${targetLanguage}`,
            toolArgs: args as Record<string, any>,
          })
        const relipBlocked = await deps.checkApiPermission(world, 'falAvatar', {
          reason: `Dub video into ${targetLanguage} (re-lip the source video)`,
          details: { prompt: `relip → ${targetLanguage}`, model: 'musetalk' },
        })
        if (relipBlocked)
          return deps.enrichPermission(relipBlocked, {
            generationType: 'avatar',
            prompt: `Dub into ${targetLanguage}`,
            toolArgs: args as Record<string, any>,
          })

        try {
          // Re-check abort before the paid dub pipeline (TTS + fal relip).
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — dubbing not started')
          const { runDubJob } = await import('@/lib/services/dub/run-dub')
          const result = await runDubJob({
            projectId,
            sourceVideoUrl: sourceVideoUrl as string,
            targetLanguage: targetLanguage as string,
            sourceLanguage: (sourceLanguage as string) || undefined,
            voiceId: (voiceId as string) || undefined,
            ttsProvider: (provider as string) || undefined,
          })
          const driftNote =
            result.driftMs > 750
              ? ` Note: ~${Math.round(result.driftMs / 100) / 10}s of timing drift (translation is verbose for the source pacing).`
              : ''
          return ok(
            null,
            `Dubbed into ${targetLanguage} (${result.segmentCount} segments${result.detectedLanguage ? `, from ${result.detectedLanguage}` : ''}).${driftNote}`,
            { videoUrl: result.videoUrl, segmentCount: result.segmentCount, driftMs: result.driftMs },
          )
        } catch (e: any) {
          return err(`Dubbing failed: ${e.message}`)
        }
      }

      // Tier 3 Cast: clone a voice from an audio sample into a reusable cloned voice. Biometric:
      // consent + trust guard + spend gate live in cloneVoiceGated. This handler maps the service's
      // three outcomes to in-chat cards: consentNeeded (biometric consent card), permissionNeeded
      // (spend card), or the created row (success). The agent pre-gates ElevenLabs spend here (like
      // the other paid tools) and passes skipPermissionGate so the service doesn't double-gate.
      case 'clone_voice': {
        const { name, audioUrl, provider } = args as Record<string, any>
        if (!name || !audioUrl) {
          return err('clone_voice requires a name and audioUrl (an uploaded voice sample to clone)')
        }
        const projectId = world.projectId
        if (!projectId) return err('projectId not available in world state')

        if (world.sandboxMode) {
          return ok(null, 'Sandbox: voice cloning skipped — no sample uploaded, no third-party call ($0).', {
            sandbox: true,
          })
        }

        const cloneProvider = (provider as string) || 'elevenlabs'
        // Pre-gate paid clone spend → surfaces the existing in-chat permission card. Local providers
        // (voxcpm/pocket-tts) are free and need no spend gate. Keyed on PAID_CLONE_PROVIDERS so a new
        // paid provider is gated automatically, not silently bypassed.
        const { PAID_CLONE_PROVIDERS } = await import('@/lib/audio/voice-clone-providers')
        if (PAID_CLONE_PROVIDERS.has(cloneProvider)) {
          const blocked = await deps.checkApiPermission(world, 'elevenLabs', {
            reason: 'Clone a voice (ElevenLabs)',
            details: { prompt: name as string, model: 'voice-clone' },
          })
          if (blocked)
            return deps.enrichPermission(blocked, {
              generationType: 'tts',
              prompt: name as string,
              provider: cloneProvider,
              toolArgs: args as Record<string, any>,
            })
        }

        try {
          // Re-check abort before the paid voice-clone provider call.
          const { getWorldAbortSignal } = await import('@/lib/agents/tool-executor')
          if (getWorldAbortSignal(world)?.aborted) return err('Run aborted by user — voice cloning not started')
          const { cloneVoiceGated } = await import('@/lib/services/voice-clone')
          const result = await cloneVoiceGated({
            projectId,
            name: name as string,
            sampleRef: audioUrl as string,
            provider: cloneProvider as import('@/lib/types').TTSProvider,
            skipPermissionGate: true, // pre-gated above
          })
          // Biometric consent missing → surface an in-chat consent card via the permission-pause
          // path (kind:'biometric_consent'), so it reuses the runner pause + resume machinery.
          // Nothing was sent (fail-closed). Approving records consent for (project,destination) and
          // resumes; the re-run finds the recorded consent and proceeds.
          if ('consentNeeded' in result) {
            const c = result.consentNeeded
            return {
              success: false,
              error: `Consent required before sending a voice sample to ${c.destination}.`,
              permissionNeeded: {
                api: 'elevenLabs',
                estimatedCost: '$0.00',
                kind: 'biometric_consent',
                reason: c.consentText,
                destination: c.destination,
                consentVersion: c.version,
                voiceName: c.voiceName,
                toolName: 'clone_voice',
                toolArgs: args as Record<string, any>,
              },
            }
          }
          // Spend ask slipped through (e.g. skipPermissionGate path changed) → surface the spend card.
          if ('permissionNeeded' in result) {
            return {
              success: false,
              error: 'Permission required to clone this voice.',
              permissionNeeded: result.permissionNeeded,
            }
          }
          return ok(null, `Cloned voice "${result.name}" is ready — bind it to a Cast member to narrate in it.`, {
            clonedVoiceId: result.id,
            voiceId: result.providerVoiceId,
            provider: result.provider,
          })
        } catch (e: any) {
          return err(`Voice cloning failed: ${e.message}`)
        }
      }

      default:
        return err(`Unknown audio tool: ${toolName}`)
    }
  }
}
