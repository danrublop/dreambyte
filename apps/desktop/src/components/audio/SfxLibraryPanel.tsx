'use client'

import type { CSSProperties } from 'react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Search, Play, Pause, Loader2, Volume2 } from 'lucide-react'
import { ZZFX_SFX_CATEGORIES, allZzfxPresetsFlat } from '@/lib/audio/sfx-zzfx-presets'
import { licenseBadgeLabel } from '@/lib/audio/sfx-license'
import type { SfxLocalManifest } from '@/lib/audio/sfx-local-manifest'
import { getLocalSoundsForCategory, manifestSoundToResult } from '@/lib/audio/sfx-local-manifest'
import type { SFXResult } from '@/lib/audio/types'
import type { ZzfxSfxPreset } from '@/lib/audio/sfx-zzfx-presets'
import { buildZzfxWavObjectUrl, playZzfxPreview, uploadAudioBlob } from '@/lib/audio/sfx-zzfx-client'
import { SFX_DRAG_MIME, type SfxDragPayload } from '@/lib/utils/add-sfx-to-timeline'

export type SFXSearchResult = SFXResult

export interface SfxLibraryPanelProps {
  /** Called when a card is clicked — drops the sound on the selected scene at time 0. */
  onSelect: (result: SFXSearchResult, triggerAt: number) => void
  className?: string
  style?: CSSProperties
  /** When set, the panel is locked to one category (the Media Library shows the
   *  categories as bins and opens this panel scoped to the chosen bin), so the
   *  internal category selector is hidden. */
  lockedCategory?: string
}

const CATEGORY_ALL_ID = 'all'

interface UnifiedEntry {
  key: string
  id: string
  name: string
  category: string
  duration: number | null
  license: string | null
  // Exactly one of these is set
  ready?: SFXResult
  preset?: ZzfxSfxPreset
}

