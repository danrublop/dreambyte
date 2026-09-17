'use client'

import { useState } from 'react'
import {
  ChevronDown,
  Check,
  Image as ImageIcon,
  Video,
  Music,
  Mic,
  AudioWaveform,
  UserRound,
  Sparkles,
  Aperture,
  type LucideIcon,
} from 'lucide-react'
import type { AudioSubType } from '@/lib/audio/audio-models'
import type { GenFormat, GenCharacterOption, CameraChoice } from '@/lib/hooks/use-generate-composer'
import { EFFECT_PRESETS } from '@/lib/media/effects'
import { OPTICS_PRESETS } from '@/lib/media/optics'
import { maxDurationFor } from '@/lib/media/model-catalog'
import type { VideoEditOperation } from '@/lib/media/video-edit'

// Tier 2 (#4): human labels for the in-video edit operations (the value is the catalog operation id).
const EDIT_OP_LABELS: { value: VideoEditOperation; label: string }[] = [
  { value: 'restyle', label: 'Restyle' },
  { value: 'relight', label: 'Relight' },
  { value: 'add-object', label: 'Add object' },
  { value: 'remove-object', label: 'Remove object' },
  { value: 'new-angle', label: 'New camera angle' },
  { value: 'replace-bg', label: 'Replace background' },
]

// Duration options for a video model — the standard 5/8, plus 10s when the model's
// per-row cap allows it (fal models go to 10; Veo stays 5/8).
// maxDurationFor folds in the catalog lookup + the shared `?? 8` misconfig fallback.
function durationOptionsFor(modelId: string): number[] {
  const max = maxDurationFor(modelId)
  return [5, 8, 10].filter((s) => s <= max)
}

// Camera move picker (video only). 'none' = no camera clause. Order groups the cinematic moves the
// way Higgsfield does: push/pull, orbit, pan, tilt, crane, then the punchy ones.
const CAMERA_MOVES: { value: CameraChoice; label: string }[] = [
  { value: 'none', label: 'No camera move' },
  { value: 'static', label: 'Locked / static' },
  { value: 'dolly-in', label: 'Dolly in' },
  { value: 'dolly-out', label: 'Dolly out' },
  { value: 'orbit-left', label: 'Orbit left' },
  { value: 'orbit-right', label: 'Orbit right' },
  { value: 'pan-left', label: 'Pan left' },
  { value: 'pan-right', label: 'Pan right' },
  { value: 'tilt-up', label: 'Tilt up' },
  { value: 'tilt-down', label: 'Tilt down' },
  { value: 'crane-up', label: 'Crane up' },
  { value: 'crane-down', label: 'Crane down' },
  { value: 'crash-zoom-in', label: 'Crash zoom in' },
  { value: 'crash-zoom-out', label: 'Crash zoom out' },
  { value: 'fpv-drone', label: 'FPV drone' },
]
const CAMERA_INTENSITY: { value: number; label: string }[] = [
  { value: 0.25, label: 'Subtle' },
  { value: 0.5, label: 'Smooth' },
  { value: 0.75, label: 'Brisk' },
  { value: 1, label: 'Intense' },
]

// Cinema Studio composer. Rendered inside the agent-chat input when the Generate toggle is
// on. Uses the SAME pill + dropdown-menu language as the agent run-mode / model pickers so the two
// modes feel like one input. Two surfaces:
//   - <GenerateComposer>  → the bottom toolbar bar: Format (icon) + Model pills (replaces the agent pills).
//   - <GenerateParams>    → a row ABOVE the prompt: Character + Seed.
// Image-first; video/audio are visible (as icons) but disabled until their pipelines land.

// Lipsync providers (fal avatar models that do face + audio → talking video). FAL_KEY-gated at runtime.
export const LIPSYNC_MODELS: GenModelOption[] = [
  { id: 'musetalk', label: 'MuseTalk', costCents: 4 },
  { id: 'aurora', label: 'Aurora', costCents: 5 },
  { id: 'fabric', label: 'Fabric 1.0', costCents: 8 },
]

export interface GenModelOption {
  id: string
  label: string
  costCents: number | null
}

