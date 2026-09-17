'use client'

/**
 * AudioMixer — the docked mixing console at the bottom of the editor sidebar,
 * just above the settings button (see HomeSidebar).
 *
 * ALWAYS three strips: two track slots + Master. Each track slot carries a
 * dropdown (chat-composer menu styling) that picks WHICH audio track it shows,
 * so projects with more than two audio tracks still fit a fixed console.
 *
 * Each strip is, left→right: a fader (rounded groove + white pill) | a tall VU
 * meter (§12.7 green→amber→red, rounded ends, peak-hold) | a dB scale
 * (0/-3/-6/-12/-24/dB). Track faders dispatch `track/setVolume`; Master writes
 * `audioSettings.masterVolume`. Metering is one shared rAF over the engine's
 * per-track / master analysers.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { getTimelineAudioEngine } from '@/lib/audio/timeline-audio-engine'
import { faderToGain, gainToFader, linearToDb, resolveMasterGain } from '@/lib/audio/mix-math'

const MASTER_ID = '__master__'
const SLOTS = [0, 1] // two track slots, always
const METER_H = 150 // px
const METER_W = 16 // px

function formatDb(gain: number): string {
  const db = linearToDb(gain)
  if (db === -Infinity) return '-∞'
  if (db >= 0) return `+${db.toFixed(1)}`
  return db.toFixed(1)
}

/** RMS level 0..1 → 0..1 meter fill on a dB-ish curve so quiet signal still
 *  lifts off the floor (pure-linear RMS barely moves). */
function meterFill(level: number): number {
  if (level <= 0) return 0
  const db = 20 * Math.log10(Math.min(1, level))
  return Math.max(0, Math.min(1, (db + 48) / 48))
}

interface StripModel {
  key: string
  slotIndex: number | null // null = master
  trackId: string | null
  name: string
  isMaster: boolean
  volume: number
  locked: boolean
}

export function AudioMixer() {
  const tracks = useVideoStore((s) => s.project.timeline?.tracks)
  const audioSettings = useVideoStore((s) => s.project.audioSettings)
  const dispatchAction = useVideoStore((s) => s.dispatchAction)
  // Which track each of the two slots shows; falls back to the Nth audio track.
  const [slotOverride, setSlotOverride] = useState<Record<number, string>>({})

  const audioTracks = useMemo(
    () =>
      (tracks ?? [])
        .filter((t) => t.type === 'audio')
        .slice()
        .sort((a, b) => a.position - b.position),
    [tracks],
  )

  function slotTrackId(i: number): string | null {
    const o = slotOverride[i]
    if (o && audioTracks.some((t) => t.id === o)) return o
    return audioTracks[i]?.id ?? null
  }

  const masterVolume = resolveMasterGain(audioSettings?.masterVolume)

  const strips: StripModel[] = SLOTS.map((i) => {
    const id = slotTrackId(i)
    const t = id ? audioTracks.find((x) => x.id === id) : undefined
    return {
      key: `slot-${i}`,
      slotIndex: i,
      trackId: id,
      name: t?.name || `Track ${i + 1}`,
      isMaster: false,
      volume: Number.isFinite(t?.volume) ? (t!.volume as number) : 1,
      locked: !!t?.locked,
    }
  })
  strips.push({
    key: 'master',
    slotIndex: null,
    trackId: MASTER_ID,
    name: 'Master',
    isMaster: true,
    volume: masterVolume,
    locked: false,
  })

  // ── Metering: one shared rAF over all meters ──────────────────────────────
  const canvasRefs = useRef(new Map<string, HTMLCanvasElement | null>())
  const peaks = useRef(new Map<string, { level: number; at: number }>())

  useEffect(() => {
    const engine = getTimelineAudioEngine()
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = performance.now()
      for (const [key, canvas] of canvasRefs.current) {
        if (!canvas) continue
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        const id = canvas.dataset.meterId || ''
        const raw = id === MASTER_ID ? engine.getMasterLevel() : id ? engine.getTrackLevel(id) : 0
        const level = meterFill(raw)
        const peak = peaks.current.get(key) ?? { level: 0, at: 0 }
        if (level >= peak.level || now - peak.at > 1500) peaks.current.set(key, { level, at: now })
        drawMeter(ctx, canvas.width, canvas.height, level, peaks.current.get(key)!.level)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  function setStripVolume(strip: StripModel, gain: number) {
    if (strip.isMaster) {
      // Surgical merge via the dedicated action (shared with agent set_master_volume).
      dispatchAction({ type: 'audio/setMasterVolume', params: { volume: gain } }, { source: 'user' })
    } else if (strip.trackId) {
      dispatchAction({ type: 'track/setVolume', params: { trackId: strip.trackId, volume: gain } }, { source: 'user' })
    }
  }

  return (
    <div className="mt-2 border-t border-[var(--color-border)] pt-2 pb-3" data-testid="audio-mixer">
      {/* Mixer is always open — a static header, no collapse/close control. */}
      <div className="mb-1.5 flex w-full items-center px-3 text-[11px] text-[var(--mute)]">
        <span>Mixer</span>
      </div>
      <div className="flex items-start justify-center gap-2.5 px-2 pb-1">
        {strips.map((strip) => (
          <ChannelStrip
            key={strip.key}
            strip={strip}
            audioTracks={audioTracks}
            registerCanvas={(el) => canvasRefs.current.set(strip.key, el)}
            onVolume={(g) => setStripVolume(strip, g)}
            onPickTrack={(id) => strip.slotIndex !== null && setSlotOverride((p) => ({ ...p, [strip.slotIndex!]: id }))}
          />
        ))}
      </div>
    </div>
  )
}

function ChannelStrip({
  strip,
  audioTracks,
  registerCanvas,
  onVolume,
  onPickTrack,
}: {
  strip: StripModel
  audioTracks: { id: string; name: string }[]
  registerCanvas: (el: HTMLCanvasElement | null) => void
  onVolume: (gain: number) => void
  onPickTrack: (trackId: string) => void
}) {
  const empty = !strip.isMaster && !strip.trackId
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-stretch gap-1.5" style={{ height: METER_H }}>
        <Fader
          value={gainToFader(strip.volume)}
          disabled={strip.locked || empty}
          height={METER_H}
          ariaLabel={`${strip.name} volume`}
          valueText={`${formatDb(strip.volume)} dB`}
          onChange={(p) => onVolume(faderToGain(p))}
        />
        <canvas
          ref={registerCanvas}
          data-meter-id={strip.trackId ?? ''}
          width={METER_W}
          height={METER_H}
          className="rounded-full"
          aria-hidden
          style={{ background: 'rgba(127,127,127,0.08)' }}
        />
        <DbScale height={METER_H} />
      </div>
      {strip.isMaster ? (
        <div className="mt-0.5 text-[10px] font-medium text-[var(--ink-soft)]">Master</div>
      ) : (
        <TrackPicker name={strip.name} disabled={audioTracks.length === 0} tracks={audioTracks} onPick={onPickTrack} />
      )}
    </div>
  )
}

/** Rounded groove + draggable white pill. Pointer-drag + keyboard (role=slider). */
function Fader({
  value,
  disabled,
  height,
  ariaLabel,
  valueText,
  onChange,
}: {
  value: number
  disabled: boolean
  height: number
  ariaLabel: string
  valueText: string
  onChange: (pos: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  function posFromEvent(clientY: number): number {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return value
    return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
  }
  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    onChange(posFromEvent(e.clientY))
    const move = (ev: PointerEvent) => onChange(posFromEvent(ev.clientY))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    let delta = 0
    if (e.key === 'ArrowUp') delta = e.shiftKey ? 0.01 : 0.05
    else if (e.key === 'ArrowDown') delta = e.shiftKey ? -0.01 : -0.05
    if (delta !== 0) {
      e.preventDefault()
      onChange(Math.max(0, Math.min(1, value + delta)))
    }
  }

  const pillTop = (1 - value) * 100
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={ariaLabel}
      aria-valuetext={valueText}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(3))}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="relative outline-none focus-visible:[&>.groove]:ring-1 focus-visible:[&>.groove]:ring-[var(--accent)]"
      style={{ width: 18, height, cursor: disabled ? 'default' : 'ns-resize', touchAction: 'none' }}
    >
      {/* rounded groove */}
      <div
        className="groove absolute left-1/2 top-0 bottom-0 -translate-x-1/2 rounded-full"
        style={{ width: 4, background: 'var(--card)' }}
      />
      {/* white pill */}
      {!disabled && (
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-full"
          style={{
            top: `calc(${pillTop}% - 5px)`,
            width: 18,
            height: 10,
            background: '#e6e6e6',
            boxShadow: '0 1px 2px rgba(0,0,0,0.55)',
          }}
        />
      )}
    </div>
  )
}

