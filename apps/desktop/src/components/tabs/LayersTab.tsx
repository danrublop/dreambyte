'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'
import AudioTabPanel from '@/components/audio/AudioTabPanel'
import TextTab from '@/components/tabs/TextTab'
import StudioTab from '@/components/tabs/StudioTab'
import SceneLayersStackPanel from '@/components/layers/SceneLayersStackPanel'
import LayerStackPropertiesPanel from '@/components/layers/LayerStackPropertiesPanel'
import type { LayersTabSectionId } from '@/lib/layers-tab-header'
import type { LayersStripTabId } from '@/lib/layers-strip-dock'
import { uploadBlob } from '@/lib/upload'

interface Props {
  scene: Scene
  /** Electron left rail: New Scene shortcut above setup (scene list lives in timeline / layer stack) */
  showScenesSection?: boolean
  isLeftCollapsed?: boolean
  /** When set, this instance is docked in the center strip: one strip mode only, no sub-tab bar. */
  lockedStripMode?: LayersStripTabId
}

async function uploadFile(file: File): Promise<string> {
  return uploadBlob(file, file.name)
}

export default function LayersTab({ scene, lockedStripMode }: Props) {
  const {
    updateScene,
    saveSceneHTML,
    project,
    layersTabSectionPending,
    clearLayersTabSectionPending,
    layerStackPropertiesKey,
  } = useVideoStore()

  const [isRecordingScreen, setIsRecordingScreen] = useState(false)
  const [recordingFps, setRecordingFps] = useState<number>(30)
  const [recordingResolution, setRecordingResolution] = useState<'source' | '720p' | '1080p' | '1440p' | '2160p'>(
    '1080p',
  )
  const [layerViewMode, setLayerViewMode] = useState<
    'properties' | 'studio' | 'audio' | 'text' | 'elements' | 'nodemap'
  >(() => lockedStripMode ?? 'nodemap')

  useEffect(() => {
    if (!layersTabSectionPending) return
    const pendingToMode: Partial<Record<LayersTabSectionId, 'properties' | 'audio' | 'text' | 'elements' | 'nodemap'>> =
      {
        properties: 'nodemap',
        studio: 'nodemap', // Studio settings (scene-level) now live in Layer tab master-detail
        audio: 'nodemap', // Audio settings now live inside the Layer tab
        text: 'text',
        elements: 'elements',
        nodemap: 'nodemap',
      }
    const mode = pendingToMode[layersTabSectionPending]
    if (mode) setLayerViewMode(mode)
    clearLayersTabSectionPending()
  }, [layersTabSectionPending, clearLayersTabSectionPending])

  useEffect(() => {
    if (lockedStripMode == null) return
    setLayerViewMode(lockedStripMode)
  }, [lockedStripMode, scene.id])

  useEffect(() => {
    const marker = scene.videoLayer?.src
    if (!marker || !marker.startsWith('recording://request')) return
    try {
      const qs = marker.includes('?') ? marker.split('?')[1] : ''
      const params = new URLSearchParams(qs)
      const parsedFps = Number(params.get('fps') || '')
      const parsedResolution = params.get('resolution')
      if (Number.isFinite(parsedFps) && parsedFps > 0) {
        setRecordingFps(Math.max(1, Math.min(120, Math.round(parsedFps))))
      }
      if (
        parsedResolution === 'source' ||
        parsedResolution === '720p' ||
        parsedResolution === '1080p' ||
        parsedResolution === '1440p' ||
        parsedResolution === '2160p'
      ) {
        setRecordingResolution(parsedResolution)
      }
    } catch {}
    updateScene(scene.id, { videoLayer: { ...scene.videoLayer, src: null, enabled: true } })
    void handleToggleScreenRecord()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.videoLayer?.src, scene.id])

  const videoInputRef = useRef<HTMLInputElement>(null)
  const screenRecorderRef = useRef<MediaRecorder | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenChunksRef = useRef<Blob[]>([])

  const handleVideoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const url = await uploadFile(file)
        updateScene(scene.id, { videoLayer: { ...scene.videoLayer, src: url, enabled: true } })
        await saveSceneHTML(scene.id)
      } catch {
        alert('Upload failed')
      }
    },
    [scene, updateScene, saveSceneHTML],
  )

  const stopScreenRecording = useCallback(() => {
    try {
      screenRecorderRef.current?.stop()
    } catch {}
    try {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {}
  }, [])

  const handleToggleScreenRecord = useCallback(async () => {
    if (!(window as any).electronAPI) {
      alert('Screen recording is only available in Electron mode.')
      return
    }
    if (isRecordingScreen) {
      stopScreenRecording()
      return
    }
    try {
      const resolutionMap: Record<
        'source' | '720p' | '1080p' | '1440p' | '2160p',
        { width: number; height: number } | null
      > = {
        source: null,
        '720p': { width: 1280, height: 720 },
        '1080p': { width: 1920, height: 1080 },
        '1440p': { width: 2560, height: 1440 },
        '2160p': { width: 3840, height: 2160 },
      }
      const sizeHint = resolutionMap[recordingResolution]
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: sizeHint
          ? {
              frameRate: { ideal: recordingFps, max: Math.max(15, recordingFps) },
              width: { ideal: sizeHint.width },
              height: { ideal: sizeHint.height },
            }
          : { frameRate: { ideal: recordingFps, max: Math.max(15, recordingFps) } },
        audio: true,
      })
      screenStreamRef.current = stream
      screenChunksRef.current = []

      const preferred = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      const mime = preferred.find((m) => MediaRecorder.isTypeSupported(m)) || ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      screenRecorderRef.current = recorder
      setIsRecordingScreen(true)

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) screenChunksRef.current.push(ev.data)
      }

      recorder.onstop = async () => {
        setIsRecordingScreen(false)
        try {
          const blob = new Blob(screenChunksRef.current, { type: mime || 'video/webm' })
          const bytes = await blob.arrayBuffer()
          const ext = (mime || 'video/webm').includes('mp4') ? 'mp4' : 'webm'
          const projectSlug = (project.name || 'project')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
          const sceneSlug = (scene.name || `scene-${(scene.order ?? 0) + 1}`)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
          const hint = `${projectSlug || 'project'}-${sceneSlug || `scene-${(scene.order ?? 0) + 1}`}-${recordingResolution}-${recordingFps}fps`
          const saved = await (window as any).electronAPI.saveRecording({ bytes, extension: ext, nameHint: hint })
          updateScene(scene.id, {
            videoLayer: {
              ...scene.videoLayer,
              src: saved.fileUrl,
              enabled: true,
              trimStart: 0,
              trimEnd: null,
            },
          })
          await saveSceneHTML(scene.id)
        } catch {
          alert('Recording save failed')
        } finally {
          screenRecorderRef.current = null
          screenChunksRef.current = []
          try {
            screenStreamRef.current?.getTracks().forEach((t) => t.stop())
          } catch {}
          screenStreamRef.current = null
        }
      }

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (screenRecorderRef.current?.state === 'recording') {
          stopScreenRecording()
        }
      })

      recorder.start(200)
    } catch {
      setIsRecordingScreen(false)
      alert('Screen recording failed or was cancelled.')
    }
  }, [
    isRecordingScreen,
    project.name,
    recordingFps,
    recordingResolution,
    saveSceneHTML,
    scene.id,
    scene.name,
    scene.order,
    scene.videoLayer,
    stopScreenRecording,
    updateScene,
  ])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm"
        onChange={handleVideoUpload}
        className="hidden"
        aria-hidden
      />
      {/* Branch selector moved to the shell top bar (EditorHeaderTools). */}
      {/* Sub-view back affordance. The layer stack (nodemap) is the default
          surface; deep-link sub-views (text/elements) show a "Layers" return.
          Code now lives in its own center tab (opened per-element from the
          stack's Edit-code action); the old in-panel Code tab is gone. */}
      {lockedStripMode == null && layerViewMode !== 'nodemap' && (
        <div className="flex items-center border-b border-[var(--color-border)] px-2 py-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setLayerViewMode('nodemap')}
            className="no-style flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <ChevronLeft size={12} /> Layers
          </button>
        </div>
      )}

      {/* ── Text tab ── */}
      {layerViewMode === 'text' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TextTab scene={scene} />
        </div>
      )}

      {/* ── Studio tab ── */}
      {layerViewMode === 'studio' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <StudioTab scene={scene} />
        </div>
      )}

      {/* ── Audio tab ── */}
      {layerViewMode === 'audio' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AudioTabPanel scene={scene} />
        </div>
      )}

      {/* ── Layer tab: master-detail
          Default view shows the layer list. Clicking (or double-clicking)
          a row opens that layer/scene's property editor. The
          edit panel has its own Close button to return to the list.
          Double-clicking a clip on the timeline routes here too (TrackRow
          calls openLayerStackProperties with the clip's media-layer key). ── */}
      {layerViewMode === 'nodemap' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {layerStackPropertiesKey ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <LayerStackPropertiesPanel scene={scene} />
            </div>
          ) : (
            <SceneLayersStackPanel scene={scene} fillAvailableHeight />
          )}
        </div>
      )}
    </div>
  )
}
