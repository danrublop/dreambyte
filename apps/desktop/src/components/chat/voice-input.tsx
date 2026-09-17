'use client'

import { useState, useRef, useEffect } from 'react'
import { Check } from 'lucide-react'

export const SPEECH_RECOGNITION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'es-ES', label: 'Spanish (Spain)' },
  { code: 'es-MX', label: 'Spanish (Mexico)' },
  { code: 'es-US', label: 'Spanish (United States)' },
  { code: 'fr-FR', label: 'French (France)' },
  { code: 'fr-CA', label: 'French (Canada)' },
  { code: 'de-DE', label: 'German (Germany)' },
  { code: 'it-IT', label: 'Italian (Italy)' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'nl-NL', label: 'Dutch (Netherlands)' },
  { code: 'pl-PL', label: 'Polish (Poland)' },
  { code: 'ru-RU', label: 'Russian (Russia)' },
  { code: 'uk-UA', label: 'Ukrainian (Ukraine)' },
  { code: 'ja-JP', label: 'Japanese (Japan)' },
  { code: 'ko-KR', label: 'Korean (Korea)' },
  { code: 'zh-CN', label: 'Chinese (Mandarin, China)' },
  { code: 'zh-TW', label: 'Chinese (Taiwan)' },
  { code: 'yue-Hant-HK', label: 'Chinese (Cantonese, Hong Kong)' },
  { code: 'hi-IN', label: 'Hindi (India)' },
  { code: 'bn-IN', label: 'Bengali (India)' },
  { code: 'ta-IN', label: 'Tamil (India)' },
  { code: 'te-IN', label: 'Telugu (India)' },
  { code: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
  { code: 'he-IL', label: 'Hebrew (Israel)' },
  { code: 'tr-TR', label: 'Turkish (Turkey)' },
  { code: 'sv-SE', label: 'Swedish (Sweden)' },
  { code: 'no-NO', label: 'Norwegian (Norway)' },
  { code: 'da-DK', label: 'Danish (Denmark)' },
  { code: 'fi-FI', label: 'Finnish (Finland)' },
  { code: 'el-GR', label: 'Greek (Greece)' },
  { code: 'cs-CZ', label: 'Czech (Czechia)' },
  { code: 'sk-SK', label: 'Slovak (Slovakia)' },
  { code: 'hu-HU', label: 'Hungarian (Hungary)' },
  { code: 'ro-RO', label: 'Romanian (Romania)' },
  { code: 'bg-BG', label: 'Bulgarian (Bulgaria)' },
  { code: 'hr-HR', label: 'Croatian (Croatia)' },
  { code: 'sr-RS', label: 'Serbian (Serbia)' },
  { code: 'sl-SI', label: 'Slovenian (Slovenia)' },
  { code: 'vi-VN', label: 'Vietnamese (Vietnam)' },
  { code: 'th-TH', label: 'Thai (Thailand)' },
  { code: 'id-ID', label: 'Indonesian (Indonesia)' },
  { code: 'ms-MY', label: 'Malay (Malaysia)' },
  { code: 'fil-PH', label: 'Filipino (Philippines)' },
]

const VOICE_WAVE_BAR_COUNT = 18

type VoiceMeterRefs = {
  ctx: AudioContext | null
  stream: MediaStream | null
  analyser: AnalyserNode | null
  data: Uint8Array | null
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext }
  return window.AudioContext ?? w.webkitAudioContext ?? null
}