const FORMAT_ICON: Record<GenFormat, LucideIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  lipsync: UserRound,
}
const FORMATS: { id: GenFormat; label: string; enabled: boolean }[] = [
  { id: 'image', label: 'Image', enabled: true },
  { id: 'video', label: 'Video', enabled: true },
  { id: 'audio', label: 'Audio', enabled: true },
  { id: 'lipsync', label: 'Lipsync', enabled: true },
]
// Audio sub-type pill (shown only when format = audio). Voice = TTS narration, SFX = sound
// effect, Music = generative background track. The model pill below follows the sub-type.
const AUDIO_SUBTYPES: { id: AudioSubType; label: string; Icon: LucideIcon }[] = [
  { id: 'tts', label: 'Voice', Icon: Mic },
  { id: 'sfx', label: 'SFX', Icon: AudioWaveform },
  { id: 'music', label: 'Music', Icon: Music },
]
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const
// Video only supports these three (the Veo3 layer's aspectRatio union); don't offer ratios that
// would silently coerce to 16:9 at generate time.
const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const

// ── Shared pill + dropdown menu (mirrors the agent run-mode picker) ────────────

interface MenuItem {
  value: string
  label: string
  Icon?: LucideIcon
  disabled?: boolean
  hint?: string
}

function PillMenu({
  trigger,
  items,
  value,
  onSelect,
  title,
  variant = 'bordered',
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  value: string
  onSelect: (v: string) => void
  title?: string
  variant?: 'bordered' | 'plain'
}) {
  const [open, setOpen] = useState(false)
  const btnCls =
    variant === 'bordered'
      ? `no-style !flex items-center gap-1 px-2.5 transition-all rounded-full whitespace-nowrap h-7 box-border ${
          open
            ? 'bg-[var(--color-bg)] border border-[var(--color-border)]/50'
            : 'bg-[var(--color-bg)]/80 border border-[var(--color-border)]/30 hover:border-[var(--color-border)]'
        }`
      : 'no-style !flex items-center gap-1 px-1.5 transition-all rounded-md whitespace-nowrap h-7 border border-transparent box-border'
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={btnCls}
        style={{ color: open ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
        title={title}
      >
        {trigger}
        <ChevronDown size={10} strokeWidth={2.5} className="opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-[calc(100%+8px)] left-0 z-[100] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-lg shadow-2xl flex flex-col w-max min-w-[180px] animate-in slide-in-from-bottom-1 duration-150"
            style={{ padding: 4 }}
          >
            {items.map((it) => {
              const active = it.value === value
              return (
                <button
                  key={it.value}
                  type="button"
                  disabled={it.disabled}
                  onClick={() => {
                    if (it.disabled) return
                    onSelect(it.value)
                    setOpen(false)
                  }}
                  onMouseEnter={(e) => {
                    if (!it.disabled)
                      e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                  className="w-full !flex !flex-row items-center no-style cursor-pointer text-left disabled:cursor-default disabled:opacity-45"
                  style={{
                    gap: 8,
                    padding: '5px 8px',
                    borderRadius: 6,
                    transition: 'background 0.12s ease',
                    background: 'transparent',
                  }}
                >
                  {it.Icon && (
                    <it.Icon
                      size={14}
                      strokeWidth={2}
                      className="flex-shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    />
                  )}
                  <span
                    className="flex-1 whitespace-nowrap"
                    style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1, color: 'var(--color-text-primary)' }}
                  >
                    {it.label}
                  </span>
                  {it.hint && (
                    <span style={{ fontSize: 11, lineHeight: 1, color: 'var(--color-text-muted)' }}>{it.hint}</span>
                  )}
                  {active && (
                    <Check
                      size={13}
                      strokeWidth={2.5}
                      className="flex-shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    />
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Bottom bar: Format (icon) + Model ─────────────────────────────────────────

export function GenerateComposer(props: {
  format: GenFormat
  setFormat: (f: GenFormat) => void
  model: string
  setModel: (m: string) => void
  models: GenModelOption[]
  hasCharacter: boolean
  duration: number
  setDuration: (d: number) => void
  // Audio (format = 'audio'): sub-type + audio model + (Voice only) voice pickers.
  audioKind: AudioSubType
  setAudioKind: (k: AudioSubType) => void
  audioModel: string
  setAudioModel: (m: string) => void
  audioModels: GenModelOption[]
  voices: { id: string; name: string }[]
  voiceId: string
  setVoiceId: (id: string) => void
  // Lipsync (format = 'lipsync'): provider model pill.
  lipsyncModel: string
  setLipsyncModel: (m: string) => void
}) {
  const {
    format,
    setFormat,
    model,
    setModel,
    models,
    hasCharacter,
    duration,
    setDuration,
    audioKind,
    setAudioKind,
    audioModel,
    setAudioModel,
    audioModels,
    voices,
    voiceId,
    setVoiceId,
    lipsyncModel,
    setLipsyncModel,
  } = props
  const FormatIcon = FORMAT_ICON[format]
  const modelLabel = models.find((m) => m.id === model)?.label ?? 'Model'
  // Model pill shows for video always, and for image unless a character (which owns its model) is set.
  const showModel = format === 'video' || (format === 'image' && !hasCharacter)
  const audioSub = AUDIO_SUBTYPES.find((s) => s.id === audioKind) ?? AUDIO_SUBTYPES[0]
  const AudioSubIcon = audioSub.Icon
  const audioModelLabel = audioModels.find((m) => m.id === audioModel)?.label ?? 'Model'
  const voiceLabel = voices.find((v) => v.id === voiceId)?.name ?? 'Default voice'
  const lipsyncModelLabel = LIPSYNC_MODELS.find((m) => m.id === lipsyncModel)?.label ?? 'Model'

  return (
    <div className="flex items-center gap-2 min-w-0">
      <PillMenu
        title="Format"
        value={format}
        onSelect={(v) => setFormat(v as GenFormat)}
        trigger={<FormatIcon size={18} strokeWidth={2.5} />}
        items={FORMATS.map((f) => ({
          value: f.id,
          label: f.label,
          Icon: FORMAT_ICON[f.id],
          disabled: !f.enabled,
          hint: f.enabled ? undefined : 'soon',
        }))}
      />

      {/* Audio: sub-type + model (+ voice for TTS). Replaces the image/video model pill. */}
      {format === 'audio' && (
        <>
          <PillMenu
            title="Audio type"
            variant="plain"
            value={audioKind}
            onSelect={(v) => setAudioKind(v as AudioSubType)}
            trigger={
              <>
                <AudioSubIcon size={14} strokeWidth={2} />
                <span className="font-semibold text-sm leading-none">{audioSub.label}</span>
              </>
            }
            items={AUDIO_SUBTYPES.map((s) => ({ value: s.id, label: s.label, Icon: s.Icon }))}
          />
          <PillMenu
            title="Model"
            variant="plain"
            value={audioModel}
            onSelect={setAudioModel}
            trigger={<span className="font-medium text-[12.5px] leading-none">{audioModelLabel}</span>}
            items={audioModels.map((m) => ({
              value: m.id,
              label: m.label,
              hint: m.costCents != null ? `~${m.costCents}¢` : 'free',
            }))}
          />
          {audioKind === 'tts' && voices.length > 0 && (
            <PillMenu
              title="Voice"
              variant="plain"
              value={voiceId}
              onSelect={setVoiceId}
              trigger={<span className="font-medium text-[12.5px] leading-none">{voiceLabel}</span>}
              items={[{ value: '', label: 'Default voice' }, ...voices.map((v) => ({ value: v.id, label: v.name }))]}
            />
          )}
        </>
      )}

      {showModel && (
        <PillMenu
          title="Model"
          variant="plain"
          value={model}
          onSelect={setModel}
          trigger={<span className="font-semibold text-sm leading-none">{modelLabel}</span>}
          items={models.map((m) => ({
            value: m.id,
            label: m.label,
            hint: m.costCents != null ? `~${m.costCents}¢` : undefined,
          }))}
        />
      )}

      {/* Lipsync: pick the avatar provider (face + audio → talking video). */}
      {format === 'lipsync' && (
        <PillMenu
          title="Lipsync model"
          variant="plain"
          value={lipsyncModel}
          onSelect={setLipsyncModel}
          trigger={<span className="font-semibold text-sm leading-none">{lipsyncModelLabel}</span>}
          items={LIPSYNC_MODELS.map((m) => ({
            value: m.id,
            label: m.label,
            hint: m.costCents != null ? `~${m.costCents}¢` : undefined,
          }))}
        />
      )}

      {/* Duration — video only. Tier 2 (#5): options run up to the selected model's per-row cap
          (Veo 5/8, fal models to 10s) instead of a hard-coded 5/8. */}
      {format === 'video' && (
        <PillMenu
          title="Duration"
          value={String(duration)}
          onSelect={(v) => setDuration(Number(v))}
          trigger={<span className="font-medium text-[12.5px] leading-none">{duration}s</span>}
          items={durationOptionsFor(model).map((s) => ({ value: String(s), label: `${s} seconds` }))}
        />
      )}
    </div>
  )
}

// ── Above-prompt params row: Character + Aspect + Seed ────────────────────────

export interface GenVideoSourceOption {
  value: string // 'none' | 'frame' | 'upload' | `layer:<id>`
  label: string
}

export function GenerateParams(props: {
  format: GenFormat
  characters: GenCharacterOption[]
  characterId: string
  setCharacterId: (id: string) => void
  aspectRatio: string
  setAspectRatio: (a: string) => void
  seedText: string
  setSeedText: (s: string) => void
  // i2v (video only): "From image" source picker — shown when the chosen model supports i2v.
  videoI2vEnabled: boolean
  videoSource: string
  videoSourceItems: GenVideoSourceOption[]
  onSelectVideoSource: (v: string) => void
  // Tier 2 (#5) keyframes (video only): an END-frame source, shown when the model supports keyframes
  // AND a start frame is picked. With a start frame, routes to the provider's start+end endpoint.
  videoKeyframesEnabled: boolean
  videoEndSource: string
  videoEndSourceItems: GenVideoSourceOption[]
  onSelectVideoEndSource: (v: string) => void
  // Tier 2 (#5) extend (video only): a source CLIP to continue, shown when the model supports extend.
  videoExtendEnabled: boolean
  videoExtendSource: string
  videoExtendSourceItems: GenVideoSourceOption[]
  onSelectExtendSource: (v: string) => void
  // Tier 2 (#4) edit / video→video (video only): a source CLIP to transform + the edit operation,
  // shown when the model supports v2v (Runway Aleph / LTX / Wan). The main prompt is the instruction.
  videoEditEnabled: boolean
  videoEditSource: string
  videoEditSourceItems: GenVideoSourceOption[]
  onSelectEditSource: (v: string) => void
  editOperation: VideoEditOperation
  setEditOperation: (op: VideoEditOperation) => void
  // Camera (video only): a move + intensity. Compiled into the prompt by startVideo.
  cameraMove: CameraChoice
  setCameraMove: (m: CameraChoice) => void
  cameraIntensity: number
  setCameraIntensity: (i: number) => void
  // Tier 2 (#8) effect (video only): a VFX preset id ('' = none), compiled into the prompt.
  effect: string
  setEffect: (e: string) => void
  // Phase 3 optics (video only): a cinematic lens preset id ('' = default), compiled into the prompt.
  lensPreset: string
  setLensPreset: (v: string) => void
  // Lipsync (format = 'lipsync'): narration TTS provider + voice for the spoken track.
  lipsyncTtsModel: string
  setLipsyncTtsModel: (m: string) => void
  lipsyncTtsModels: GenModelOption[]
  lipsyncVoices: { id: string; name: string }[]
  lipsyncVoiceId: string
  setLipsyncVoiceId: (id: string) => void
}) {
  const {
    format,
    characters,
    characterId,
    setCharacterId,
    aspectRatio,
    setAspectRatio,
    seedText,
    setSeedText,
    videoI2vEnabled,
    videoSource,
    videoSourceItems,
    onSelectVideoSource,
    videoKeyframesEnabled,
    videoEndSource,
    videoEndSourceItems,
    onSelectVideoEndSource,
    videoExtendEnabled,
    videoExtendSource,
    videoExtendSourceItems,
    onSelectExtendSource,
    videoEditEnabled,
    videoEditSource,
    videoEditSourceItems,
    onSelectEditSource,
    editOperation,
    setEditOperation,
    cameraMove,
    setCameraMove,
    effect,
    setEffect,
    lensPreset,
    setLensPreset,
    cameraIntensity,
    setCameraIntensity,
    lipsyncTtsModel,
    setLipsyncTtsModel,
    lipsyncTtsModels,
    lipsyncVoices,
    lipsyncVoiceId,
    setLipsyncVoiceId,
  } = props
  if (format === 'audio') return null
  const selected = characters.find((c) => c.id === characterId) ?? null
  const videoSourceLabel = videoSourceItems.find((s) => s.value === videoSource)?.label ?? 'From image'
  const videoEndSourceLabel = videoEndSourceItems.find((s) => s.value === videoEndSource)?.label ?? 'No end frame'
  const videoExtendSourceLabel = videoExtendSourceItems.find((s) => s.value === videoExtendSource)?.label ?? 'No clip'
  const videoEditSourceLabel = videoEditSourceItems.find((s) => s.value === videoEditSource)?.label ?? 'No clip'
  const editOperationLabel = EDIT_OP_LABELS.find((o) => o.value === editOperation)?.label ?? 'Restyle'
  const cameraLabel = CAMERA_MOVES.find((m) => m.value === cameraMove)?.label ?? 'Camera'
  const effectLabel = EFFECT_PRESETS.find((e) => e.id === effect)?.label ?? 'No effect'
  const lensLabel = OPTICS_PRESETS[lensPreset]?.label ?? 'Default lens'
  const intensityLabel = CAMERA_INTENSITY.find((i) => i.value === cameraIntensity)?.label ?? 'Smooth'
  const lipsyncTtsLabel = lipsyncTtsModels.find((m) => m.id === lipsyncTtsModel)?.label ?? 'Voice provider'
  const lipsyncVoiceLabel = lipsyncVoices.find((v) => v.id === lipsyncVoiceId)?.name ?? 'Default voice'

  return (
    <div className="flex items-center gap-2 px-4 pt-2 pb-1 flex-wrap">
      {/* Image source — i2v ("animate from image") for video, or the face for lipsync (required). */}
      {(format === 'video' || format === 'lipsync') && videoI2vEnabled && (
        <PillMenu
          title={format === 'lipsync' ? 'Face image' : 'Animate from image (image-to-video)'}
          value={videoSource}
          onSelect={onSelectVideoSource}
          trigger={
            <>
              <ImageIcon size={13} strokeWidth={2} />
              <span className="font-medium text-[12.5px] leading-none">
                {format === 'lipsync' && videoSource === 'none' ? 'Pick a face…' : videoSourceLabel}
              </span>
            </>
          }
          items={videoSourceItems.map((s) => ({ value: s.value, label: s.label }))}
        />
      )}

      {/* Tier 2 (#5) keyframes: END frame — only after a start frame is chosen (the provider
          interpolates start→end). Hidden until then so it can't be set without a start. */}
      {format === 'video' && videoKeyframesEnabled && videoI2vEnabled && videoSource !== 'none' && (
        <PillMenu
          title="End frame (keyframe)"
          value={videoEndSource}
          onSelect={onSelectVideoEndSource}
          trigger={
            <>
              <ImageIcon size={13} strokeWidth={2} />
              <span className="font-medium text-[12.5px] leading-none">{videoEndSourceLabel}</span>
            </>
          }
          items={videoEndSourceItems.map((s) => ({ value: s.value, label: s.label }))}
        />
      )}

      {/* Tier 2 (#5) extend: continue a source clip (video→video). */}
      {format === 'video' && videoExtendEnabled && (
        <PillMenu
          title="Extend a clip (video-to-video)"
          value={videoExtendSource}
          onSelect={onSelectExtendSource}
          trigger={
            <>
              <Video size={13} strokeWidth={2} />
              <span className="font-medium text-[12.5px] leading-none">{videoExtendSourceLabel}</span>
            </>
          }
          items={videoExtendSourceItems.map((s) => ({ value: s.value, label: s.label }))}
        />
      )}

      {/* Tier 2 (#4) edit / video→video (Aleph): pick a clip to transform; the prompt is the
          instruction. The operation picker appears once a clip is chosen. */}
      {format === 'video' && videoEditEnabled && (
        <PillMenu
          title="Edit a clip (restyle / relight / …)"
          value={videoEditSource}
          onSelect={onSelectEditSource}
          trigger={
            <>
              <Video size={13} strokeWidth={2} />
              <span className="font-medium text-[12.5px] leading-none">{videoEditSourceLabel}</span>
            </>
          }
          items={videoEditSourceItems.map((s) => ({ value: s.value, label: s.label }))}
        />
      )}
      {format === 'video' && videoEditEnabled && videoEditSource !== 'none' && (
        <PillMenu
          title="Edit operation"
          value={editOperation}
          onSelect={(v) => setEditOperation(v as VideoEditOperation)}
          trigger={<span className="font-medium text-[12.5px] leading-none">{editOperationLabel}</span>}
          items={EDIT_OP_LABELS.map((o) => ({ value: o.value, label: o.label }))}
        />
      )}

      {format === 'image' && (
        <PillMenu
          title="Character"
          value={characterId}
          onSelect={setCharacterId}
          trigger={
            <>
              <UserRound size={13} strokeWidth={2} />
              <span className="font-medium text-[12.5px] leading-none">
                {selected ? selected.name : 'No character'}
              </span>
            </>
          }
          items={[
            { value: '', label: 'No character' },
            ...characters.map((c) => ({ value: c.id, label: c.name, hint: c.hasReference ? undefined : 'no ref' })),
          ]}
        />
      )}

      <PillMenu
        title="Aspect ratio"
        value={aspectRatio}
        onSelect={setAspectRatio}
        trigger={<span className="font-medium text-[12.5px] leading-none">{aspectRatio}</span>}
        items={(format === 'video' ? VIDEO_ASPECTS : ASPECTS).map((a) => ({ value: a, label: a }))}
      />

      {/* Camera move + intensity — video only. Compiled into the prompt by startVideo. */}
      {format === 'video' && (
        <>
          <PillMenu
            title="Camera move"
            value={cameraMove}
            onSelect={(v) => setCameraMove(v as CameraChoice)}
            trigger={
              <>
                <Video size={13} strokeWidth={2} />
                <span className="font-medium text-[12.5px] leading-none">{cameraLabel}</span>
              </>
            }
            items={CAMERA_MOVES.map((m) => ({ value: m.value, label: m.label }))}
          />
          {cameraMove !== 'none' && cameraMove !== 'static' && (
            <PillMenu
              title="Camera intensity"
              value={String(cameraIntensity)}
              onSelect={(v) => setCameraIntensity(Number(v))}
              trigger={<span className="font-medium text-[12.5px] leading-none">{intensityLabel}</span>}
              items={CAMERA_INTENSITY.map((i) => ({ value: String(i.value), label: i.label }))}
            />
          )}
          {/* Tier 2 (#8): VFX effect preset — applied on top of the prompt. */}
          <PillMenu
            title="Effect"
            value={effect}
            onSelect={setEffect}
            trigger={
              <>
                <Sparkles size={13} strokeWidth={2} />
                <span className="font-medium text-[12.5px] leading-none">{effectLabel}</span>
              </>
            }
            items={[{ value: '', label: 'No effect' }, ...EFFECT_PRESETS.map((e) => ({ value: e.id, label: e.label }))]}
          />
          {/* Cinematic optics (lens/film/DOF) preset — compiled into the prompt by startVideo. */}
          <PillMenu
            title="Lens"
            value={lensPreset}
            onSelect={setLensPreset}
            trigger={
              <>
                <Aperture size={13} strokeWidth={2} />
                <span className="font-medium text-[12.5px] leading-none">{lensLabel}</span>
              </>
            }
            items={[
              { value: '', label: 'Default lens' },
              ...Object.entries(OPTICS_PRESETS).map(([id, p]) => ({ value: id, label: p.label })),
            ]}
          />
        </>
      )}

      {/* Lipsync: the narration voice (server TTS provider + voice). */}
      {format === 'lipsync' && (
        <>
          <PillMenu
            title="Voice provider"
            value={lipsyncTtsModel}
            onSelect={setLipsyncTtsModel}
            trigger={<span className="font-medium text-[12.5px] leading-none">{lipsyncTtsLabel}</span>}
            items={lipsyncTtsModels.map((m) => ({ value: m.id, label: m.label }))}
          />
          {lipsyncVoices.length > 0 && (
            <PillMenu
              title="Voice"
              value={lipsyncVoiceId}
              onSelect={setLipsyncVoiceId}
              trigger={<span className="font-medium text-[12.5px] leading-none">{lipsyncVoiceLabel}</span>}
              items={[
                { value: '', label: 'Default voice' },
                ...lipsyncVoices.map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          )}
        </>
      )}

      {/* Manual seed — video, or raw image (a character owns its seed); not lipsync. */}
      {(format === 'video' || (format === 'image' && !selected)) && (
        <input
          value={seedText}
          onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="Seed"
          inputMode="numeric"
          className="no-style h-7 w-[64px] rounded-full bg-[var(--color-bg)]/80 border border-[var(--color-border)]/30 px-2.5 text-[12.5px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border)]"
          title="Pin a seed to reproduce the image"
        />
      )}
    </div>
  )
}

export default GenerateComposer
