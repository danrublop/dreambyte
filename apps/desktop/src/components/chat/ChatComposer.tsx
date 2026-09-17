'use client'

import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Loader2, GitBranch, Clapperboard, X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { useComposerInput } from '@/lib/hooks/use-composer-input'
import type { useGenerateComposer } from '@/lib/hooks/use-generate-composer'
import type { useBranches } from '@/lib/hooks/use-branches'
import type { ImageAttachment, ReferenceMedia } from '@/lib/agents/types'
import type { PreviewImage } from './ImageLightbox'
import { SendIcon, AttachMediaIcon } from './composer-shared'
import { SpeechWaveformLangControl } from './voice-input'
import { ComposerModelAgentControls } from './ComposerModelAgentControls'
import { insertMention } from '@/lib/scene-mentions'
import { ComposerAttachmentChips, type PastedText } from './ComposerAttachmentChips'
import { PastedTextModal } from './PastedTextModal'
import { GenerateComposer, GenerateParams } from '../cinema/GenerateComposer'
import { composerDisabled, composerSteerPlaceholder, historyCliffNote } from '@/lib/agents/steer-ui'

/** A paste at/above this many chars becomes a chip instead of inline text. */
const PASTE_CHIP_THRESHOLD = 1500

/** Attach / voice / send — align with secondary text; circle uses a light mix on the panel background */
const COMPOSER_CTRL_ICON = 'var(--color-text-muted)'
const COMPOSER_CTRL_BG = 'color-mix(in srgb, var(--color-text-muted) 28%, var(--color-bg))'

type PendingAssetRef = { id: string; name: string; type: string; publicUrl: string }

interface ChatComposerProps {
  composer: ReturnType<typeof useComposerInput>
  gen: ReturnType<typeof useGenerateComposer>
  isGenerating: boolean
  /** Live execution stats for the in-flight run (null when idle). Drives the
   *  live session-usage counter so cost/tokens update DURING a run, not only
   *  after it finishes. */
  runProgress: {
    toolCallsUsed: number
    toolCallsMax: number
    costUsd: number
    costMax: number
    inputTokens: number
    outputTokens: number
  } | null
  isAgentRunningRemote: boolean
  steerReady: boolean
  handleSend: () => void | Promise<void>
  handleAbort: () => void
  routeAttachedFile: (file: File) => void | Promise<void>
  imageInputRef: RefObject<HTMLInputElement>
  pendingImages: ImageAttachment[]
  setPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>
  pendingAssetRefs: PendingAssetRef[]
  setPendingAssetRefs: Dispatch<SetStateAction<PendingAssetRef[]>>
  pendingReferenceMedia: ReferenceMedia[]
  setPendingReferenceMedia: Dispatch<SetStateAction<ReferenceMedia[]>>
  pendingPastedTexts: PastedText[]
  setPendingPastedTexts: Dispatch<SetStateAction<PastedText[]>>
  uploadingAssets: Record<string, { name: string; pct: number }>
  setPreviewImage: Dispatch<SetStateAction<PreviewImage | null>>
  variantsCount: number
  setVariantsCount: Dispatch<SetStateAction<number>>
  branches: ReturnType<typeof useBranches>
  activeBranch: ReturnType<typeof useBranches>[number] | undefined
  setShowBranchDropdown: Dispatch<SetStateAction<boolean>>
  cliffNote: ReturnType<typeof historyCliffNote>
  currentModel: { modelName: string }
}

/**
 * The chat composer (S2 slice 5d) — keyword-guard banner + the full input area
 * (drop zone, slash autocomplete, attachment chips, textarea, generate/model/
 * agent controls, voice, send/abort, variants, branch). Consumes the
 * useComposerInput + useGenerateComposer hooks (passed as objects, destructured
 * here so the JSX is verbatim). handleSend/handleAbort are called as-is — they
 * read the same hook state in AgentChat. Extracted with no visual/behavior change.
 */
