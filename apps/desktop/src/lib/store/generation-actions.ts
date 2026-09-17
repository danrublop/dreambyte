'use client'

import { v4 as uuidv4 } from 'uuid'
import type { Scene, SceneUsage, SvgObject, SvgBranch, AILayer, AvatarLayer } from '../types'
import type { D3ChartLayer } from '../types/d3'
import { generateSceneHTML } from '../sceneTemplate'
import { resolveProjectDimensions } from '../dimensions'
import { computeVeo3FullFrameDims, veo3DimsAreFalsy, VEO3_ANCHOR_VERSION } from '../media/veo3-geometry'
import { mergeAvatarLayerUpdates } from '../avatar-layer-sync'
import { compileD3SceneFromLayers } from '../charts/compile'
import { isAvatarExpired, avatarTimeoutMessage, avatarSceneFitDuration } from '../services/avatar-job-deadline'
import type { Set, Get } from './types'
import { getResolvedStyle } from './helpers'
import { resolveSpendGate } from './spend-gate'
import { createLogger } from '../logger'
import { normalizeMediaSpec } from '../types/media-spec'
import { resolveOpticsPreset } from '../media/optics'

const log = createLogger('store.generation')

// Operation names with a live `pollVeo3Status` loop. Module-level so it survives
// store re-creation and dedupes across every caller (UI generate, agent-inserted
// layer reconcile, restart rehydrate). Without it, reconcilePendingVideoPolls would
// spawn a second poll loop for a layer the UI path is already polling. An entry is
// added when a loop starts and removed on every terminal exit (done/error/timeout/
// no-ipc) so a layer that re-enters 'generating' can be polled again.
const activeVideoPolls = new Set<string>()
// Same dedupe for HeyGen avatar polls, keyed by heygenVideoId.
const activeAvatarPolls = new Set<string>()
// Post-run media-generation failures we've already surfaced to chat, keyed
// by layerId, so a re-entrant poll / reconcile can't post the same failure twice.
const surfacedMediaFailures = new Set<string>()

/**
 * Durable failure surfacing. When a RENDERER poll marks a media layer
 * 'error' (often AFTER the agent run has ended, when only a 3.6s toast used to
 * fire), post a PERSISTENT assistant-style chat message naming the scene, what
 * failed, and a suggested action — so the failure survives reload and the run
 * can't read as a silent success while the canvas shows a broken/empty layer.
 *
 * Best-effort + idempotent (deduped by layerId). Persistence reuses the store's
 * own persistChatMessage path (showcase-fenced, IPC-backed).
 */
function postMediaFailureMessage(
  get: Get,
  args: { sceneId: string; layerId: string; kind: string; reason: string; suggestion: string },
): void {
  if (surfacedMediaFailures.has(args.layerId)) return
  surfacedMediaFailures.add(args.layerId)
  try {
    const scene = get().scenes.find((s) => s.id === args.sceneId)
    const sceneName = scene?.name || 'a scene'
    const id = uuidv4()
    const text = `⚠️ ${args.kind} generation failed in "${sceneName}": ${args.reason} ${args.suggestion}`
    get().addChatMessage({
      id,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
    } as unknown as import('../agents/types').ChatMessage)
    // Persist so it survives reload (best-effort; the in-memory message shows regardless).
    void get()
      .persistChatMessage?.(id)
      ?.catch((e: unknown) => log.warn('media-failure chat persist failed', { error: e }))
  } catch (e) {
    log.warn('postMediaFailureMessage failed', { error: e })
  }
}

