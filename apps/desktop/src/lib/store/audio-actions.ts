'use client'

import type { SFXTrack, MusicTrack, TTSProvider } from '../types'
import { normalizeAudioLayer } from '../audio/normalize'
import type { Set, Get } from './types'
import { resolveSpendGate, type PermissionNeededBlock } from './spend-gate'
import { createLogger } from '../logger'

const log = createLogger('store.audio')

export function createAudioActions(set: Set, get: Get) {
  return {
    updateAudioSettings: (updates: Partial<import('../types').AudioSettings>) =>
      set((s) => ({
        audioSettings: { ...s.audioSettings, ...updates },
      })),

    toggleAudioProvider: (id: string) =>
      set((s) => ({
        audioProviderEnabled: { ...s.audioProviderEnabled, [id]: !s.audioProviderEnabled[id] },
      })),

    toggleMediaGen: (id: string) =>
      set((s) => ({
        mediaGenEnabled: { ...s.mediaGenEnabled, [id]: !s.mediaGenEnabled[id] },
      })),

    setMediaUnderstandingEngine: (kind: string, engineId: string) =>
      set((s) => ({
        mediaUnderstandingEngines: { ...s.mediaUnderstandingEngines, [kind]: engineId },
      })),

    setWebSearchEnabled: (enabled: boolean) => set({ webSearchEnabled: enabled }),
    setAiQualityReview: (enabled: boolean) => set({ aiQualityReview: enabled }),
    setSubAgents: (enabled: boolean) => set({ subAgents: enabled }),
    setInlineDiffsEnabled: (enabled: boolean) => set({ inlineDiffsEnabled: enabled }),
    setWebFetchEnabled: (enabled: boolean) => set({ webFetchEnabled: enabled }),
    setAutoAcceptWebSearch: (enabled: boolean) => set({ autoAcceptWebSearch: enabled }),

    toggleResearchProvider: (id: string) =>
      set((s) => ({
        researchProviderEnabled: { ...s.researchProviderEnabled, [id]: !s.researchProviderEnabled[id] },
      })),

    grantYtDlpConsent: (projectId: string) =>
      set((s) => ({
        ytDlpConsentedProjectIds: s.ytDlpConsentedProjectIds.includes(projectId)
          ? s.ytDlpConsentedProjectIds
          : [...s.ytDlpConsentedProjectIds, projectId],
      })),

    revokeYtDlpConsent: (projectId: string) =>
      set((s) => ({
        ytDlpConsentedProjectIds: s.ytDlpConsentedProjectIds.filter((id) => id !== projectId),
      })),

    generateNarration: async (
      sceneId: string,
      text: string,
      provider?: string,
      voiceId?: string,
      instructions?: string,
    ) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return

      // Set generating status
      const audioLayer = normalizeAudioLayer(scene.audioLayer)
      get().updateScene(sceneId, {
        audioLayer: {
          ...audioLayer,
          enabled: true,
          tts: {
            text,
            provider: (provider || 'auto') as any,
            voiceId: voiceId || null,
            src: null,
            status: 'generating',
            duration: null,
            instructions: instructions || null,
          },
        },
      })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.tts : undefined
        const payload = {
          text,
          sceneId,
          projectId: get().project?.id,
          voiceId,
          provider: provider === 'auto' ? undefined : provider,
          instructions,
        }
        type TTSResponse = {
          mode?: 'client'
          url?: string
          duration?: number | null
          provider: TTSProvider
          captions?: unknown
          error?: string
          permissionNeeded?: PermissionNeededBlock
        }
        if (!ipc) throw new Error('TTS requires the desktop runtime (window.dreambyteApi.tts unavailable).')
        let data: TTSResponse = (await ipc.synthesize(payload)) as TTSResponse

        // Always-ask gate: pop the modal, then re-dispatch (approved) or cancel (denied). A hard
        // deny (cap/disabled) comes back as `error`, handled below without a prompt.
        if (data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            const cancelScene = get().scenes.find((s) => s.id === sceneId)
            if (cancelScene) {
              const cancelAL = normalizeAudioLayer(cancelScene.audioLayer)
              get().updateScene(sceneId, { audioLayer: { ...cancelAL, tts: { ...cancelAL.tts!, status: 'error' } } })
            }
            get().showTransientStatus?.('Narration cancelled.', 2400)
            return
          }
          data = (await ipc.synthesize({ ...payload, approvedAsk: true })) as TTSResponse
        }

        // Spend gate denied (cap exceeded / api disabled) → mark errored + surface, don't leave
        // the track 'generating' forever or set 'ready' with no audio.
        if (data.error) {
          const deniedScene = get().scenes.find((s) => s.id === sceneId)
          if (deniedScene) {
            const deniedAL = normalizeAudioLayer(deniedScene.audioLayer)
            get().updateScene(sceneId, {
              audioLayer: { ...deniedAL, tts: { ...deniedAL.tts!, status: 'error' } },
            })
          }
          get().showTransientStatus?.(data.error, 3200)
          return
        }

        const currentScene = get().scenes.find((s) => s.id === sceneId)
        if (!currentScene) return
        const currentAL = normalizeAudioLayer(currentScene.audioLayer)

        if (data.mode === 'client') {
          get().updateScene(sceneId, {
            audioLayer: {
              ...currentAL,
              enabled: true,
              tts: {
                text,
                provider: data.provider,
                voiceId: voiceId || null,
                src: null,
                status: 'ready',
                duration: null,
                instructions: instructions || null,
              },
            },
          })
        } else {
          get().updateScene(sceneId, {
            audioLayer: {
              ...currentAL,
              enabled: true,
              src: data.url ?? null,
              tts: {
                text,
                provider: data.provider,
                voiceId: voiceId || null,
                src: data.url ?? null,
                status: 'ready',
                duration: data.duration || null,
                instructions: instructions || null,
              },
            },
          })
        }

        await get().saveSceneHTML(sceneId)
      } catch (err) {
        const currentScene = get().scenes.find((s) => s.id === sceneId)
        if (!currentScene) return
        const currentAL = normalizeAudioLayer(currentScene.audioLayer)
        get().updateScene(sceneId, {
          audioLayer: {
            ...currentAL,
            tts: { ...currentAL.tts!, status: 'error' },
          },
        })
        log.error('narration generation failed', { error: err })
      }
    },

    addSFXToScene: (sceneId: string, sfx: SFXTrack) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const audioLayer = normalizeAudioLayer(scene.audioLayer)
      const existingSfx = audioLayer.sfx ?? []
      get().updateScene(sceneId, {
        audioLayer: { ...audioLayer, enabled: true, sfx: [...existingSfx, sfx] },
      })
      get().saveSceneHTML(sceneId)
    },

    removeSFXFromScene: (sceneId: string, sfxId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const audioLayer = normalizeAudioLayer(scene.audioLayer)
      get().updateScene(sceneId, {
        audioLayer: { ...audioLayer, sfx: (audioLayer.sfx ?? []).filter((s) => s.id !== sfxId) },
      })
      get().saveSceneHTML(sceneId)
    },

    setSceneMusic: (sceneId: string, music: MusicTrack | null) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const audioLayer = normalizeAudioLayer(scene.audioLayer)
      get().updateScene(sceneId, {
        audioLayer: { ...audioLayer, enabled: true, music },
      })
      get().saveSceneHTML(sceneId)
    },

    // Cinema Studio: prompt -> generated sound effect via the gated sfx.generate IPC,
    // attached to the scene's sfx[] track. SFXTrack has no 'status' field (unlike AILayer), so
    // progress is a transient status rather than a pending row; SFX gen is a few seconds.
    generateSfx: async (sceneId: string, opts: { prompt: string; provider?: string; duration?: number }) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene || !opts.prompt.trim()) return
      get().showTransientStatus?.('Generating sound effect…', 2400)
      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.sfx : undefined
        if (!ipc?.generate) throw new Error('SFX generation requires the desktop runtime.')
        const sfxArgs = {
          projectId: get().project?.id,
          prompt: opts.prompt,
          provider: opts.provider,
          duration: opts.duration,
        }
        type SfxResponse = { sfx?: Record<string, any>; error?: string; permissionNeeded?: PermissionNeededBlock }
        let data = (await ipc.generate(sfxArgs)) as SfxResponse
        if (data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            get().showTransientStatus?.('Sound effect cancelled.', 2400)
            return
          }
          data = (await ipc.generate({ ...sfxArgs, approvedAsk: true })) as SfxResponse
        }
        if (data.error || !data.sfx) {
          get().showTransientStatus?.(data.error ?? 'Sound effect generation failed', 3200)
          return
        }
        const r = data.sfx
        // A result without a usable audio URL would create a silently-broken (src-less) track.
        if (typeof r.audioUrl !== 'string' || !r.audioUrl) {
          get().showTransientStatus?.('Sound effect generation returned no audio', 3200)
          return
        }
        const newSfx: SFXTrack = {
          id: (r.id as string) || `sfx-${Date.now()}`,
          name: (r.name as string) || opts.prompt,
          provider: (r.provider as SFXTrack['provider']) || 'elevenlabs-sfx',
          src: r.audioUrl,
          triggerAt: 0,
          volume: 0.8,
          duration: (r.duration as number | null) ?? null,
        }
        get().addSFXToScene(sceneId, newSfx)
      } catch (err) {
        log.error('sfx generation failed', { error: err })
        const msg = err instanceof Error && err.message ? err.message.slice(0, 160) : 'Sound effect generation failed'
        get().showTransientStatus?.(msg, 3600)
      }
    },

    // Cinema Studio: prompt -> generated background music via the gated music.generate IPC
    // (fal Stable Audio), set as the scene's single music track (replaces any existing).
    generateMusic: async (sceneId: string, opts: { prompt: string; provider?: string; duration?: number }) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene || !opts.prompt.trim()) return
      get().showTransientStatus?.('Generating music…', 3000)
      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.music : undefined
        if (!ipc?.generate) throw new Error('Music generation requires the desktop runtime.')
        const musicArgs = {
          projectId: get().project?.id,
          prompt: opts.prompt,
          provider: opts.provider,
          duration: opts.duration,
          // Custom MusicGen sidecar URL (Settings) → applied to the env before routing.
          musicgenUrl: get().audioSettings?.musicgenUrl ?? undefined,
        }
        type MusicResponse = { music?: Record<string, any>; error?: string; permissionNeeded?: PermissionNeededBlock }
        let data = (await ipc.generate(musicArgs)) as MusicResponse
        if (data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            get().showTransientStatus?.('Music cancelled.', 2400)
            return
          }
          data = (await ipc.generate({ ...musicArgs, approvedAsk: true })) as MusicResponse
        }
        if (data.error || !data.music) {
          get().showTransientStatus?.(data.error ?? 'Music generation failed', 3200)
          return
        }
        const r = data.music
        // A result without a usable audio URL would create a silently-broken (src-less) track.
        if (typeof r.audioUrl !== 'string' || !r.audioUrl) {
          get().showTransientStatus?.('Music generation returned no audio', 3200)
          return
        }
        const track: MusicTrack = {
          name: (r.name as string) || opts.prompt,
          provider: (r.provider as MusicTrack['provider']) || 'stable-audio',
          src: r.audioUrl,
          volume: 0.12,
          loop: true,
          duckDuringTTS: true,
          duckLevel: 0.2,
        }
        get().setSceneMusic(sceneId, track)
      } catch (err) {
        // Surface the real cause (e.g. "FAL_KEY is not set") instead of a generic failure.
        log.error('music generation failed', { error: err })
        const msg = err instanceof Error && err.message ? err.message.slice(0, 160) : 'Music generation failed'
        get().showTransientStatus?.(msg, 3600)
      }
    },
  }
}