function VoiceWaveformVisual({ active }: { active: boolean }) {
  const [liveLevels, setLiveLevels] = useState<number[] | null>(null)
  const rafRef = useRef(0)
  const meterRef = useRef<VoiceMeterRefs>({ ctx: null, stream: null, analyser: null, data: null })

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(rafRef.current)
      const m = meterRef.current
      m.stream?.getTracks().forEach((t) => t.stop())
      void m.ctx?.close()
      meterRef.current = { ctx: null, stream: null, analyser: null, data: null }
      setLiveLevels(null)
      return
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setLiveLevels(null)
      return
    }

    let cancelled = false
    let frame = 0

    const teardown = () => {
      cancelAnimationFrame(rafRef.current)
      const m = meterRef.current
      m.stream?.getTracks().forEach((t) => t.stop())
      void m.ctx?.close()
      meterRef.current = { ctx: null, stream: null, analyser: null, data: null }
    }

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        const AC = getAudioContextCtor()
        if (!AC) {
          stream.getTracks().forEach((t) => t.stop())
          setLiveLevels(null)
          return
        }

        const ctx = new AC()
        if (ctx.state === 'suspended') await ctx.resume()

        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.minDecibels = -82
        analyser.maxDecibels = -28
        analyser.smoothingTimeConstant = 0.72
        source.connect(analyser)

        const data = new Uint8Array(analyser.frequencyBinCount)
        meterRef.current = { ctx, stream, analyser, data }

        // Weight toward ~speech band (lower bins); upper bins stay mostly quiet for voice
        const bandEnd = Math.max(VOICE_WAVE_BAR_COUNT, Math.floor(data.length * 0.72))
        const step = Math.max(1, Math.floor(bandEnd / VOICE_WAVE_BAR_COUNT))

        const tick = () => {
          if (cancelled) return
          const { analyser: an, data: buf } = meterRef.current
          if (!an || !buf) return
          an.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
          frame += 1
          if (frame % 2 !== 0) {
            rafRef.current = requestAnimationFrame(tick)
            return
          }
          const levels: number[] = []
          for (let i = 0; i < VOICE_WAVE_BAR_COUNT; i++) {
            let sum = 0
            const start = i * step
            for (let j = 0; j < step && start + j < bandEnd; j++) {
              sum += buf[start + j]!
            }
            const avg = sum / step / 255
            levels.push(Math.min(1, Math.pow(avg * 2.1, 0.58)))
          }
          setLiveLevels(levels)
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        if (!cancelled) setLiveLevels(null)
      }
    })()

    return () => {
      cancelled = true
      teardown()
      setLiveLevels(null)
    }
  }, [active])

  return (
    <div
      className={`flex h-7 items-end gap-[2px] px-1.5 py-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] ${active ? 'dreambyte-voice-wave--active' : 'dreambyte-voice-wave--idle'}`}
      aria-hidden
    >
      {liveLevels
        ? liveLevels.map((lv, i) => (
            <span
              key={i}
              className="dreambyte-voice-wave-bar dreambyte-voice-wave-bar--metered"
              style={{ transform: `scaleY(${0.1 + lv * 0.9})` }}
            />
          ))
        : Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className="dreambyte-voice-wave-bar"
              style={{
                animationDelay: `${i * 38}ms`,
                ['--dreambyte-voice-dur' as string]: active
                  ? `${0.32 + (i % 9) * 0.034}s`
                  : `${0.88 + (i % 7) * 0.06}s`,
              }}
            />
          ))}
    </div>
  )
}

export function SpeechWaveformLangControl({
  active,
  speechSupported,
  speechLang,
  showMenu,
  setShowMenu,
  onSelectLang,
  onOpenMenu,
}: {
  active: boolean
  speechSupported: boolean
  speechLang: string
  showMenu: boolean
  setShowMenu: (v: boolean) => void
  onSelectLang: (code: string) => void
  onOpenMenu?: () => void
}) {
  const currentLabel = SPEECH_RECOGNITION_LANGUAGES.find((l) => l.code === speechLang)?.label ?? speechLang
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={!speechSupported}
        onClick={(e) => {
          e.stopPropagation()
          const next = !showMenu
          if (next) onOpenMenu?.()
          setShowMenu(next)
        }}
        className={`rounded-lg transition-opacity no-style p-0 border-0 bg-transparent ${speechSupported ? 'cursor-pointer hover:opacity-95' : 'cursor-not-allowed opacity-40'}`}
        aria-haspopup="listbox"
        aria-expanded={showMenu}
        aria-label={`Speech recognition language: ${currentLabel}. Click to change.`}
      >
        <VoiceWaveformVisual active={active} />
      </button>
      {showMenu && speechSupported && (
        <>
          <div className="fixed inset-0 z-[92]" aria-hidden onClick={() => setShowMenu(false)} />
          <div
            role="listbox"
            aria-label="Speech language"
            className="absolute bottom-full left-0 mb-1 z-[101] max-h-52 w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl py-1"
          >
            {SPEECH_RECOGNITION_LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={l.code === speechLang}
                onClick={() => onSelectLang(l.code)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] hover:bg-white/10 no-style cursor-pointer"
              >
                <span className="flex-1 min-w-0">{l.label}</span>
                <span className="text-[10px] text-[var(--color-text-muted)] shrink-0 font-mono">{l.code}</span>
                {l.code === speechLang && (
                  <Check size={12} className="shrink-0 text-[var(--color-accent)]" strokeWidth={2.5} />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
