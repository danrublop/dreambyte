'use client'

import { useState, useRef, useMemo, useEffect } from 'react'
import { useVideoStore } from '@/lib/store'
import { modelsForModality, maxDurationFor } from '@/lib/media/model-catalog'
import { audioModelsForSubType, defaultAudioModelId, type AudioSubType } from '@/lib/audio/audio-models'
import { DEFAULT_AUDIO_PROVIDER_ENABLED } from '@/lib/audio/provider-registry'
import type { VideoEditOperation } from '@/lib/media/video-edit'
import type { CameraMoveType } from '@/lib/media/camera'

export type GenFormat = 'image' | 'video' | 'audio' | 'lipsync'

/** Camera move picker value (video only). 'none' = no camera clause. */
export type CameraChoice = CameraMoveType | 'none'

export interface GenCharacterOption {
  id: string
  name: string
  model: string | null
  hasReference: boolean
}

/**
 * Cinema-Studio "generate mode" composer state. All gen* state,
 * derived model/source lists, file-input refs, and source-select handlers,
 * extracted verbatim from AgentChat. Reads selectedSceneId / project / scenes
 * from the store directly, so it takes no arguments. AgentChat destructures the
 * returned object at the callsite, leaving every downstream reference unchanged.
 */
export function useGenerateComposer() {
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const generateProjectId = useVideoStore((s) => s.project?.id ?? null)
  const [generateMode, setGenerateMode] = useState(false)
  const [genFormat, setGenFormat] = useState<GenFormat>('image')
  const genImageModels = useMemo(
    () =>
      modelsForModality('image')
        .filter((m) => m.providerId === 'imageGen' || m.providerId === 'dall-e')
        .map((m) => ({ id: m.id, label: m.label, costCents: m.costScalars.perCallCents })),
    [],
  )
  const genVideoModels = useMemo(
    () => modelsForModality('video').map((m) => ({ id: m.id, label: m.label, costCents: m.costScalars.perCallCents })),
    [],
  )
  const genModelsForFormat = genFormat === 'video' ? genVideoModels : genImageModels
  const [genModel, setGenModel] = useState(
    () => genImageModels.find((m) => m.id === 'flux-1.1-pro')?.id ?? genImageModels[0]?.id ?? '',
  )
  // Effective model is ALWAYS valid for the current format — derived synchronously so switching
  // Image↔Video never leaves a stale (wrong-format) model sendable for a render.
  const effectiveGenModel = genModelsForFormat.some((m) => m.id === genModel)
    ? genModel
    : (genModelsForFormat[0]?.id ?? '')
  // An agent owns the selected scene → block generate (the paid IPC fires regardless of the
  // lock-rejected layer write, so gate at send; mirrors the scene-lock cursor model).
  const genSceneAgentLocked = useVideoStore(
    (s) => s.scenes.find((sc) => sc.id === s.selectedSceneId)?.lock?.owner === 'agent',
  )
  // Tier 2: fal video models go up to 10s. Clamped to the
  // selected model's per-row cap by the effect below so switching to Veo (max 8) can't leave a
  // stale 10s selected.
  const [genDuration, setGenDuration] = useState<number>(5)
  const [genAspect, setGenAspect] = useState('1:1')
  // Video supports only 16:9 / 9:16 / 1:1 — coerce a carried-over image aspect (4:3/3:4) so the
  // pill never shows a ratio video would silently clamp at generate time.
  const effectiveGenAspect = genFormat === 'video' && !['16:9', '9:16', '1:1'].includes(genAspect) ? '16:9' : genAspect
  const [genCharacterId, setGenCharacterId] = useState('')
  const [genSeedText, setGenSeedText] = useState('')
  const [genCharacters, setGenCharacters] = useState<GenCharacterOption[]>([])
  // Tier 2: keep the selected duration within the chosen video model's cap. Switching from a
  // 10s-capable fal model to Veo (8s) must drop a stale 10s selection so the pill never shows a
  // length the generate path would silently clamp.
  useEffect(() => {
    if (genFormat !== 'video') return
    const max = maxDurationFor(effectiveGenModel)
    if (genDuration > max) setGenDuration(max)
  }, [genFormat, effectiveGenModel, genDuration])
  useEffect(() => {
    if (!generateProjectId) {
      setGenCharacters([])
      return
    }
    const api = typeof window !== 'undefined' ? window.dreambyteApi?.characters : undefined
    if (!api) return
    let cancelled = false
    api
      .list(generateProjectId)
      .then((res) => {
        if (!cancelled)
          setGenCharacters(
            res.characters.map((c) => ({
              id: c.id,
              name: c.name,
              model: c.model,
              hasReference: c.referenceAssetIds.length > 0,
            })),
          )
      })
      .catch(() => {
        if (!cancelled) setGenCharacters([])
      })
    return () => {
      cancelled = true
    }
  }, [generateProjectId, generateMode])
  // ── Audio generation: sub-type (Voice/SFX/Music) + per-sub-type model + (Voice) voice ──
  const [genAudioKind, setGenAudioKind] = useState<AudioSubType>('tts')
  const [genAudioModel, setGenAudioModel] = useState(() => defaultAudioModelId('tts'))
  // Show only models whose provider is ENABLED in Settings — same as "enable a provider
  // → it appears in the picker" (a configured key / running local server flips the toggle
  // on via DEFAULT_AUDIO_PROVIDER_ENABLED). Fall back to the full list if a sub-type would
  // otherwise be empty (e.g. every provider toggled off) so the picker never breaks.
  const audioProviderEnabled = useVideoStore((s) => s.audioProviderEnabled)
  const genAudioModels = useMemo(() => {
    const all = audioModelsForSubType(genAudioKind)
    const enabled = all.filter((m) => audioProviderEnabled?.[m.id] ?? DEFAULT_AUDIO_PROVIDER_ENABLED[m.id] ?? false)
    return enabled.length > 0 ? enabled : all
  }, [genAudioKind, audioProviderEnabled])
  // Keep the selected audio model valid for the current sub-type (switching Voice↔SFX↔Music
  // never leaves a wrong-sub-type provider sendable). Mirrors effectiveGenModel for image/video.
  const effectiveAudioModel = genAudioModels.some((m) => m.id === genAudioModel)
    ? genAudioModel
    : (genAudioModels[0]?.id ?? '')
  const [genVoiceId, setGenVoiceId] = useState('')
  const [genVoices, setGenVoices] = useState<{ id: string; name: string }[]>([])
  // In-flight lock for the Generate Send path. The entry guard checks `isGenerating`, but the
  // generate branch never sets it, so without this a second Send (e.g. re-typing mid-generation)
  // fires a second PAID call. A ref (not state) so it gates synchronously within one Send.
  const genInFlightRef = useRef(false)
  // ── i2v (image-to-video): a "From image" source for Video mode, shown only when the chosen ──
  // model supports i2v (catalog capabilities.i2i). Source = a captured frame / upload / image layer.
  const genVideoI2vModels = useMemo(
    () =>
      new Set(
        modelsForModality('video')
          .filter((m) => m.capabilities.i2i)
          .map((m) => m.id),
      ),
    [],
  )
  const videoModelSupportsI2v = genFormat === 'video' && genVideoI2vModels.has(effectiveGenModel)
  const [genVideoSrc, setGenVideoSrc] = useState('none') // 'none' | 'frame' | 'upload' | `layer:<id>`
  const [genVideoUpload, setGenVideoUpload] = useState<{ dataUrl: string; name: string } | null>(null)
  const videoImageInputRef = useRef<HTMLInputElement>(null)
  const genScenes = useVideoStore((s) => s.scenes)
  const genSceneImageLayers = useMemo(() => {
    const sc = genScenes.find((x) => x.id === selectedSceneId)
    return (sc?.aiLayers ?? [])
      .filter((l) => l.type === 'image' && typeof (l as { imageUrl?: unknown }).imageUrl === 'string')
      .map((l) => ({ id: l.id, label: (l as { label?: string }).label || 'Image' }))
  }, [genScenes, selectedSceneId])
  const videoSourceItems = useMemo(() => {
    const items = [
      // Lipsync requires a face, so it omits the "No image" option (video i2v keeps it = t2v).
      ...(genFormat === 'lipsync' ? [] : [{ value: 'none', label: 'No image (text only)' }]),
      { value: 'frame', label: 'Current frame' },
      { value: 'upload', label: genVideoUpload ? `Upload: ${genVideoUpload.name}` : 'Upload…' },
      ...genSceneImageLayers.map((l) => ({ value: `layer:${l.id}`, label: l.label })),
    ]
    return items
  }, [genVideoUpload, genSceneImageLayers, genFormat])
  const onSelectVideoSource = (v: string) => {
    // Selecting "Upload…" opens the file dialog; the input's onChange sets the source on success.
    if (v === 'upload') {
      videoImageInputRef.current?.click()
      return
    }
    setGenVideoSrc(v)
  }
  // ── Tier 2: start+END keyframe + EXTEND (video→video) sources, gated on the chosen model's ──
  // capabilities.keyframes / .extend (parallel to the i2v gate above). End frame reuses the image
  // source picker (frame/upload/image-layer); extend takes a VIDEO source (a video layer / uploaded
  // clip) resolved with the kind:'video' trust-guard.
  const genVideoKeyframeModels = useMemo(
    () =>
      new Set(
        modelsForModality('video')
          .filter((m) => m.capabilities.keyframes)
          .map((m) => m.id),
      ),
    [],
  )
  const genVideoExtendModels = useMemo(
    () =>
      new Set(
        modelsForModality('video')
          .filter((m) => m.capabilities.extend)
          .map((m) => m.id),
      ),
    [],
  )
  const videoModelSupportsKeyframes = genFormat === 'video' && genVideoKeyframeModels.has(effectiveGenModel)
  const videoModelSupportsExtend = genFormat === 'video' && genVideoExtendModels.has(effectiveGenModel)
  const [genVideoEndSrc, setGenVideoEndSrc] = useState('none') // 'none' | 'frame' | 'upload' | `layer:<id>`
  const [genVideoEndUpload, setGenVideoEndUpload] = useState<{ dataUrl: string; name: string } | null>(null)
  const videoEndImageInputRef = useRef<HTMLInputElement>(null)
  const [genExtendSrc, setGenExtendSrc] = useState('none') // 'none' | 'upload' | `layer:<id>`
  const [genExtendUpload, setGenExtendUpload] = useState<{ dataUrl: string; name: string } | null>(null)
  const videoClipInputRef = useRef<HTMLInputElement>(null)
  const genSceneVideoLayers = useMemo(() => {
    const sc = genScenes.find((x) => x.id === selectedSceneId)
    return (sc?.aiLayers ?? [])
      .filter((l) => l.type === 'veo3' && typeof (l as { videoUrl?: unknown }).videoUrl === 'string')
      .map((l) => ({ id: l.id, label: (l as { label?: string }).label || 'Video' }))
  }, [genScenes, selectedSceneId])
  const videoEndSourceItems = useMemo(
    () => [
      { value: 'none', label: 'No end frame' },
      { value: 'frame', label: 'Current frame' },
      { value: 'upload', label: genVideoEndUpload ? `Upload: ${genVideoEndUpload.name}` : 'Upload…' },
      ...genSceneImageLayers.map((l) => ({ value: `layer:${l.id}`, label: l.label })),
    ],
    [genVideoEndUpload, genSceneImageLayers],
  )
  const videoExtendSourceItems = useMemo(
    () => [
      { value: 'none', label: 'No clip' },
      { value: 'upload', label: genExtendUpload ? `Upload: ${genExtendUpload.name}` : 'Upload clip…' },
      ...genSceneVideoLayers.map((l) => ({ value: `layer:${l.id}`, label: l.label })),
    ],
    [genExtendUpload, genSceneVideoLayers],
  )
  const onSelectVideoEndSource = (v: string) => {
    if (v === 'upload') {
      videoEndImageInputRef.current?.click()
      return
    }
    setGenVideoEndSrc(v)
  }
  const onSelectExtendSource = (v: string) => {
    if (v === 'upload') {
      videoClipInputRef.current?.click()
      return
    }
    setGenExtendSrc(v)
    // Extend and edit are mutually exclusive (startVideo rejects both) — picking one clears the other
    // so the user never assembles an ambiguous request.
    if (v !== 'none') setGenEditSrc('none')
  }
  // ── Tier 2: in-video EDIT (video→video / Aleph) — pick a source clip + an operation that ──
  // frames the prompt (restyle/relight/...). Gated on capabilities.videoToVideo, parallel to extend.
  const genVideoV2vModels = useMemo(
    () =>
      new Set(
        modelsForModality('video')
          .filter((m) => m.capabilities.videoToVideo)
          .map((m) => m.id),
      ),
    [],
  )
  const videoModelSupportsV2v = genFormat === 'video' && genVideoV2vModels.has(effectiveGenModel)
  const [genEditSrc, setGenEditSrc] = useState('none') // 'none' | 'upload' | `layer:<id>`
  const [genEditUpload, setGenEditUpload] = useState<{ dataUrl: string; name: string } | null>(null)
  const videoEditClipInputRef = useRef<HTMLInputElement>(null)
  const [genEditOp, setGenEditOp] = useState<VideoEditOperation>('restyle')
  const videoEditSourceItems = useMemo(
    () => [
      { value: 'none', label: 'No clip' },
      { value: 'upload', label: genEditUpload ? `Upload: ${genEditUpload.name}` : 'Upload clip…' },
      ...genSceneVideoLayers.map((l) => ({ value: `layer:${l.id}`, label: l.label })),
    ],
    [genEditUpload, genSceneVideoLayers],
  )
  const onSelectEditSource = (v: string) => {
    if (v === 'upload') {
      videoEditClipInputRef.current?.click()
      return
    }
    setGenEditSrc(v)
    if (v !== 'none') setGenExtendSrc('none') // mutually exclusive with extend (see onSelectExtendSource)
  }
  // Reset the i2v + keyframe/extend/edit sources on scene/format change: a `layer:<id>` source points
  // at the OLD scene's layer after a scene switch, and the pill would show a stale label.
  useEffect(() => {
    setGenVideoSrc('none')
    setGenVideoUpload(null)
    setGenVideoEndSrc('none')
    setGenVideoEndUpload(null)
    setGenExtendSrc('none')
    setGenExtendUpload(null)
    setGenEditSrc('none')
    setGenEditUpload(null)
  }, [selectedSceneId, genFormat])
  // Camera move + intensity (video). 'none' = no camera clause; startVideo compiles the rest.
  const [genCameraMove, setGenCameraMove] = useState<CameraChoice>('none')
  const [genCameraIntensity, setGenCameraIntensity] = useState(0.5)
  const [genEffect, setGenEffect] = useState('') // Tier 2 (#8): VFX effect preset id ('' = none)
  const [genLensPreset, setGenLensPreset] = useState('') // cinematic optics preset id ('' = default)
  // Lipsync provider (face + narration → talking video). The face reuses the image-source picker.
  const [genLipsyncModel, setGenLipsyncModel] = useState('musetalk')
  // The image-source picker (genVideoSrc/...) is shown for video-i2v AND lipsync (the face).
  const showGenImageSource = (genFormat === 'video' && videoModelSupportsI2v) || genFormat === 'lipsync'
  // Lipsync narration: a SERVER TTS provider (free browser providers can't make a file) + a voice.
  const lipsyncTtsModels = useMemo(() => audioModelsForSubType('tts').filter((m) => m.apiName !== null), [])
  const [genLipsyncTtsModel, setGenLipsyncTtsModel] = useState(() => lipsyncTtsModels[0]?.id ?? 'elevenlabs')
  const effectiveLipsyncTts = lipsyncTtsModels.some((m) => m.id === genLipsyncTtsModel)
    ? genLipsyncTtsModel
    : (lipsyncTtsModels[0]?.id ?? 'elevenlabs')
  // The TTS provider whose voices to load: the Audio→Voice sub-type, OR the lipsync narration
  // provider. Shared genVoices/genVoiceId — only one format is active at a time.
  const voiceProviderId =
    genFormat === 'lipsync'
      ? effectiveLipsyncTts
      : genFormat === 'audio' && genAudioKind === 'tts'
        ? effectiveAudioModel
        : ''
  // Load voices for the active TTS provider. Free/browser providers may return an empty list — the
  // voice pill then hides and the provider's default voice is used.
  useEffect(() => {
    // Reset the selected voice whenever the provider changes — a voiceId is provider-specific, so
    // carrying it across a switch would send a foreign id while the pill shows "Default".
    setGenVoiceId('')
    if (!voiceProviderId) {
      setGenVoices([])
      return
    }
    const api = typeof window !== 'undefined' ? window.dreambyteApi?.tts : undefined
    if (!api) return
    let cancelled = false
    api
      .listVoices(voiceProviderId as Parameters<typeof api.listVoices>[0])
      .then((res) => {
        if (cancelled) return
        const voices = (res.voices as { id?: string; name?: string }[]).flatMap((v) =>
          v.id ? [{ id: v.id, name: v.name || v.id }] : [],
        )
        setGenVoices(voices)
      })
      .catch(() => {
        if (!cancelled) setGenVoices([])
      })
    return () => {
      cancelled = true
    }
  }, [voiceProviderId])

  return {
    generateMode,
    setGenerateMode,
    genFormat,
    setGenFormat,
    genImageModels,
    genVideoModels,
    genModelsForFormat,
    genModel,
    setGenModel,
    effectiveGenModel,
    genSceneAgentLocked,
    genDuration,
    setGenDuration,
    genAspect,
    setGenAspect,
    effectiveGenAspect,
    genCharacterId,
    setGenCharacterId,
    genSeedText,
    setGenSeedText,
    genCharacters,
    genAudioKind,
    setGenAudioKind,
    genAudioModel,
    setGenAudioModel,
    genAudioModels,
    effectiveAudioModel,
    genVoiceId,
    setGenVoiceId,
    genVoices,
    genInFlightRef,
    videoModelSupportsI2v,
    genVideoSrc,
    setGenVideoSrc,
    genVideoUpload,
    setGenVideoUpload,
    videoImageInputRef,
    genSceneImageLayers,
    videoSourceItems,
    onSelectVideoSource,
    videoModelSupportsKeyframes,
    videoModelSupportsExtend,
    genVideoEndSrc,
    setGenVideoEndSrc,
    genVideoEndUpload,
    setGenVideoEndUpload,
    videoEndImageInputRef,
    genExtendSrc,
    setGenExtendSrc,
    genExtendUpload,
    setGenExtendUpload,
    videoClipInputRef,
    genSceneVideoLayers,
    videoEndSourceItems,
    videoExtendSourceItems,
    onSelectVideoEndSource,
    onSelectExtendSource,
    videoModelSupportsV2v,
    genEditSrc,
    setGenEditSrc,
    genEditUpload,
    setGenEditUpload,
    videoEditClipInputRef,
    genEditOp,
    setGenEditOp,
    videoEditSourceItems,
    onSelectEditSource,
    genCameraMove,
    setGenCameraMove,
    genCameraIntensity,
    setGenCameraIntensity,
    genEffect,
    setGenEffect,
    genLensPreset,
    setGenLensPreset,
    genLipsyncModel,
    setGenLipsyncModel,
    showGenImageSource,
    lipsyncTtsModels,
    genLipsyncTtsModel,
    setGenLipsyncTtsModel,
    effectiveLipsyncTts,
    voiceProviderId,
  }
}