export function createGenerationActions(set: Set, get: Get) {
  // Per-scene save deduplication: if a save is in flight, queue the next one
  const _pendingSave = new Map<string, Promise<void>>()
  /** sceneId → quiet flag for the queued re-save. A non-quiet request must
   *  survive dedup (quiet only if EVERY queued request was quiet), else the
   *  sceneHtmlVersion bump is lost and the preview iframe never reloads —
   *  e.g. dropping media: the scene/update effect's quiet save is in flight
   *  when the explicit non-quiet save arrives. */
  const _queuedSave = new Map<string, boolean>()

  return {
    generateSVG: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { svgContent: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          font: getResolvedStyle(globalStyle).font,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: string; usage?: SceneUsage }
        data = (await ipc.svg(payload)) as typeof data

        const cleanedSvg: string = data.result ?? ''
        const usage: SceneUsage | null = data.usage ?? null

        const rootBranch: SvgBranch = {
          id: uuidv4(),
          parentId: null,
          label: 'Original',
          svgContent: cleanedSvg,
          usage,
        }

        const currentScene = get().scenes.find((s) => s.id === sceneId)!
        const existingPrimary = (currentScene.svgObjects ?? []).find((o) => o.id === currentScene.primaryObjectId)
        const primaryId = existingPrimary?.id ?? uuidv4()
        const primaryObj: SvgObject = {
          id: primaryId,
          prompt: currentScene.prompt,
          svgContent: cleanedSvg,
          x: existingPrimary?.x ?? 0,
          y: existingPrimary?.y ?? 0,
          width: existingPrimary?.width ?? 100,
          opacity: existingPrimary?.opacity ?? 1,
          zIndex: 2,
        }
        const updatedObjects = existingPrimary
          ? (currentScene.svgObjects ?? []).map((o) => (o.id === primaryId ? primaryObj : o))
          : [primaryObj, ...(currentScene.svgObjects ?? [])]

        get().updateScene(sceneId, {
          svgContent: cleanedSvg,
          usage,
          svgBranches: [rootBranch],
          activeBranchId: rootBranch.id,
          svgObjects: updatedObjects,
          primaryObjectId: primaryId,
        })

        await get().saveSceneHTML(sceneId)

        try {
          const ipc2 = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
          const summaryPayload = { prompt: scene.prompt, svgContent: cleanedSvg }
          const summaryData = ipc2 ? await ipc2.summarize(summaryPayload) : null
          if (summaryData?.result) {
            get().updateScene(sceneId, { summary: (summaryData.result ?? '').trim().slice(0, 200) })
          }
        } catch {
          // Summary is optional
        }
      } catch (err) {
        log.error('SVG generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateCanvas: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { canvasCode: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          bgColor: scene.bgColor,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: string; usage?: SceneUsage }
        data = await ipc.canvas(payload)

        const cleanedCode: string = data.result ?? ''
        const usage: SceneUsage | null = data.usage ?? null

        get().updateScene(sceneId, { canvasCode: cleanedCode, usage })
        await get().saveSceneHTML(sceneId)

        try {
          const ipc2 = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
          const summaryPayload = { prompt: scene.prompt, svgContent: cleanedCode.slice(0, 2000) }
          const summaryData = ipc2 ? await ipc2.summarize(summaryPayload) : null
          if (summaryData?.result) {
            get().updateScene(sceneId, { summary: (summaryData.result ?? '').trim().slice(0, 200) })
          }
        } catch {
          // Summary is optional
        }
      } catch (err) {
        log.error('canvas generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Canvas generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateMotion: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { sceneCode: '', sceneHTML: '', sceneStyles: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          font: getResolvedStyle(globalStyle).font,
          bgColor: scene.bgColor,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: { sceneCode?: string; htmlContent?: string; styles?: string }; usage?: SceneUsage }
        data = (await ipc.motion(payload)) as typeof data

        const result = data.result ?? {}
        get().updateScene(sceneId, {
          sceneCode: result.sceneCode ?? '',
          sceneHTML: result.htmlContent ?? '',
          sceneStyles: result.styles ?? '',
          usage: data.usage ?? null,
        })
        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('motion generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Motion generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateReact: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { reactCode: '', sceneStyles: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          font: getResolvedStyle(globalStyle).font,
          bgColor: scene.bgColor,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: { sceneCode?: string; styles?: string }; usage?: SceneUsage }
        data = (await ipc.react(payload)) as typeof data

        const result = data.result ?? {}
        get().updateScene(sceneId, {
          reactCode: result.sceneCode ?? '',
          sceneStyles: result.styles ?? '',
          usage: data.usage ?? null,
        })
        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('react generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'React generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateD3: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { sceneCode: '', sceneStyles: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          font: getResolvedStyle(globalStyle).font,
          bgColor: scene.bgColor,
          duration: scene.duration || 8,
          d3Data: scene.d3Data,
          previousSummary,
        }
        let data: {
          result?: {
            chartLayers?: unknown[]
            sceneCode?: string
            d3Data?: unknown
            styles?: unknown
            suggestedData?: unknown
          }
          usage?: SceneUsage
        }
        data = (await ipc.d3(payload)) as typeof data
        const result = data.result ?? {}
        const nextLayers = (Array.isArray(result.chartLayers) ? result.chartLayers : []) as D3ChartLayer[]
        get().updateScene(sceneId, {
          sceneType: 'd3',
          sceneCode: result.sceneCode ?? '',
          sceneStyles: (result.styles as string) ?? '',
          d3Data: result.d3Data ?? result.suggestedData ?? null,
          chartLayers: nextLayers,
          usage: data.usage ?? null,
        })
        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('d3 generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'D3 generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateThree: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { sceneCode: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          bgColor: scene.bgColor,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: { sceneCode?: string }; usage?: SceneUsage }
        data = (await ipc.three(payload)) as typeof data

        const result = data.result ?? {}
        get().updateScene(sceneId, {
          sceneCode: result.sceneCode ?? '',
          usage: data.usage ?? null,
        })
        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('three.js generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Three.js generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    generateLottie: async (sceneId: string) => {
      const { scenes, globalStyle } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      const sceneIndex = scenes.findIndex((s) => s.id === sceneId)
      const previousSummary = sceneIndex > 0 ? scenes[sceneIndex - 1].summary : ''

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })
      get().updateScene(sceneId, { svgContent: '' })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          prompt: scene.prompt,
          palette: getResolvedStyle(globalStyle).palette,
          font: getResolvedStyle(globalStyle).font,
          duration: scene.duration || 8,
          previousSummary,
        }
        let data: { result?: string; usage?: SceneUsage }
        data = (await ipc.lottie(payload)) as typeof data

        const cleanedSvg: string = data.result ?? ''
        const usage: SceneUsage | null = data.usage ?? null

        get().updateScene(sceneId, { svgContent: cleanedSvg, usage })
        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('lottie overlay generation error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Lottie generation failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    editSVG: async (sceneId: string, instruction: string) => {
      const { scenes } = get()
      const scene = scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.svgContent || !instruction.trim()) return

      set({ isGenerating: true, generatingSceneId: sceneId, lastGenerationError: null })

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = { svgContent: scene.svgContent, editInstruction: instruction }
        let data: { result?: string; usage?: SceneUsage }
        data = (await ipc.editSvg(payload)) as typeof data
        const cleanedSvg: string = data.result ?? ''
        const usage: SceneUsage | null = data.usage ?? null

        const preSyncScene = get().scenes.find((s) => s.id === sceneId)!
        if (preSyncScene.primaryObjectId) {
          get().updateSvgObject(sceneId, preSyncScene.primaryObjectId, { svgContent: cleanedSvg })
        }

        const currentScene = get().scenes.find((s) => s.id === sceneId)!
        const newBranch: SvgBranch = {
          id: uuidv4(),
          parentId: currentScene.activeBranchId,
          label: instruction.trim().slice(0, 40),
          svgContent: cleanedSvg,
          usage,
        }
        get().updateScene(sceneId, {
          svgContent: cleanedSvg,
          usage,
          svgBranches: [...currentScene.svgBranches, newBranch],
          activeBranchId: newBranch.id,
        })

        await get().saveSceneHTML(sceneId)
      } catch (err) {
        log.error('edit error', { error: err })
        set({ lastGenerationError: err instanceof Error ? err.message : 'Edit failed' })
      } finally {
        set({ isGenerating: false, generatingSceneId: null })
      }
    },

    enhancePrompt: async (sceneId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene || !scene.prompt.trim()) return

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = { prompt: scene.prompt }
        const data = await ipc.enhancePrompt(payload)
        if (data?.result) get().updateScene(sceneId, { prompt: (data.result ?? '').trim() })
      } catch (err) {
        log.error('enhance error', { error: err })
      }
    },

    saveSceneHTML: async (sceneId: string, quiet = false) => {
      // Deduplicate: if a save is already in flight for this scene, queue a re-save
      if (_pendingSave.has(sceneId)) {
        _queuedSave.set(sceneId, (_queuedSave.get(sceneId) ?? true) && quiet)
        return _pendingSave.get(sceneId)
      }

      const doSave = async () => {
        let scene = get().scenes.find((s) => s.id === sceneId)
        if (!scene) {
          log.error('saveSceneHTML: scene not found', { extra: { sceneId } })
          return
        }
        set({ sceneSaveStatus: { ...get().sceneSaveStatus, [sceneId]: 'saving' } })
        if (scene.sceneType === 'd3' && (scene.chartLayers?.length ?? 0) > 0) {
          const compiled = compileD3SceneFromLayers(scene.chartLayers ?? [])
          if (
            compiled.sceneCode !== scene.sceneCode ||
            JSON.stringify(compiled.d3Data) !== JSON.stringify(scene.d3Data)
          ) {
            get().updateScene(sceneId, { sceneCode: compiled.sceneCode, d3Data: compiled.d3Data as any })
            scene = get().scenes.find((s) => s.id === sceneId) ?? scene
          }
        }
        // Resolve watermark if configured
        const wm = get().project.watermark
        let watermarkWithUrl = null as any
        if (wm) {
          const asset = get().projectAssets.find((a) => a.id === wm.assetId)
          if (asset) {
            watermarkWithUrl = { ...wm, publicUrl: asset.publicUrl }
          }
        }
        const { mp4Settings } = get().project
        const html = generateSceneHTML(
          scene,
          get().globalStyle,
          watermarkWithUrl,
          get().audioSettings,
          resolveProjectDimensions(mp4Settings?.aspectRatio, mp4Settings?.resolution),
        )
        try {
          const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
          if (!sceneIpc) {
            log.error('saveSceneHTML: scene IPC unavailable')
            set({
              sceneWriteErrors: { ...get().sceneWriteErrors, [sceneId]: 'Save failed (IPC unavailable)' },
              sceneSaveStatus: { ...get().sceneSaveStatus, [sceneId]: 'error' },
            })
            return
          }
          await sceneIpc.writeHtml({ id: sceneId, html })
          log.debug('saveSceneHTML saved', { extra: { sceneId, chars: html.length } })
          // Clear any previous error for this scene
          const { [sceneId]: _, ...rest } = get().sceneWriteErrors
          set({
            sceneWriteErrors: rest,
            sceneSaveStatus: { ...get().sceneSaveStatus, [sceneId]: 'saved' },
            sceneLastSavedAt: { ...get().sceneLastSavedAt, [sceneId]: Date.now() },
          })
          if (!quiet) {
            set({ sceneHtmlVersion: get().sceneHtmlVersion + 1 })
          }
        } catch (err) {
          log.error('saveSceneHTML save failed', { error: err })
          set({
            sceneWriteErrors: {
              ...get().sceneWriteErrors,
              [sceneId]: (err as Error).message ?? 'Save failed',
            },
            sceneSaveStatus: { ...get().sceneSaveStatus, [sceneId]: 'error' },
          })
        }
      }

      const promise = doSave().finally(() => {
        _pendingSave.delete(sceneId)
        // If a save was queued while we were writing, run it now with fresh
        // state — at the queued requests' OWN quiet level, not this call's.
        if (_queuedSave.has(sceneId)) {
          const queuedQuiet = _queuedSave.get(sceneId)!
          _queuedSave.delete(sceneId)
          get().saveSceneHTML(sceneId, queuedQuiet)
        }
      })
      _pendingSave.set(sceneId, promise)
      return promise
    },

    /**
     * Scene HTML self-heal. On project load, for each scene with
     * renderable content, generate the expected HTML via the SAME
     * generateSceneHTML path the save uses, compare it byte-for-byte against the
     * on-disk file, and regenerate (through saveSceneHTML) ONLY when the file is
     * missing or stale. Healthy scenes are never rewritten. A regen failure
     * surfaces a visible error in sceneWriteErrors — never a silent blank
     * preview. Best-effort + bounded: runs sequentially, swallows per-scene
     * errors into the error map so one bad scene never aborts the rest.
     */
    healProjectScenes: async () => {
      const sceneIpc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
      if (!sceneIpc?.readHtml) return

      // COMMIT 6: never heal while an agent run is live — its in-flight scene
      // writes would race the heal's saveSceneHTML and could clobber a
      // partially-written scene. Use the SAME source of truth orphan detection
      // uses (agent.activeRunIds), NOT store.isAgentRunning (legacy/dead, never
      // set). On IPC failure, skip the heal (conservative — don't race a run we
      // can't see).
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dreambyteApi = (typeof window !== 'undefined' ? (window as any).dreambyteApi : null) as any
        if (dreambyteApi?.agent?.activeRunIds) {
          const { runIds } = await dreambyteApi.agent.activeRunIds()
          if (Array.isArray(runIds) && runIds.length > 0) {
            log.info('healProjectScenes: skipped — agent run(s) active', { extra: { activeRuns: runIds.length } })
            return
          }
        }
      } catch (err) {
        log.warn('healProjectScenes: activeRunIds check failed, skipping heal to avoid racing a run', { error: err })
        return
      }

      const { decideSceneHeal } = await import('./scene-heal')
      const { mp4Settings, watermark } = get().project
      const dims = resolveProjectDimensions(mp4Settings?.aspectRatio, mp4Settings?.resolution)
      // Resolve the watermark public URL exactly as saveSceneHTML does so the
      // expected HTML matches the save-path output byte-for-byte.
      let watermarkWithUrl = null as Parameters<typeof generateSceneHTML>[2]
      if (watermark) {
        const asset = get().projectAssets.find((a) => a.id === watermark.assetId)
        if (asset) watermarkWithUrl = { ...watermark, publicUrl: asset.publicUrl } as never
      }
      const audioSettings = get().audioSettings
      const globalStyle = get().globalStyle

      // Snapshot the scenes up front — healing must reflect the just-loaded
      // project, and saveSceneHTML re-reads live state per scene anyway.
      const scenes = [...get().scenes]

      // COMMIT 6: the per-scene DIAGNOSIS (generateSceneHTML + readHtml +
      // decideSceneHeal) is read-only and independent, so run it with bounded
      // concurrency (~4) instead of one-at-a-time — on a many-scene project the
      // readHtml round-trips dominated load time. The actual heal WRITES stay
      // strictly sequential below (saveSceneHTML re-reads live state and we
      // don't want concurrent disk writes racing). Per-scene failures are
      // swallowed into a skip so one bad scene never aborts the rest.
      const CONCURRENCY = 4
      const diagnoseScene = async (
        scene: (typeof scenes)[number],
      ): Promise<{ sceneId: string; reason: string } | null> => {
        let expectedHtml: string
        try {
          expectedHtml = generateSceneHTML(scene, globalStyle, watermarkWithUrl, audioSettings, dims)
        } catch (err) {
          log.warn('healProjectScenes: generate failed, skipping scene', {
            extra: { sceneId: scene.id },
            error: err,
          })
          return null
        }
        if (!expectedHtml) return null // nothing renderable yet — never clobber with blank
        let onDisk: { exists: boolean; html: string | null }
        try {
          onDisk = await sceneIpc.readHtml({ id: scene.id })
        } catch (err) {
          // Couldn't read the file — treat as missing so we heal it, rather than
          // leave the preview potentially blank.
          log.warn('healProjectScenes: readHtml failed, treating as missing', {
            extra: { sceneId: scene.id },
            error: err,
          })
          onDisk = { exists: false, html: null }
        }
        const decision = decideSceneHeal(expectedHtml, onDisk)
        if (!decision.needsHeal) return null // healthy → no write
        return { sceneId: scene.id, reason: decision.reason ?? 'stale' }
      }

      // Bounded-concurrency map preserving order; results align to `scenes`.
      const diagnoses: Array<{ sceneId: string; reason: string } | null> = new Array(scenes.length).fill(null)
      let cursor = 0
      const worker = async () => {
        while (true) {
          const idx = cursor++
          if (idx >= scenes.length) return
          diagnoses[idx] = await diagnoseScene(scenes[idx])
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenes.length) }, worker))

      // Heal writes — strictly sequential.
      for (const d of diagnoses) {
        if (!d) continue
        log.info('healProjectScenes: healing scene', { extra: { sceneId: d.sceneId, reason: d.reason } })
        try {
          await get().saveSceneHTML(d.sceneId, true)
        } catch (err) {
          // Visible error — never a silent blank preview.
          set({
            sceneWriteErrors: {
              ...get().sceneWriteErrors,
              [d.sceneId]: `Scene preview could not be regenerated (${d.reason})`,
            },
            sceneSaveStatus: { ...get().sceneSaveStatus, [d.sceneId]: 'error' },
          })
          log.error('healProjectScenes: regen failed', { extra: { sceneId: d.sceneId }, error: err })
        }
      }
    },

    generateAIImage: async (
      sceneId: string,
      opts: {
        prompt: string
        model?: string
        style?: string | null
        aspectRatio?: string
        removeBackground?: boolean
        seed?: number | null
        strength?: number | null
        x?: number
        y?: number
        width?: number
        height?: number
        label?: string
      },
    ) => {
      const { project } = get()
      const layerId = uuidv4()

      // Add pending layer
      const isSticker = opts.removeBackground ?? false
      const resolvedModel = opts.model ?? (isSticker ? 'recraft-v3' : 'flux-schnell')
      // Record the spec that produced this layer so the Cinema Studio panel can show +
      // regenerate from it. Inline on the layer, persisted with the scene.
      const mediaSpec = normalizeMediaSpec({
        modality: 'image',
        model: resolvedModel,
        prompt: opts.prompt,
        aspectRatio: opts.aspectRatio ?? '1:1',
        stylePreset: opts.style ?? null,
        seed: opts.seed ?? null,
        strength: opts.strength ?? null,
      })
      const layer: AILayer = isSticker
        ? {
            id: layerId,
            type: 'sticker' as const,
            prompt: opts.prompt,
            model: resolvedModel as any,
            style: (opts.style ?? 'illustration') as any,
            imageUrl: null,
            stickerUrl: null,
            x: opts.x ?? 960,
            y: opts.y ?? 540,
            width: opts.width ?? 200,
            height: opts.height ?? 200,
            rotation: 0,
            opacity: 1,
            zIndex: 10,
            status: 'generating',
            animateIn: true,
            startAt: 0,
            label: opts.label ?? 'AI Sticker',
            mediaSpec,
          }
        : {
            id: layerId,
            type: 'image' as const,
            prompt: opts.prompt,
            model: resolvedModel as any,
            style: (opts.style ?? null) as any,
            imageUrl: null,
            x: opts.x ?? 960,
            y: opts.y ?? 540,
            width: opts.width ?? 400,
            height: opts.height ?? 400,
            rotation: 0,
            opacity: 1,
            zIndex: 5,
            status: 'generating',
            label: opts.label ?? 'AI Image',
            mediaSpec,
          }

      get().addAILayer(sceneId, layer)

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc) throw new Error('generate requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        const payload = {
          projectId: project.id,
          sceneId,
          prompt: opts.prompt,
          model: resolvedModel,
          style: opts.style,
          aspectRatio: opts.aspectRatio ?? '1:1',
          removeBackground: isSticker,
          // Manual seed / strength (Cinema Studio raw-t2i controls). generateImageAsset forwards
          // them to generateImage, which keys the cache on seed + pins reproducibility.
          seed: opts.seed ?? null,
          strength: opts.strength ?? null,
        }
        // Skip the prompt outright if the user already approved imageGen for this session.
        const sessionApproved = get().spendApprovedThisSession.has('imageGen')
        let data = await ipc.image({ ...payload, approvedAsk: sessionApproved })

        // Always-ask gate: project policy requires interactive approval. Pop the modal, then either
        // re-dispatch (approved) or cancel (denied). 'deny' (cap/disabled) never reaches here — it
        // comes back as `error`, which we surface below without a prompt.
        if (data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, 'imageGen', data.permissionNeeded)
          if (!proceed) {
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            get().showTransientStatus?.('Image generation cancelled.', 2400)
            return
          }
          data = await ipc.image({ ...payload, approvedAsk: true })
        }

        // Permission/spend gate denied the call (cap exceeded / api disabled) or the provider
        // returned nothing → mark the layer errored + tell the user, don't leave it 'generating'
        // forever or set 'ready' with no image.
        if (data.error || !data.imageUrl) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.(data.error ?? 'Image generation failed', 3200)
          return
        }

        if (isSticker) {
          get().updateAILayer(sceneId, layerId, {
            status: 'ready',
            imageUrl: data.imageUrl,
            stickerUrl: data.stickerUrl,
          } as Partial<AILayer>)
        } else {
          get().updateAILayer(sceneId, layerId, {
            status: 'ready',
            imageUrl: data.imageUrl,
          } as Partial<AILayer>)
        }

        // Regenerate scene HTML
        await get().saveSceneHTML(sceneId)
      } catch (err: any) {
        log.error('AI image generation failed', { error: err })
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
      }
    },

    // Cinema Studio character reuse. Renders a character (i2i, consistent identity) into the
    // selected scene via the gated characters.reuse IPC. The character bundle owns its own seed +
    // strength + reference — no manual seed here. reuseCharacter is synchronous-to-result
    // (returns the finished imageUrl), so the pending layer flips straight to ready on success.
    generateCharacterImage: async (
      sceneId: string,
      opts: {
        characterId: string
        characterName?: string
        model?: string | null
        prompt: string
        aspectRatio?: string
      },
    ) => {
      const { project } = get()
      const layerId = uuidv4()
      const specModel = opts.model ?? 'flux-1.1-pro'
      const mediaSpec = normalizeMediaSpec({
        modality: 'image',
        model: specModel,
        prompt: opts.prompt,
        aspectRatio: opts.aspectRatio ?? '1:1',
        characterId: opts.characterId,
      })
      const layer: AILayer = {
        id: layerId,
        type: 'image' as const,
        prompt: opts.prompt,
        model: specModel as any,
        style: null as any,
        imageUrl: null,
        x: 960,
        y: 540,
        width: 400,
        height: 400,
        rotation: 0,
        opacity: 1,
        zIndex: 5,
        status: 'generating',
        label: opts.characterName || 'Character',
        mediaSpec,
      }
      get().addAILayer(sceneId, layer)

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.characters : undefined
        if (!ipc)
          throw new Error(
            'character generation requires the desktop runtime (window.dreambyteApi.characters unavailable).',
          )
        const reuseArgs = {
          projectId: project.id,
          character: opts.characterId,
          prompt: opts.prompt,
          aspectRatio: opts.aspectRatio ?? '1:1',
        }
        const sessionApproved = get().spendApprovedThisSession.has('imageGen')
        let data = await ipc.reuse({ ...reuseArgs, approvedAsk: sessionApproved })
        // Always-ask gate: pop the modal, then re-dispatch (approved) or cancel (denied).
        if ('permissionNeeded' in data && data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            get().showTransientStatus?.('Character generation cancelled.', 2400)
            return
          }
          data = await ipc.reuse({ ...reuseArgs, approvedAsk: true })
        }
        // Failure (spend-cap deny / dangling ref / no provider) comes back as { error }. A leftover
        // permissionNeeded here (the user approved but the re-dispatch still asked) is treated as a
        // generic failure rather than re-prompting in a loop.
        if (!('imageUrl' in data)) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.(('error' in data && data.error) || 'Character generation failed', 3200)
          return
        }
        if (!data.imageUrl) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.('Character generation failed', 3200)
          return
        }
        get().updateAILayer(sceneId, layerId, { status: 'ready', imageUrl: data.imageUrl } as Partial<AILayer>)
        await get().saveSceneHTML(sceneId)
      } catch (err: any) {
        log.error('character generation failed', { error: err })
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
      }
    },

    // Cinema Studio video. Renders a text-to-video clip into the selected scene via the gated
    // generate.video IPC (startVideo), then polls. Mirrors generateAIImage but async-by-operation:
    // startVideo returns an operationName, pollVeo3Status finishes the layer when the clip lands.
    generateAIVideo: async (
      sceneId: string,
      opts: {
        prompt: string
        model?: string
        aspectRatio?: string
        duration?: number
        seed?: number | null
        /** i2v: a conditioning image reference (data URL / app URL). Routes to the i2v endpoint. */
        imageUrl?: string | null
        /** Tier 2 (#5) keyframes: the END frame; with imageUrl as the start frame, routes to the
         *  provider's start+end keyframe endpoint. Keyframe-capable models only (enforced upstream). */
        endImageUrl?: string | null
        /** Tier 2 (#5) extend: a source clip to continue (video→video). Extend-capable models only. */
        extendVideoUrl?: string | null
        /** Tier 2 (#4) v2v: a source clip to transform in place (restyle/relight/...). v2v models only. */
        editVideoUrl?: string | null
        /** Tier 2 (#4) the edit operation framing the prompt (with editVideoUrl). */
        edit?: import('../media/video-edit').VideoEditSpec | null
        /** Camera/motion spec — compiled into the prompt by startVideo for camera:'prompt' models. */
        camera?: import('../media/camera').CameraSpec | null
        /** Tier 2 (#8): a VFX effect preset id, compiled into the prompt by startVideo. */
        effect?: string | null
        /** Phase 3: a cinematic optics preset id (OPTICS_PRESETS), resolved to an OpticsSpec and
         *  compiled into the prompt by startVideo. */
        lensPreset?: string | null
      },
    ) => {
      const { project } = get()
      const layerId = uuidv4()
      const ar = (['16:9', '9:16', '1:1'].includes(opts.aspectRatio ?? '') ? opts.aspectRatio : '16:9') as
        | '16:9'
        | '9:16'
        | '1:1'
      const resolvedModel = opts.model ?? 'veo-3'
      // Tier 2 (#5): clamp to the chosen model's per-row cap (Veo 8, fal models 10) instead of the
      // old hard 5/8, via the SAME helper startVideo uses so the layer's shown duration can't diverge
      // from what the server bills + generates. Default 5 when unspecified.
      const { maxDurationFor, clampVideoDuration } = await import('../media/model-catalog')
      const dur = clampVideoDuration(opts.duration ?? undefined, maxDurationFor(resolvedModel))
      const mediaSpec = normalizeMediaSpec({
        modality: 'video',
        model: resolvedModel,
        prompt: opts.prompt,
        aspectRatio: ar,
        duration: dur,
        seed: opts.seed ?? null,
      })
      // Center coords + full-frame contain-fit dims from the project (the
      // old hardcoded 960/540/1280/720 was 16:9-only and wrong on 9:16/1:1).
      // This path already authored center — now it carries the anchor flag too.
      const cinemaDims = resolveProjectDimensions(project.mp4Settings?.aspectRatio, project.mp4Settings?.resolution)
      const cinemaBox = computeVeo3FullFrameDims(ar, cinemaDims)
      const layer: AILayer = {
        id: layerId,
        type: 'veo3' as const,
        prompt: opts.prompt,
        negativePrompt: null,
        aspectRatio: ar,
        duration: dur,
        loop: false,
        playbackRate: 1,
        x: Math.round(cinemaDims.width / 2),
        y: Math.round(cinemaDims.height / 2),
        width: cinemaBox.width,
        height: cinemaBox.height,
        anchorVersion: VEO3_ANCHOR_VERSION,
        opacity: 1,
        zIndex: 5,
        videoUrl: null,
        thumbnailUrl: null,
        status: 'generating',
        operationName: null,
        startAt: 0,
        label: 'AI Video',
        mediaSpec,
      }
      get().addAILayer(sceneId, layer)

      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc)
          throw new Error('video generation requires the desktop runtime (window.dreambyteApi.generate unavailable).')
        // startVideo routes by provider id, not model id — resolve it from the catalog.
        const { modelsForModality } = await import('../media/model-catalog')
        const provider = modelsForModality('video').find((m) => m.id === resolvedModel)?.providerId
        const videoArgs = {
          projectId: project.id,
          sceneId,
          layerId,
          provider,
          prompt: opts.prompt,
          aspectRatio: ar,
          duration: dur,
          seed: opts.seed ?? undefined,
          imageUrl: opts.imageUrl ?? undefined,
          endImageUrl: opts.endImageUrl ?? undefined,
          extendVideoUrl: opts.extendVideoUrl ?? undefined,
          editVideoUrl: opts.editVideoUrl ?? undefined,
          edit: opts.edit ?? undefined,
          camera: opts.camera ?? undefined,
          effect: opts.effect ?? undefined,
          optics: opts.lensPreset ? (resolveOpticsPreset(opts.lensPreset) ?? undefined) : undefined,
        }
        // Skip the prompt outright if the user already approved this provider for the session.
        const sessionApproved = provider ? get().spendApprovedThisSession.has(provider) : false
        let data = await ipc.video({ ...videoArgs, approvedAsk: sessionApproved })

        // Always-ask gate: project policy requires interactive approval. Pop the modal, then either
        // re-dispatch (approved) or cancel (denied). A hard 'deny' (cap/disabled) instead returns
        // `error` with no permissionNeeded and is surfaced below without a prompt.
        if (data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            get().showTransientStatus?.('Video generation cancelled.', 2400)
            return
          }
          data = await ipc.video({ ...videoArgs, approvedAsk: true })
        }

        if (data.error || data.permissionNeeded || !data.operationName) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.(
            data.error ??
              (data.permissionNeeded
                ? 'Video needs approval or exceeds the spend cap.'
                : 'Video generation failed to start.'),
            3600,
          )
          return
        }
        get().updateAILayer(sceneId, layerId, { operationName: data.operationName } as Partial<AILayer>)
        get().pollVeo3Status(sceneId, layerId, data.operationName, project.id, opts.prompt)
      } catch (err: any) {
        log.error('video generation failed', { error: err })
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
      }
    },

    // Cinema Studio / Tier 1 C — lipsync studio. A face image + narration → a presenter video,
    // attached as an avatar layer. Synchronous-by-result (the fal avatar providers run via
    // fal.subscribe), so the pending layer flips straight to ready on success — no polling.
    generateLipsync: async (
      sceneId: string,
      opts: { provider: string; imageUrl: string; text: string; ttsProvider?: string; voiceId?: string },
    ) => {
      const { project } = get()
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      if (!opts.imageUrl || !opts.text.trim()) {
        get().showTransientStatus?.('A face image and narration text are required for lipsync.', 3000)
        return
      }
      const layerId = uuidv4()
      const layer: AvatarLayer = {
        id: layerId,
        type: 'avatar',
        avatarId: '',
        voiceId: '',
        script: opts.text,
        removeBackground: false,
        x: 1640,
        y: 800,
        width: 280,
        height: 280,
        opacity: 1,
        zIndex: 100,
        videoUrl: null,
        thumbnailUrl: null,
        status: 'generating',
        heygenVideoId: null,
        estimatedDuration: scene.duration,
        startAt: 0,
        label: 'Lipsync',
        avatarPlacement: 'pip_bottom_right',
        avatarProvider: opts.provider,
      }
      get().addAILayer(sceneId, layer)
      get().showTransientStatus?.('Generating lipsync… this can take up to a minute.', 4000)
      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
        if (!ipc?.lipsync) throw new Error('Lipsync requires the desktop runtime.')
        const lipsyncArgs = {
          projectId: project.id,
          provider: opts.provider,
          sourceImageUrl: opts.imageUrl,
          text: opts.text,
          ttsProvider: opts.ttsProvider,
          voiceId: opts.voiceId,
        }
        let data = await ipc.lipsync(lipsyncArgs)
        // Always-ask gate (covers the avatar + TTS sub-costs). Pop the modal; one approval clears
        // both prompts on the re-dispatch. A hard deny comes back as `error` (handled below).
        if ('permissionNeeded' in data && data.permissionNeeded) {
          const proceed = await resolveSpendGate(get, data.permissionNeeded.api, data.permissionNeeded)
          if (!proceed) {
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            get().showTransientStatus?.('Lipsync generation cancelled.', 2400)
            return
          }
          data = await ipc.lipsync({ ...lipsyncArgs, approvedAsk: true })
        }
        if (data.error || !data.videoUrl) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.(data.error ?? 'Lipsync generation failed', 3600)
          return
        }
        get().updateAILayer(sceneId, layerId, {
          status: 'ready',
          videoUrl: data.videoUrl,
          estimatedDuration: data.durationSeconds ?? scene.duration,
        } as Partial<AILayer>)
        // The avatar <video> renders muted (and export muxes audio TRACKS, not video-baked audio),
        // so attach the narration audio as a paired scene SFX track at the same start — otherwise the
        // lip-synced speech is never heard. addSFXToScene also saves the scene HTML.
        if (data.audioUrl) {
          get().addSFXToScene(sceneId, {
            id: `lipsync-${layerId}`,
            name: 'Lipsync narration',
            provider: 'local',
            src: data.audioUrl,
            triggerAt: 0,
            volume: 1,
            duration: data.durationSeconds ?? null,
          })
        } else {
          await get().saveSceneHTML(sceneId)
        }
      } catch (err: any) {
        log.error('lipsync generation failed', { error: err })
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
        const msg = err instanceof Error && err.message ? err.message.slice(0, 160) : 'Lipsync generation failed'
        get().showTransientStatus?.(msg, 3600)
      }
    },

    pollVeo3Status: (sceneId: string, layerId: string, operationName: string, projectId?: string, prompt?: string) => {
      // Dedupe: at most one poll loop per operationName. reconcilePendingVideoPolls
      // calls this for every generating layer on each scenes change, and the UI
      // generate path calls it directly — without this guard a layer would be polled
      // by two loops (double provider hits / racing updateAILayer writes).
      if (activeVideoPolls.has(operationName)) return
      activeVideoPolls.add(operationName)
      // Cap the poll so a persistently-failing lookup / stuck job can't leave the layer
      // 'generating' forever. 80 × 15s ≈ 20 min — past the slowest provider's typical window.
      // (The server-side video_jobs deadline is the authoritative bound; this is a client
      //  backstop so the UI never spins forever even if the renderer outlives the deadline.)
      let attempts = 0
      const MAX_POLL_ATTEMPTS = 80
      const stop = () => {
        activeVideoPolls.delete(operationName)
      }
      const poll = async () => {
        if (attempts++ >= MAX_POLL_ATTEMPTS) {
          get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
          get().showTransientStatus?.('Video generation timed out. Try again.', 3600)
          postMediaFailureMessage(get, {
            sceneId,
            layerId,
            kind: 'AI video',
            reason: 'the render timed out.',
            suggestion: 'Try regenerating the clip, or use a different video model.',
          })
          stop()
          return
        }
        try {
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
          if (!ipc) {
            // No IPC yet (SSR / pre-mount). Release the lock so a later reconcile retries.
            stop()
            return
          }
          const data: { done?: boolean; videoUrl?: string; error?: string } = await ipc.pollVideo({
            operationName,
            projectId,
            prompt,
          })

          if (data.done && data.videoUrl) {
            // An in-flight clip placed by an older build (or by an external writer)
            // may still be 0×0 — patch full-frame contain-fit dims + author
            // CENTER coords + the anchor flag so it renders, mirroring the
            // agent-side get_video_status helper. A layer that already has dims
            // keeps its coords/flag untouched.
            const cur = get()
              .scenes.find((s) => s.id === sceneId)
              ?.aiLayers?.find((l) => l.id === layerId) as
              | { width?: number; height?: number; aspectRatio?: string }
              | undefined
            let dimsPatch: Partial<AILayer> = {}
            if (cur && veo3DimsAreFalsy(cur)) {
              const { mp4Settings } = get().project
              const projectDims = resolveProjectDimensions(mp4Settings?.aspectRatio, mp4Settings?.resolution)
              const derived = computeVeo3FullFrameDims(cur.aspectRatio, projectDims)
              dimsPatch = {
                width: derived.width,
                height: derived.height,
                x: Math.round(projectDims.width / 2),
                y: Math.round(projectDims.height / 2),
                anchorVersion: VEO3_ANCHOR_VERSION,
              } as Partial<AILayer>
            }
            get().updateAILayer(sceneId, layerId, {
              status: 'ready',
              videoUrl: data.videoUrl,
              ...dimsPatch,
            } as Partial<AILayer>)
            // The clip is done and marked ready. A transient saveSceneHTML
            // failure must NOT bubble to the outer catch (which reschedules the
            // poll): re-polling would re-enter this path forever or, past
            // MAX_POLL_ATTEMPTS, overwrite the finished clip with status:'error'.
            // Stop regardless — a later autosave / edit persists the HTML.
            try {
              await get().saveSceneHTML(sceneId)
            } catch (e) {
              console.warn('[video-poll] saveSceneHTML failed after completion; clip kept ready', e)
            }
            stop()
            return
          }

          if (data.done && data.error) {
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            postMediaFailureMessage(get, {
              sceneId,
              layerId,
              kind: 'AI video',
              reason: data.error || 'the provider returned no video.',
              suggestion: 'Try regenerating the clip, or use a different video model.',
            })
            stop()
            return
          }

          setTimeout(poll, 15000)
        } catch {
          setTimeout(poll, 15000)
        }
      }
      setTimeout(poll, 5000)
    },

    // Reactive generation jobs: apply a status push from the main-process MediaGenerationRunner
    // (channel `dreambyte:generation.update`). This lands a finished asset on the timeline the
    // INSTANT the runner finalizes it — without waiting for the next reconcile tick or an agent
    // get_status call. It reuses the SAME completion path as the renderer poll loop (updateAILayer
    // + dims patch + saveSceneHTML), so the two converge idempotently: whichever resolves the
    // layer first wins; a redundant push on an already-ready layer is a harmless no-op.
    applyGenerationUpdate: (update: {
      jobId: string
      kind: string
      status: string
      sceneId?: string | null
      layerId?: string | null
      resultUrl?: string | null
      error?: string | null
    }) => {
      const { sceneId, layerId } = update
      if (!sceneId || !layerId) return
      const scene = get().scenes.find((s) => s.id === sceneId)
      const layer = scene?.aiLayers?.find((l) => l.id === layerId) as
        | { status?: string; width?: number; height?: number; aspectRatio?: string }
        | undefined
      if (!layer) return
      if (layer.status === 'ready' || layer.status === 'error') return // already resolved — no-op

      if (update.status === 'succeeded' && update.resultUrl) {
        // Mirror the renderer poll's dims fix for a clip that was placed at 0×0 before completion.
        let dimsPatch: Partial<AILayer> = {}
        if (veo3DimsAreFalsy(layer)) {
          const { mp4Settings } = get().project
          const projectDims = resolveProjectDimensions(mp4Settings?.aspectRatio, mp4Settings?.resolution)
          const derived = computeVeo3FullFrameDims(layer.aspectRatio, projectDims)
          dimsPatch = {
            width: derived.width,
            height: derived.height,
            x: Math.round(projectDims.width / 2),
            y: Math.round(projectDims.height / 2),
            anchorVersion: VEO3_ANCHOR_VERSION,
          } as Partial<AILayer>
        }
        get().updateAILayer(sceneId, layerId, {
          status: 'ready',
          videoUrl: update.resultUrl,
          ...dimsPatch,
        } as Partial<AILayer>)
        void get()
          .saveSceneHTML(sceneId)
          .catch((e) => console.warn('[gen-update] saveSceneHTML failed after push; clip kept ready', e))
        return
      }

      if (update.status === 'failed') {
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
        postMediaFailureMessage(get, {
          sceneId,
          layerId,
          kind: update.kind === 'avatar' ? 'avatar video' : 'AI video',
          reason: update.error || 'the provider returned no media.',
          suggestion: 'Try regenerating, or use a different model.',
        })
      }
    },

    reconcilePendingVideoPolls: () => {
      // Ensure every video layer still in 'generating' has a running poll loop. This is
      // what completes AGENT-inserted clips (the agent emits a layer/add with status
      // 'generating' + operationName but never starts a renderer poll) and what RESUMES
      // clips after a reload/restart (loadProject rehydrates generating layers from the
      // DB). Idempotent: pollVeo3Status dedupes by operationName, so this is safe to call
      // on every scenes change. The server-side video_jobs deadline bounds stale ops.
      const { scenes, project } = get()
      for (const scene of scenes) {
        for (const layer of scene.aiLayers ?? []) {
          const l = layer as { type?: string; status?: string; operationName?: string | null; prompt?: string }
          if (l.type === 'veo3' && l.status === 'generating' && l.operationName) {
            get().pollVeo3Status(scene.id, layer.id, l.operationName, project?.id, l.prompt)
          }
        }
      }
    },

    pollAvatarStatus: (sceneId: string, layerId: string, heygenVideoId: string) => {
      // Dedupe by HeyGen videoId — reconcilePendingAvatarPolls calls this for every
      // processing avatar on each scenes change, and the generate path may call it
      // directly. Without the guard a layer gets two racing loops.
      if (activeAvatarPolls.has(heygenVideoId)) return
      activeAvatarPolls.add(heygenVideoId)
      // Read the render start + startAt once. The deadline is the DURABLE half that
      // get_avatar_status can't cover once the agent run ends.
      const startLayer = get()
        .scenes.find((s) => s.id === sceneId)
        ?.aiLayers?.find((l) => l.id === layerId) as { renderStartedAt?: number; startAt?: number } | undefined
      const renderStartedAt = startLayer?.renderStartedAt
      let attempts = 0
      const MAX_POLL_ATTEMPTS = 80 // ~20-min backstop for legacy layers with no renderStartedAt
      const stop = () => activeAvatarPolls.delete(heygenVideoId)
      const failOut = (msg: string) => {
        get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
        get().showTransientStatus?.(msg, 3600)
        postMediaFailureMessage(get, {
          sceneId,
          layerId,
          kind: 'Avatar',
          reason: msg,
          suggestion: 'Try regenerating the avatar narration for this scene.',
        })
        stop()
      }
      const poll = async () => {
        if (isAvatarExpired(renderStartedAt, Date.now())) return failOut(avatarTimeoutMessage())
        if (attempts++ >= MAX_POLL_ATTEMPTS) return failOut(avatarTimeoutMessage())
        try {
          const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.generate : undefined
          if (!ipc) {
            stop() // no IPC yet (SSR / pre-mount) — release so a later reconcile retries
            return
          }
          const data = await ipc.pollHeygen(heygenVideoId)
          if (data.status === 'completed' && data.videoUrl) {
            const realDuration =
              typeof data.durationSeconds === 'number' && data.durationSeconds > 0 ? data.durationSeconds : null
            get().updateAILayer(sceneId, layerId, {
              status: 'ready',
              videoUrl: data.videoUrl,
              thumbnailUrl: data.thumbnailUrl ?? null,
              ...(realDuration !== null ? { estimatedDuration: realDuration } : {}),
            } as Partial<AILayer>)
            // SAME scene-fit the agent's get_avatar_status runs (shared helper) so a
            // renderer-completed avatar is not cut off.
            const curScene = get().scenes.find((s) => s.id === sceneId)
            const needed = avatarSceneFitDuration({
              startAt: Number(startLayer?.startAt) || 0,
              realDuration,
              sceneDuration: Number(curScene?.duration) || 0,
            })
            if (needed !== null) get().updateScene(sceneId, { duration: needed })
            // The clip is done + marked ready; a transient save failure must not re-poll.
            try {
              await get().saveSceneHTML(sceneId)
            } catch (e) {
              console.warn('[avatar-poll] saveSceneHTML failed after completion; clip kept ready', e)
            }
            stop()
            return
          }
          if (data.status === 'failed' || data.status === 'completed') {
            // 'completed' here means completed WITHOUT a usable videoUrl — the
            // happy completed+videoUrl path returned above. Treat it as a failure
            // (matching get_avatar_status) instead of polling on to the deadline,
            // and surface a toast like the deadline/agent paths do.
            get().updateAILayer(sceneId, layerId, { status: 'error' } as Partial<AILayer>)
            get().showTransientStatus?.('Avatar render failed. Try regenerating it.', 3600)
            postMediaFailureMessage(get, {
              sceneId,
              layerId,
              kind: 'Avatar',
              reason: 'the render failed.',
              suggestion: 'Try regenerating the avatar narration for this scene.',
            })
            stop()
            return
          }
          setTimeout(poll, 15000)
        } catch {
          setTimeout(poll, 15000)
        }
      }
      setTimeout(poll, 5000)
    },

    reconcilePendingAvatarPolls: () => {
      // Mirror of reconcilePendingVideoPolls for HeyGen avatars: keep a renderer poll
      // alive for every avatar layer still 'processing', so a wedged render is bounded
      // by the 15-min deadline even after the agent run ends (the DURABLE half —
      // get_avatar_status only enforces the deadline while the agent keeps polling).
      // The completion path runs the SAME scene-fit as get_avatar_status, so a
      // renderer-completed avatar isn't cut off. Idempotent: dedupes by heygenVideoId.
      const { scenes } = get()
      for (const scene of scenes) {
        for (const layer of scene.aiLayers ?? []) {
          const l = layer as { type?: string; status?: string; heygenVideoId?: string | null }
          if (l.type === 'avatar' && l.status === 'processing' && l.heygenVideoId) {
            get().pollAvatarStatus(scene.id, layer.id, l.heygenVideoId)
          }
        }
      }
    },

    // ── AI Layer actions ──────────────────────────────────────────────────────
    addAILayer: (sceneId: string, layer: AILayer) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        aiLayers: [...(scene.aiLayers ?? []), layer],
      })
    },

    updateAILayer: (sceneId: string, layerId: string, updates: Partial<AILayer>) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      const prev = (scene.aiLayers ?? []).find((l) => l.id === layerId)
      const patch =
        prev?.type === 'avatar'
          ? mergeAvatarLayerUpdates(prev as AvatarLayer, updates as Partial<AvatarLayer>)
          : updates
      get().updateScene(sceneId, {
        aiLayers: (scene.aiLayers ?? []).map((l) => (l.id === layerId ? ({ ...l, ...patch } as AILayer) : l)),
      })
    },

    removeAILayer: (sceneId: string, layerId: string) => {
      const scene = get().scenes.find((s) => s.id === sceneId)
      if (!scene) return
      get().updateScene(sceneId, {
        aiLayers: (scene.aiLayers ?? []).filter((l) => l.id !== layerId),
      })
    },

    // Frame capturer for agent visual feedback
    registerFrameCapturer: (capturer: ((sceneId: string, time: number) => Promise<string | null>) | null) => {
      ;(globalThis as any).__dreambyteFrameCapturer = capturer
    },
    captureSceneFrame: async (sceneId: string, time: number) => {
      const capturer = (globalThis as any).__dreambyteFrameCapturer as
        | ((sceneId: string, time: number) => Promise<string | null>)
        | null
      if (!capturer) return null
      return capturer(sceneId, time)
    },
  }
}