export function ChatComposer({
  composer,
  gen,
  isGenerating,
  runProgress,
  isAgentRunningRemote,
  steerReady,
  handleSend,
  handleAbort,
  routeAttachedFile,
  imageInputRef,
  pendingImages,
  setPendingImages,
  pendingAssetRefs,
  setPendingAssetRefs,
  pendingReferenceMedia,
  setPendingReferenceMedia,
  pendingPastedTexts,
  setPendingPastedTexts,
  uploadingAssets,
  setPreviewImage,
  variantsCount,
  setVariantsCount,
  branches,
  activeBranch,
  setShowBranchDropdown,
  cliffNote,
  currentModel,
}: ChatComposerProps) {
  const toggleActiveTool = useVideoStore((s) => s.toggleActiveTool)
  // Showcase fence: block sends + show the exit affordance while the
  // dev fixture transcript is on screen (src/lib/store/showcase-actions.ts).
  const showcaseMode = useVideoStore((s) => s.showcaseMode)
  const exitShowcase = useVideoStore((s) => s.exitShowcase)
  const messages = useVideoStore((s) => s.chatMessages)

  // Session usage counter (live). Completed messages carry their own usage;
  // the in-flight run's spend lives in runProgress until `done` folds it into a
  // message — so add it while generating for a live total (no double-count: the
  // active message has no usage yet). The donut toggles cost ↔ tokens.
  const [usageMode, setUsageMode] = useState<'cost' | 'tokens'>('cost')
  // Which pasted-text chip is open in the preview/edit modal (null = none).
  const [editingPastedId, setEditingPastedId] = useState<string | null>(null)
  const editingPasted = pendingPastedTexts.find((p) => p.id === editingPastedId) ?? null
  const sessionCostUsd =
    messages.reduce((sum, m) => sum + (m.usage?.costUsd ?? 0), 0) +
    (isGenerating && runProgress ? runProgress.costUsd : 0)
  const sessionTokens =
    messages.reduce((sum, m) => sum + (m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0), 0) +
    (isGenerating && runProgress ? runProgress.inputTokens + runProgress.outputTokens : 0)
  const usageLabel =
    usageMode === 'cost'
      ? `$${sessionCostUsd.toFixed(4)} session usage`
      : `${sessionTokens.toLocaleString()} tokens session`
  const {
    input,
    setInput,
    slashIdx,
    setSlashIdx,
    slashSuggestions,
    showModelMenu,
    setShowModelMenu,
    mentionIdx,
    setMentionIdx,
    mentionSuggestions,
    showAgentMenu,
    setShowAgentMenu,
    keywordWarning,
    setKeywordWarning,
    isDraggingImage,
    setIsDraggingImage,
    isListening,
    speechSupported,
    speechLang,
    showSpeechLangMenu,
    setShowSpeechLangMenu,
    toggleVoiceInput,
    handleSelectSpeechLang,
  } = composer
  // The textarea auto-grows on input (onChange sets style.height from
  // scrollHeight). After a send clears `input`, the programmatic setInput doesn't
  // fire onChange, so the box keeps its tall height — reset it back to one row.
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!input && textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [input])
  const {
    generateMode,
    setGenerateMode,
    genFormat,
    setGenFormat,
    genModelsForFormat,
    effectiveGenModel,
    setGenModel,
    genCharacterId,
    setGenCharacterId,
    genSeedText,
    setGenSeedText,
    genCharacters,
    genDuration,
    setGenDuration,
    effectiveGenAspect,
    setGenAspect,
    genAudioKind,
    setGenAudioKind,
    effectiveAudioModel,
    setGenAudioModel,
    genAudioModels,
    genVoices,
    genVoiceId,
    setGenVoiceId,
    genLipsyncModel,
    setGenLipsyncModel,
    lipsyncTtsModels,
    effectiveLipsyncTts,
    setGenLipsyncTtsModel,
    showGenImageSource,
    videoModelSupportsKeyframes,
    videoModelSupportsExtend,
    videoModelSupportsV2v,
    genVideoSrc,
    setGenVideoSrc,
    setGenVideoUpload,
    genVideoEndSrc,
    setGenVideoEndSrc,
    setGenVideoEndUpload,
    genExtendSrc,
    setGenExtendSrc,
    setGenExtendUpload,
    genEditSrc,
    setGenEditSrc,
    setGenEditUpload,
    genEditOp,
    setGenEditOp,
    genCameraMove,
    setGenCameraMove,
    genCameraIntensity,
    setGenCameraIntensity,
    genEffect,
    setGenEffect,
    genLensPreset,
    setGenLensPreset,
    videoImageInputRef,
    videoEndImageInputRef,
    videoClipInputRef,
    videoEditClipInputRef,
    videoSourceItems,
    videoEndSourceItems,
    videoExtendSourceItems,
    videoEditSourceItems,
    onSelectVideoSource,
    onSelectVideoEndSource,
    onSelectExtendSource,
    onSelectEditSource,
  } = gen
  const canSend =
    !!input.trim() || pendingImages.length > 0 || pendingAssetRefs.length > 0 || pendingReferenceMedia.length > 0
  return (
    <>
      {/* Keyword warning */}
      {keywordWarning && (
        <div className="flex-shrink-0 px-4">
          <div className="mx-auto mb-1 w-full max-w-2xl">
            <div className="px-3 py-2 rounded-lg bg-amber-900/30 border border-amber-700/40 flex items-center gap-2 text-[12px]">
              <span className="text-amber-300 flex-1">
                <strong>{keywordWarning.label}</strong> is disabled for this chat.
              </span>
              <button
                onClick={() => {
                  toggleActiveTool(keywordWarning.capability)
                  setKeywordWarning(null)
                }}
                className="text-[11px] font-medium text-amber-200 hover:text-white px-2 py-0.5 rounded bg-amber-800/50 hover:bg-amber-700/60 transition-colors"
              >
                Enable
              </button>
              <button
                onClick={() => {
                  setKeywordWarning(null)
                  handleSend()
                }}
                className="text-[11px] text-amber-400/70 hover:text-amber-200 transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={() => setKeywordWarning(null)}
                className="text-amber-500/50 hover:text-amber-300 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 p-4 bg-gradient-to-t from-[var(--color-bg)] via-[var(--color-bg)] to-transparent pt-8">
        <div className="mx-auto w-full max-w-2xl">
          <div
            className={`relative border rounded-xl transition-all ${
              isDraggingImage
                ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/25'
                : 'border-[var(--color-border)]'
            }`}
            style={{ backgroundColor: 'var(--agent-chat-user-surface)' }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setIsDraggingImage(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setIsDraggingImage(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setIsDraggingImage(false)
              for (const file of Array.from(e.dataTransfer.files)) {
                routeAttachedFile(file)
              }
            }}
          >
            {/* Showcase banner: fixtures on screen, persistence fenced. */}
            {showcaseMode && (
              <div className="mx-1 mt-1 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5">
                <span className="text-[11px] text-amber-300">
                  Chat UI showcase active — styling fixtures, nothing is saved
                </span>
                <button
                  onClick={exitShowcase}
                  className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/20"
                >
                  Exit showcase
                </button>
              </div>
            )}
            {/* inner padding wrapper so the textarea/chips have p-1 spacing */}
            <div className="p-1">
              {/* Slash command autocomplete — above textarea */}
              {slashSuggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-bg)] shadow-lg overflow-hidden z-20">
                  <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    Slash commands
                  </div>
                  {slashSuggestions.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setInput(`/${cmd.name} `)
                        setSlashIdx(0)
                      }}
                      onMouseEnter={() => setSlashIdx(i)}
                      className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 transition-colors ${
                        i === slashIdx ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="text-[12px] font-mono text-[var(--color-text-primary)]">{cmd.usage}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)] truncate">{cmd.description}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Scene @-mention autocomplete — above textarea. Mirrors the
                  slash popover's container/row styling exactly. */}
              {mentionSuggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-bg)] shadow-lg overflow-hidden z-20">
                  <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                    Scenes & layers
                  </div>
                  {mentionSuggestions.map((sc, i) => (
                    <button
                      key={`${sc.kind}:${sc.id}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setInput(insertMention(input, sc.name))
                        setMentionIdx(0)
                      }}
                      onMouseEnter={() => setMentionIdx(i)}
                      className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 transition-colors ${
                        i === mentionIdx ? 'bg-white/5' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="text-[12px] text-[var(--color-text-primary)] truncate">@{sc.name}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)] truncate">{sc.detail}</span>
                    </button>
                  ))}
                </div>
              )}

              <ComposerAttachmentChips
                pendingImages={pendingImages}
                setPendingImages={setPendingImages}
                pendingAssetRefs={pendingAssetRefs}
                setPendingAssetRefs={setPendingAssetRefs}
                pendingReferenceMedia={pendingReferenceMedia}
                setPendingReferenceMedia={setPendingReferenceMedia}
                pendingPastedTexts={pendingPastedTexts}
                setPendingPastedTexts={setPendingPastedTexts}
                onEditPastedText={setEditingPastedId}
                uploadingAssets={uploadingAssets}
                setPreviewImage={setPreviewImage}
              />

              {editingPasted && (
                <PastedTextModal
                  text={editingPasted.text}
                  onSave={(next) => {
                    setPendingPastedTexts((prev) =>
                      prev.map((p) => (p.id === editingPasted.id ? { ...p, text: next } : p)),
                    )
                    setEditingPastedId(null)
                  }}
                  onClose={() => setEditingPastedId(null)}
                />
              )}

              {generateMode && (
                <GenerateParams
                  format={genFormat}
                  characters={genCharacters}
                  characterId={genCharacterId}
                  setCharacterId={setGenCharacterId}
                  aspectRatio={effectiveGenAspect}
                  setAspectRatio={setGenAspect}
                  seedText={genSeedText}
                  setSeedText={setGenSeedText}
                  videoI2vEnabled={showGenImageSource}
                  videoSource={genVideoSrc}
                  videoSourceItems={videoSourceItems}
                  onSelectVideoSource={onSelectVideoSource}
                  videoKeyframesEnabled={videoModelSupportsKeyframes}
                  videoEndSource={genVideoEndSrc}
                  videoEndSourceItems={videoEndSourceItems}
                  onSelectVideoEndSource={onSelectVideoEndSource}
                  videoExtendEnabled={videoModelSupportsExtend}
                  videoExtendSource={genExtendSrc}
                  videoExtendSourceItems={videoExtendSourceItems}
                  onSelectExtendSource={onSelectExtendSource}
                  videoEditEnabled={videoModelSupportsV2v}
                  videoEditSource={genEditSrc}
                  videoEditSourceItems={videoEditSourceItems}
                  onSelectEditSource={onSelectEditSource}
                  editOperation={genEditOp}
                  setEditOperation={setGenEditOp}
                  cameraMove={genCameraMove}
                  setCameraMove={setGenCameraMove}
                  effect={genEffect}
                  setEffect={setGenEffect}
                  lensPreset={genLensPreset}
                  setLensPreset={setGenLensPreset}
                  cameraIntensity={genCameraIntensity}
                  setCameraIntensity={setGenCameraIntensity}
                  lipsyncTtsModel={effectiveLipsyncTts}
                  setLipsyncTtsModel={setGenLipsyncTtsModel}
                  lipsyncTtsModels={lipsyncTtsModels}
                  lipsyncVoices={genVoices}
                  lipsyncVoiceId={genVoiceId}
                  setLipsyncVoiceId={setGenVoiceId}
                />
              )}
              {/* Hidden picker for the i2v "Upload…" source. */}
              <input
                ref={videoImageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') {
                      setGenVideoUpload({ dataUrl: reader.result, name: file.name })
                      setGenVideoSrc('upload')
                    }
                  }
                  reader.readAsDataURL(file)
                }}
              />
              {/* Tier 2 (#5): hidden picker for the keyframe END-frame "Upload…" source. */}
              <input
                ref={videoEndImageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') {
                      setGenVideoEndUpload({ dataUrl: reader.result, name: file.name })
                      setGenVideoEndSrc('upload')
                    }
                  }
                  reader.readAsDataURL(file)
                }}
              />
              {/* Tier 2 (#5): hidden picker for the extend source CLIP "Upload clip…" source. */}
              <input
                ref={videoClipInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') {
                      setGenExtendUpload({ dataUrl: reader.result, name: file.name })
                      setGenExtendSrc('upload')
                    }
                  }
                  reader.readAsDataURL(file)
                }}
              />
              {/* Tier 2 (#4): hidden picker for the edit source CLIP "Upload clip…" source. */}
              <input
                ref={videoEditClipInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') {
                      setGenEditUpload({ dataUrl: reader.result, name: file.name })
                      setGenEditSrc('upload')
                    }
                  }
                  reader.readAsDataURL(file)
                }}
              />

              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
                }}
                onKeyDown={(e) => {
                  // Slash autocomplete navigation — claim the keys before the
                  // submit handler runs, so Enter inserts a command instead of
                  // sending the partial "/he".
                  if (slashSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSlashIdx((i) => (i + 1) % slashSuggestions.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSlashIdx((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length)
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                      e.preventDefault()
                      const sel = slashSuggestions[slashIdx]
                      if (sel) {
                        setInput(`/${sel.name} `)
                        setSlashIdx(0)
                      }
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setInput('')
                      return
                    }
                  }
                  // Mention autocomplete navigation — same key-claiming contract
                  // as the slash menu above (Enter inserts, never sends).
                  if (mentionSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setMentionIdx((i) => (i + 1) % mentionSuggestions.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setMentionIdx((i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length)
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                      e.preventDefault()
                      const sel = mentionSuggestions[mentionIdx]
                      if (sel) {
                        setInput(insertMention(input, sel.name))
                        setMentionIdx(0)
                      }
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      // Dismiss by breaking the active token (trailing space), keep the text.
                      setInput(`${input} `)
                      return
                    }
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleSend()
                  } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                onPaste={(e) => {
                  // A LARGE text paste becomes an editable chip instead of dumping
                  // into the input (which overflows the composer and can blow the
                  // message length cap). Small pastes insert normally.
                  const pastedText = e.clipboardData?.getData('text/plain') ?? ''
                  if (pastedText.length >= PASTE_CHIP_THRESHOLD) {
                    e.preventDefault()
                    setPendingPastedTexts((prev) => [...prev, { id: crypto.randomUUID(), text: pastedText }])
                    return
                  }
                  const items = e.clipboardData?.items
                  if (!items) return
                  for (const item of Array.from(items)) {
                    if (item.kind !== 'file') continue
                    e.preventDefault()
                    const file = item.getAsFile()
                    if (file) routeAttachedFile(file)
                  }
                }}
                placeholder={
                  isAgentRunningRemote && !isGenerating
                    ? 'Agent running in another tab...'
                    : generateMode
                      ? genFormat === 'video'
                        ? 'Describe the video to generate...'
                        : genFormat === 'lipsync'
                          ? 'Type what the face should say...'
                          : genFormat === 'audio'
                            ? genAudioKind === 'tts'
                              ? 'Type narration to speak...'
                              : genAudioKind === 'sfx'
                                ? 'Describe a sound effect...'
                                : 'Describe the music...'
                            : genCharacterId
                              ? 'Describe the pose / scene for this character...'
                              : 'Describe the image to generate...'
                      : isGenerating
                        ? composerSteerPlaceholder(steerReady) // Honest about the pre-runId window
                        : pendingImages.length > 0
                          ? 'Add a message or send images...'
                          : 'Talk to Agent...'
                }
                disabled={showcaseMode || composerDisabled(isGenerating, isAgentRunningRemote)}
                className="w-full bg-transparent border-none focus:ring-0 focus:outline-none text-sm text-[var(--color-text-primary)] px-4 pt-2 pb-0 min-h-0 max-h-[200px] resize-none scrollbar-hide disabled:opacity-50"
                rows={1}
              />

              <div className="flex items-center justify-between px-3 pt-1 pb-1 gap-2">
                {!isListening ? (
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/webm,application/pdf,text/plain,text/markdown"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        for (const file of Array.from(e.target.files ?? [])) {
                          routeAttachedFile(file)
                        }
                        e.target.value = ''
                      }}
                    />

                    {generateMode ? (
                      <GenerateComposer
                        format={genFormat}
                        setFormat={setGenFormat}
                        model={effectiveGenModel}
                        setModel={setGenModel}
                        models={genModelsForFormat}
                        hasCharacter={!!genCharacterId}
                        duration={genDuration}
                        setDuration={setGenDuration}
                        audioKind={genAudioKind}
                        setAudioKind={setGenAudioKind}
                        audioModel={effectiveAudioModel}
                        setAudioModel={setGenAudioModel}
                        audioModels={genAudioModels}
                        voices={genVoices}
                        voiceId={genVoiceId}
                        setVoiceId={setGenVoiceId}
                        lipsyncModel={genLipsyncModel}
                        setLipsyncModel={setGenLipsyncModel}
                      />
                    ) : (
                      <ComposerModelAgentControls
                        currentModel={currentModel}
                        showAgentMenu={showAgentMenu}
                        setShowAgentMenu={setShowAgentMenu}
                        showModelMenu={showModelMenu}
                        setShowModelMenu={setShowModelMenu}
                        setShowSpeechLangMenu={setShowSpeechLangMenu}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <SpeechWaveformLangControl
                      active
                      speechSupported={speechSupported}
                      speechLang={speechLang}
                      showMenu={showSpeechLangMenu}
                      setShowMenu={setShowSpeechLangMenu}
                      onSelectLang={handleSelectSpeechLang}
                      onOpenMenu={() => {
                        setShowModelMenu(false)
                        setShowAgentMenu(false)
                      }}
                    />
                    <span className="text-[12px] text-[var(--color-text-muted)] truncate">Listening…</span>
                  </div>
                )}

                {/* Send / voice / stop */}
                <div className="flex items-center flex-shrink-0 relative gap-1.5 text-[var(--color-text-muted)]">
                  {/* Web research is now an ambient capability controlled in Settings ▸ Agents
                      (Web Search / Auto-Accept / Web Fetch) — no in-chat toggle. */}
                  {/* Generate toggle — flips the composer into media-generation mode */}
                  <button
                    type="button"
                    onClick={() => setGenerateMode(!generateMode)}
                    className={`no-style flex items-center justify-center rounded transition-colors ${
                      generateMode
                        ? 'bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/40'
                        : 'hover:bg-white/[0.06] border border-transparent'
                    }`}
                    style={{
                      width: 26,
                      height: 26,
                      color: generateMode ? 'var(--color-accent)' : COMPOSER_CTRL_ICON,
                    }}
                    data-tooltip={generateMode ? 'Generate mode: on' : 'Generate mode: off'}
                    data-tooltip-pos="top"
                    aria-label={generateMode ? 'Generate: on' : 'Generate: off'}
                    aria-pressed={generateMode}
                  >
                    <Clapperboard size={15} strokeWidth={2} />
                  </button>
                  <span
                    onClick={() => {
                      // Steers are text-only — no attaching mid-run.
                      if (isGenerating) return
                      imageInputRef.current?.click()
                    }}
                    className="flex items-center justify-center"
                    style={{
                      width: '26px',
                      height: '26px',
                      color: COMPOSER_CTRL_ICON,
                      cursor: isGenerating ? 'not-allowed' : 'pointer',
                      opacity: isGenerating ? 0.4 : 1,
                    }}
                    data-tooltip={isGenerating ? 'Attachments are disabled while the agent runs' : 'Attach image'}
                    data-tooltip-pos="top"
                  >
                    <AttachMediaIcon size={17} />
                  </span>
                  {isGenerating ? (
                    <span
                      onClick={handleAbort}
                      className="flex items-center justify-center cursor-pointer rounded-full transition-all duration-200"
                      style={{ width: '26px', height: '26px', backgroundColor: COMPOSER_CTRL_BG }}
                    >
                      <span
                        className="animate-pulse"
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          backgroundColor: COMPOSER_CTRL_ICON,
                          opacity: 0.85,
                        }}
                      />
                    </span>
                  ) : isListening ? (
                    <>
                      {canSend && (
                        <button
                          type="button"
                          onClick={handleSend}
                          aria-label="Send"
                          className="flex items-center justify-center transition-all cursor-pointer no-style rounded-full relative"
                          style={{
                            width: '30px',
                            height: '30px',
                            backgroundColor: COMPOSER_CTRL_BG,
                            padding: 0,
                            color: COMPOSER_CTRL_ICON,
                          }}
                          data-tooltip="Send"
                          data-tooltip-pos="top"
                        >
                          <SendIcon size={20} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleVoiceInput()}
                        aria-label="Stop listening"
                        className="flex items-center justify-center transition-all cursor-pointer no-style rounded-full"
                        style={{
                          width: '30px',
                          height: '30px',
                          backgroundColor: COMPOSER_CTRL_BG,
                          padding: 0,
                          color: COMPOSER_CTRL_ICON,
                        }}
                        data-tooltip="Stop listening"
                        data-tooltip-pos="top"
                      >
                        <Square size={11} strokeWidth={2.5} fill="currentColor" aria-hidden />
                      </button>
                    </>
                  ) : canSend ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setVariantsCount((c) => (c >= 4 ? 1 : c + 1))}
                        aria-label={`Variants: ${variantsCount}x — click to cycle`}
                        className="no-style flex items-center justify-center transition-all cursor-pointer rounded-full text-[10px] font-semibold"
                        style={{
                          width: '26px',
                          height: '26px',
                          backgroundColor: variantsCount > 1 ? COMPOSER_CTRL_BG : 'transparent',
                          color: variantsCount > 1 ? COMPOSER_CTRL_ICON : 'var(--color-text-muted)',
                          border: variantsCount > 1 ? 'none' : '1px solid var(--color-border)',
                          padding: 0,
                        }}
                        data-tooltip={
                          variantsCount > 1
                            ? `Send will spawn ${variantsCount} variants on new branches`
                            : 'Click to spawn multiple variants on new branches'
                        }
                        data-tooltip-pos="top"
                      >
                        {variantsCount}×
                      </button>
                      <button
                        type="button"
                        onClick={handleSend}
                        aria-label="Send"
                        className="flex items-center justify-center transition-all cursor-pointer no-style rounded-full relative"
                        style={{
                          width: '26px',
                          height: '26px',
                          backgroundColor: COMPOSER_CTRL_BG,
                          padding: 0,
                          color: COMPOSER_CTRL_ICON,
                        }}
                        data-tooltip={variantsCount > 1 ? `Send (${variantsCount} variants)` : 'Send'}
                        data-tooltip-pos="top"
                      >
                        <SendIcon size={20} aria-hidden />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => speechSupported && toggleVoiceInput()}
                      disabled={!speechSupported}
                      aria-label={speechSupported ? 'Voice input' : 'Voice input not supported'}
                      className={`flex items-center justify-center transition-all no-style rounded-full ${
                        speechSupported ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      }`}
                      style={{
                        width: '26px',
                        height: '26px',
                        backgroundColor: COMPOSER_CTRL_BG,
                        padding: 0,
                        color: COMPOSER_CTRL_ICON,
                      }}
                      data-tooltip={speechSupported ? 'Voice input' : 'Voice input not supported in this browser'}
                      data-tooltip-pos="top"
                    >
                      <Mic
                        size={16}
                        strokeWidth={2}
                        className={speechSupported ? 'opacity-90' : 'opacity-30'}
                        aria-hidden
                      />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {/* end p-1 inner padding */}
          </div>
          <div className="relative flex items-center gap-2 mt-2 px-1">
            {/* Session usage */}
            <div className="flex flex-1 min-w-0 items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              {isGenerating ? (
                <Loader2 size={12} strokeWidth={2} className="animate-spin opacity-60" />
              ) : (
                <svg
                  onClick={() => setUsageMode((m) => (m === 'cost' ? 'tokens' : 'cost'))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setUsageMode((m) => (m === 'cost' ? 'tokens' : 'cost'))
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label="Toggle session usage between cost and tokens"
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="opacity-60 shrink-0 cursor-pointer hover:opacity-100 transition-opacity"
                >
                  <title>
                    {usageMode === 'cost' ? 'Showing cost — click for tokens' : 'Showing tokens — click for cost'}
                  </title>
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M2.92377 10.2064C2.80976 10.7866 2.75 11.3863 2.75 12C2.75 12.2264 2.75814 12.451 2.77413 12.6733C2.79516 12.6904 2.81728 12.7083 2.84044 12.7268C3.06058 12.9028 3.37094 13.1369 3.73188 13.3698C4.4894 13.8584 5.33178 14.25 6 14.25C6.43561 14.25 6.9638 14.0813 7.51796 13.8023C7.85469 13.6327 8.17653 13.435 8.46068 13.2423C8.32421 12.8535 8.25 12.4354 8.25 12C8.25 9.92893 9.92893 8.25 12 8.25C14.0711 8.25 15.75 9.92893 15.75 12C15.75 12.7595 15.5242 13.4662 15.1361 14.0568C15.1836 14.0826 15.2334 14.1095 15.2856 14.1377C15.3054 14.1484 15.3255 14.1592 15.3459 14.1703C15.6383 14.3283 16.013 14.5325 16.3261 14.7866C16.9868 14.6782 17.6623 14.7793 18.216 15.1298C18.4093 14.7699 18.6888 14.4463 19.0327 14.1919C19.6351 13.7465 20.3998 13.5477 21.0993 13.6723C21.1983 13.1303 21.25 12.5715 21.25 12C21.25 11.5465 21.2174 11.1007 21.1543 10.6647L19.4953 12.1257C19.1845 12.3995 18.7106 12.3694 18.4368 12.0586C18.163 11.7477 18.1931 11.2738 18.504 11L20.182 9.52217C20.3764 9.351 20.6345 9.29861 20.8676 9.35938C20.6364 8.58192 20.3058 7.84726 19.8905 7.17018L19.5303 7.53033C19.2374 7.82322 18.7626 7.82322 18.4697 7.53033C18.1768 7.23744 18.1768 6.76256 18.4697 6.46967L18.9936 5.94571C17.2976 3.98821 14.7934 2.75 12 2.75C10.2299 2.75 8.57597 3.24718 7.17018 4.10952L7.53033 4.46967C7.82322 4.76256 7.82322 5.23744 7.53033 5.53033C7.23744 5.82322 6.76256 5.82322 6.46967 5.53033L5.94571 5.00637C4.94041 5.87741 4.12481 6.9616 3.56922 8.18863C3.97992 8.16934 4.33019 8.48475 4.3531 8.89609L4.43177 10.3081C4.45481 10.7217 4.13822 11.0756 3.72465 11.0987C3.31107 11.1217 2.95713 10.8051 2.93409 10.3916L2.92377 10.2064ZM14.7095 15.5316C14.6844 15.5179 14.6587 15.5039 14.6326 15.4898C14.5981 15.4712 14.5623 15.4519 14.5252 15.4321C14.3717 15.3497 14.1982 15.2567 14.0279 15.1549C13.4433 15.5315 12.7472 15.75 12 15.75C10.9043 15.75 9.91838 15.2801 9.23274 14.5308C8.92219 14.7382 8.56885 14.9526 8.19255 15.142C7.55133 15.4649 6.77639 15.75 6 15.75C4.98743 15.75 3.95347 15.2623 3.1792 14.7932C4.31219 18.3744 7.56585 21.013 11.4663 21.2349C11.4162 20.421 11.77 19.563 12.498 19.0246C12.8438 18.7689 13.2344 18.5971 13.6339 18.5182C13.3438 17.4575 13.8257 16.275 14.7095 15.5316ZM1.25 12C1.25 6.06294 6.06294 1.25 12 1.25C17.9371 1.25 22.75 6.06294 22.75 12C22.75 13.0111 22.6102 13.9907 22.3484 14.9201C22.2792 15.1662 22.0893 15.36 21.8447 15.4343C21.6002 15.5087 21.3346 15.4534 21.14 15.2876C20.9259 15.105 20.4213 15.0306 19.9246 15.398C19.5124 15.7028 19.3792 16.1229 19.4251 16.3974C19.4651 16.6365 19.3871 16.8801 19.2157 17.0515L19.1143 17.153C18.9599 17.3073 18.746 17.3868 18.5283 17.3706C18.3106 17.3544 18.1107 17.2441 17.9809 17.0686L17.6465 16.6163C17.351 16.2168 16.5445 16.0321 15.7654 16.6083C14.9862 17.1845 14.9266 18.0097 15.2221 18.4092L15.4074 18.6598C15.6282 18.9583 15.5973 19.3735 15.3347 19.6361L15.1494 19.8213C14.9517 20.019 14.6605 20.0904 14.3938 20.0064C14.1352 19.9249 13.747 19.9665 13.3899 20.2306C12.9028 20.5909 12.8699 21.2389 13.103 21.554C13.2677 21.7768 13.2963 22.0721 13.1772 22.3222C13.0582 22.5724 12.811 22.7365 12.5343 22.7492C12.4074 22.755 12.2412 22.7528 12.1175 22.7512C12.0709 22.7505 12.0302 22.75 12 22.75C6.06294 22.75 1.25 17.9371 1.25 12ZM12 9.75C10.7574 9.75 9.75 10.7574 9.75 12C9.75 13.2426 10.7574 14.25 12 14.25C13.2426 14.25 14.25 13.2426 14.25 12C14.25 10.7574 13.2426 9.75 12 9.75Z"
                  />
                </svg>
              )}
              <span className="opacity-60 shrink-0 whitespace-nowrap">{usageLabel}</span>
              {/* History cliff — the agent only receives a trailing window
                  of this conversation; say so instead of letting users assume
                  it remembers everything above the cliff. */}
              {cliffNote && (
                <>
                  <span aria-hidden className="opacity-40 shrink-0">
                    ·
                  </span>
                  <span
                    className="opacity-40 truncate"
                    title="Older messages are not sent to the agent — restate anything important."
                  >
                    {cliffNote}
                  </span>
                </>
              )}
            </div>
            {/* Branch chip — right-aligned, same style as usage */}
            {branches.length > 0 && (
              <button
                type="button"
                onClick={() => setShowBranchDropdown((o) => !o)}
                className="no-style inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] opacity-60 rounded transition-opacity hover:opacity-100"
              >
                <GitBranch size={12} className="shrink-0" />
                <span>{activeBranch?.name ?? 'main'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