/** Evenly spaced dB reference marks (0/-3/-6/-12/-24) + the dB unit. */
function DbScale({ height }: { height: number }) {
  const marks = ['0', '-3', '-6', '-12', '-24']
  return (
    <div className="relative tabular-nums text-[8px] leading-none text-[var(--mute)]" style={{ width: 20, height }}>
      {marks.map((m, i) => (
        <span key={m} className="absolute right-0" style={{ top: `${4 + i * 18}%` }}>
          {m}
        </span>
      ))}
      <span className="absolute bottom-0 right-0">dB</span>
    </div>
  )
}

/** Slot label that opens a chat-composer-style menu to reassign the track. */
function TrackPicker({
  name,
  tracks,
  disabled,
  onPick,
}: {
  name: string
  tracks: { id: string; name: string }[]
  disabled: boolean
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className="relative mt-0.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="no-style flex max-w-[64px] items-center gap-0.5 text-[10px] text-[var(--ink-soft)] hover:text-[var(--ink)] disabled:opacity-50"
      >
        <span className="truncate">{name}</span>
        <ChevronDown size={10} className="shrink-0 text-[var(--mute)]" />
      </button>
      {open && tracks.length > 0 && (
        <div
          className="absolute bottom-full left-1/2 z-50 mb-1 min-w-[120px] -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--panel)] p-1 shadow-2xl"
          role="menu"
        >
          {tracks.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(t.id)
                setOpen(false)
              }}
              className="no-style flex w-full items-center rounded-[6px] px-2 py-1 text-left text-[11px] text-[var(--ink-soft)] hover:bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] hover:text-[var(--ink)]"
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Vertical VU bar: continuous green→amber→red gradient + a peak-hold tick,
 *  drawn into a CSS-rounded canvas so the bar reads as a rounded pill. */
function drawMeter(ctx: CanvasRenderingContext2D, w: number, h: number, level: number, peak: number) {
  ctx.clearRect(0, 0, w, h)
  const fillH = level * h
  if (fillH > 0.5) {
    const grad = ctx.createLinearGradient(0, h, 0, 0)
    grad.addColorStop(0, '#34d399') // green (bottom)
    grad.addColorStop(0.58, '#34d399')
    grad.addColorStop(0.8, '#fbbf24') // amber
    grad.addColorStop(0.93, '#fbbf24')
    grad.addColorStop(1, '#f87171') // red (top)
    ctx.fillStyle = grad
    ctx.fillRect(0, h - fillH, w, fillH)
  }
  if (peak > 0) {
    const py = h - peak * h
    ctx.fillStyle = '#fde047'
    ctx.fillRect(0, Math.max(0, Math.min(h - 2, py)), w, 2)
  }
}