export function SfxLibraryPanel({ onSelect, className = '', style: rootStyle, lockedCategory }: SfxLibraryPanelProps) {
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<SFXResult[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)
  const [category, setCategory] = useState(lockedCategory ?? CATEGORY_ALL_ID)
  // Keep the locked category in sync when the host (Media Library bin) changes it.
  useEffect(() => {
    if (lockedCategory) setCategory(lockedCategory)
  }, [lockedCategory])
  const [localManifest, setLocalManifest] = useState<SfxLocalManifest | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const zzfxNodeRef = useRef<AudioBufferSourceNode | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch('/sfx-library/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SfxLocalManifest | null) => {
        if (!cancelled && data?.categories?.length) setLocalManifest(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Build a unified list of every available sound (native + procedural) filtered by category.
  const entries = useMemo<UnifiedEntry[]>(() => {
    const out: UnifiedEntry[] = []

    const native =
      category === CATEGORY_ALL_ID
        ? (localManifest?.categories ?? []).flatMap((c) =>
            c.sounds.map((s) => ({ result: manifestSoundToResult(s), categoryLabel: c.label })),
          )
        : getLocalSoundsForCategory(localManifest, category).map((r) => ({
            result: r,
            categoryLabel: ZZFX_SFX_CATEGORIES.find((c) => c.id === category)?.label ?? '',
          }))
    for (const { result, categoryLabel } of native) {
      out.push({
        key: `native-${result.id}`,
        id: result.id,
        name: result.name,
        category: categoryLabel,
        duration: result.duration ?? null,
        license: result.license ?? null,
        ready: result,
      })
    }

    const zzfx =
      category === CATEGORY_ALL_ID
        ? allZzfxPresetsFlat()
        : (ZZFX_SFX_CATEGORIES.find((c) => c.id === category)?.presets ?? []).map((p) => ({
            ...p,
            categoryId: category,
            categoryLabel: ZZFX_SFX_CATEGORIES.find((c) => c.id === category)?.label ?? '',
          }))
    for (const preset of zzfx) {
      out.push({
        key: `zzfx-${preset.id}`,
        id: preset.id,
        name: preset.name,
        category: 'categoryLabel' in preset ? (preset as { categoryLabel: string }).categoryLabel : '',
        duration: null,
        license: 'MIT (ZzFX)',
        preset,
      })
    }

    return out
  }, [localManifest, category])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
  }, [entries, query])

  const searchRemote = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.sfx : undefined
      const data = ipc ? await ipc.search({ query, limit: 48, commercialOnly: true }) : { results: [] }
      setRemote((data.results as SFXResult[]) || [])
    } catch {
      setRemote([])
    }
    setLoading(false)
  }

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause()
      } catch {
        /* ignore */
      }
      audioRef.current = null
    }
    // Stop any in-flight ZzFX synth node too — pausing audioRef alone doesn't
    // cut the procedural ZzFX path.
    if (zzfxNodeRef.current) {
      try {
        zzfxNodeRef.current.stop()
      } catch {
        /* already ended */
      }
      zzfxNodeRef.current = null
    }
    setPlaying(null)
  }, [])

  const playPreview = useCallback(
    (e: UnifiedEntry) => {
      stopPreview()
      if (e.preset) {
        void playZzfxPreview(e.preset).then((node) => {
          zzfxNodeRef.current = node
        })
        setPlaying(e.key)
        return
      }
      const url = e.ready?.previewUrl || e.ready?.audioUrl
      if (!url) return
      const audio = new Audio(url)
      audio.onended = () => setPlaying(null)
      audio.play().catch(() => {})
      audioRef.current = audio
      setPlaying(e.key)
    },
    [stopPreview],
  )

  // Hover-preview with a short debounce so sweeping the cursor across the grid
  // doesn't fire (and overlap) a sound for every card it crosses.
  const HOVER_PREVIEW_DELAY_MS = 250
  const onCardEnter = useCallback(
    (e: UnifiedEntry) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => playPreview(e), HOVER_PREVIEW_DELAY_MS)
    },
    [playPreview],
  )
  const onCardLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    stopPreview()
  }, [stopPreview])

  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      stopPreview()
    },
    [stopPreview],
  )

  const handleClick = useCallback(
    async (e: UnifiedEntry) => {
      stopPreview()
      if (e.ready) {
        onSelect(e.ready, 0)
        return
      }
      // ZzFX presets — bake to WAV + upload so the URL is persistent.
      if (!e.preset) return
      setAddingId(e.key)
      setErrorId(null)
      try {
        const { url, durationSec, revoke } = await buildZzfxWavObjectUrl(e.preset)
        const blob = await fetch(url).then((r) => r.blob())
        revoke()
        const uploaded = await uploadAudioBlob(blob, `zzfx-${e.preset.id}.wav`)
        onSelect(
          {
            id: `zzfx-${e.preset.id}`,
            name: e.preset.name,
            provider: 'zzfx',
            audioUrl: uploaded,
            previewUrl: uploaded,
            duration: durationSec,
            license: 'MIT (ZzFX)',
          },
          0,
        )
      } catch (err) {
        // Don't swallow — the bake/upload can fail (e.g. uploadBlob throws off
        // the desktop runtime) and the user otherwise gets zero feedback, the
        // sound silently not added.
        console.error('[sfx] failed to add ZzFX sound', e.preset.id, err)
        setErrorId(e.key)
      } finally {
        setAddingId(null)
      }
    },
    [onSelect, stopPreview],
  )

  const handleDragStart = useCallback((e: React.DragEvent, entry: UnifiedEntry) => {
    const payload: SfxDragPayload = entry.ready
      ? { kind: 'ready', result: entry.ready }
      : { kind: 'zzfx', preset: entry.preset! }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(SFX_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.setData('text/plain', entry.name)
  }, [])

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`.trim()} style={rootStyle}>
      {/* Compact header: search · category · remote-search button */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchRemote()}
            placeholder="Search sounds…"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-6 pr-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {!lockedCategory && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] text-[var(--color-text-primary)] outline-none"
          >
            <option value={CATEGORY_ALL_ID}>All</option>
            {ZZFX_SFX_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <span
          onClick={searchRemote}
          className="no-style electron-titlebar-icon flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors"
          data-tooltip="Search remote libraries"
          data-tooltip-pos="bottom"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
        </span>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {filtered.length === 0 && remote.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-[var(--color-text-muted)]">No sounds in this view.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map((e) => (
              <SfxCard
                key={e.key}
                entry={e}
                isPlaying={playing === e.key}
                isAdding={addingId === e.key}
                isError={errorId === e.key}
                onMouseEnter={() => onCardEnter(e)}
                onMouseLeave={onCardLeave}
                onClick={() => handleClick(e)}
                onDragStart={(ev) => handleDragStart(ev, e)}
              />
            ))}
            {remote.map((r) => {
              const e: UnifiedEntry = {
                key: `remote-${r.provider ?? 'x'}-${r.id}`,
                id: r.id,
                name: r.name,
                category: r.provider ?? '',
                duration: r.duration ?? null,
                license: r.license ?? null,
                ready: r,
              }
              return (
                <SfxCard
                  key={e.key}
                  entry={e}
                  isPlaying={playing === e.key}
                  isAdding={false}
                  isError={errorId === e.key}
                  onMouseEnter={() => onCardEnter(e)}
                  onMouseLeave={onCardLeave}
                  onClick={() => handleClick(e)}
                  onDragStart={(ev) => handleDragStart(ev, e)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface CardProps {
  entry: UnifiedEntry
  isPlaying: boolean
  isAdding: boolean
  isError?: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClick: () => void
  onDragStart: (e: React.DragEvent) => void
}

function SfxCard({ entry, isPlaying, isAdding, isError, onMouseEnter, onMouseLeave, onClick, onDragStart }: CardProps) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      title={entry.name}
      className="group relative flex aspect-video cursor-grab flex-col items-center justify-center overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] transition-colors hover:border-[var(--color-text-muted)] active:cursor-grabbing"
    >
      <Volume2 size={26} className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]" />

      {/* Duration pill */}
      {entry.duration != null && (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
          {entry.duration.toFixed(2)}s
        </span>
      )}

      {/* License pill */}
      {entry.license && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/45 px-1 py-0.5 text-[9px] uppercase tracking-wide text-white/85">
          {licenseBadgeLabel(entry.license, entry.preset ? 'zzfx' : entry.ready?.provider)}
        </span>
      )}

      {/* Play indicator on hover */}
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 transition-opacity ${
          isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25">
          {isAdding ? (
            <Loader2 size={16} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={16} />
          ) : (
            <Play size={16} className="ml-0.5" />
          )}
        </div>
      </div>

      {/* Add-failed indicator. */}
      {isError && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-red-500/85 px-1.5 py-0.5 text-[9px] font-medium text-white">
          Failed to add
        </span>
      )}

      {/* Name */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6">
        <p className="truncate text-[11px] font-medium text-white/95">{entry.name}</p>
      </div>
    </div>
  )
}
