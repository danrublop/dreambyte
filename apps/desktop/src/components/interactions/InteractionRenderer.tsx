'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { AlertCircle } from 'lucide-react'
import type { InteractionElement, InteractionStyle } from '@/lib/types'
import { cssBorderRadiusForTooltipTrigger } from '@/lib/interactions/tooltip-trigger-css'
import { ProfessionalTooltip } from '@/components/interactions/ProfessionalTooltip'
import { DEFAULT_INTERACTION_STYLE } from '@/lib/types'

// ── Callback types ───────────────────────────────────────────────────────────

export interface InteractionCallbacks {
  brandColor: string
  onHotspotClick: (el: InteractionElement & { type: 'hotspot' }) => void
  onChoiceSelect: (el: InteractionElement & { type: 'choice' }, optionId: string, jumpsToSceneId: string) => void
  onQuizAnswer: (el: InteractionElement & { type: 'quiz' }, selectedOptionId: string, correct: boolean) => void
  onGateContinue: (el: InteractionElement & { type: 'gate' }) => void
  onFormSubmit: (el: InteractionElement & { type: 'form' }, values: Record<string, string>) => void
  onSliderChange?: (el: InteractionElement & { type: 'slider' }, value: number) => void
  onToggleChange?: (el: InteractionElement & { type: 'toggle' }, value: boolean) => void
  onResume?: () => void
  variables?: Record<string, unknown>
  setVariable?: (name: string, value: unknown) => void
}

// ── Style helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16) || 0
  const g = parseInt(h.substring(2, 4), 16) || 0
  const b = parseInt(h.substring(4, 6), 16) || 0
  return `${r},${g},${b}`
}

function useStyle(el: InteractionElement): InteractionStyle {
  return useMemo(() => ({ ...DEFAULT_INTERACTION_STYLE, ...el.visualStyle }), [el.visualStyle])
}

function panelCSS(s: InteractionStyle, extra?: React.CSSProperties): React.CSSProperties {
  const bgRgb = hexToRgb(s.bgColor)
  const borderRgb = hexToRgb(s.borderColor)
  const shadowRgb = hexToRgb(s.shadowColor)

  const isGradient = s.preset === 'gradient'
  const bg = isGradient
    ? `linear-gradient(135deg, rgba(${bgRgb}, ${s.bgOpacity}), rgba(${hexToRgb(s.accentColor)}, ${s.bgOpacity * 0.7}))`
    : `rgba(${bgRgb}, ${s.bgOpacity})`

  return {
    background: bg,
    backdropFilter: s.blur > 0 ? `blur(${s.blur}px) saturate(180%)` : undefined,
    WebkitBackdropFilter: s.blur > 0 ? `blur(${s.blur}px) saturate(180%)` : undefined,
    borderRadius: s.borderRadius,
    border: `${s.borderWidth}px solid rgba(${borderRgb}, ${s.borderOpacity})`,
    boxShadow:
      [
        s.shadowSpread > 0 && s.shadowOpacity > 0
          ? `0 8px ${s.shadowSpread}px rgba(${shadowRgb}, ${s.shadowOpacity})`
          : '',
        s.innerGlow > 0 ? `inset 0 1px 0 rgba(${hexToRgb(s.bgColor)}, ${Math.min(s.innerGlow, 1)})` : '',
        s.innerGlow > 0 ? `inset 0 -1px 0 rgba(${hexToRgb(s.bgColor)}, ${s.innerGlow * 0.2})` : '',
        s.innerGlow > 0 ? `inset 0 0 20px 10px rgba(${hexToRgb(s.bgColor)}, ${s.innerGlow})` : '',
        s.preset === 'neon' ? `0 0 20px rgba(${hexToRgb(s.borderColor)}, ${s.shadowOpacity})` : '',
      ]
        .filter(Boolean)
        .join(', ') || 'none',
    fontFamily: s.fontFamily,
    color: s.textColor,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    textAlign: s.textAlign as any,
    letterSpacing: s.letterSpacing ? `${s.letterSpacing}em` : undefined,
    padding: `${s.paddingY}px ${s.paddingX}px`,
    position: 'relative' as const,
    overflow: 'hidden' as const,
    transition: `all ${s.transitionSpeed}ms ease`,
    ...extra,
  }
}

function itemCSS(s: InteractionStyle, hover: boolean, color?: string): React.CSSProperties {
  const rgb = hexToRgb(color || s.accentColor)
  const borderRgb = hexToRgb(s.borderColor)
  return {
    padding: `${Math.max(s.paddingY * 0.5, 10)}px ${Math.max(s.paddingX * 0.6, 14)}px`,
    borderRadius: Math.max(s.borderRadius - 6, 6),
    border: `${s.borderWidth}px solid rgba(${color ? rgb : borderRgb}, ${hover ? Math.min(s.borderOpacity * 2, 1) : s.borderOpacity * 0.6})`,
    background: hover
      ? `rgba(${rgb}, ${Math.min(s.bgOpacity * 1.5, 0.3)})`
      : s.bgOpacity > 0
        ? `rgba(${hexToRgb(s.bgColor)}, ${s.bgOpacity * 0.3})`
        : 'transparent',
    color: s.textColor,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontFamily: s.fontFamily,
    cursor: 'pointer',
    transition: `all ${s.transitionSpeed}ms ease`,
    transform: hover ? `scale(${s.hoverScale})` : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    textAlign: s.textAlign as any,
  }
}

// ── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
@keyframes dreambyte-entrance-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dreambyte-entrance-slide-up { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dreambyte-entrance-pop { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
@keyframes dreambyte-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
@keyframes dreambyte-glow { 0%, 100% { box-shadow: 0 0 12px 4px var(--glow-color); } 50% { box-shadow: 0 0 24px 8px var(--glow-color); } }
@keyframes dreambyte-ripple { 0% { transform: scale(0.8); opacity: 0.6; } 100% { transform: scale(2.5); opacity: 0; } }
@keyframes dreambyte-gate-in { from { backdrop-filter: blur(0px); background: transparent; } to { backdrop-filter: blur(16px) saturate(120%); background: rgba(0,0,0,0.35); } }
@keyframes dreambyte-float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-6px); } }
@keyframes dreambyte-check { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
@keyframes dreambyte-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(3px); } }
.dreambyte-slider-input { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
.dreambyte-slider-input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 0; height: 0; }
.dreambyte-slider-input::-moz-range-thumb { appearance: none; width: 0; height: 0; border: none; background: transparent; }
.dreambyte-slider-input::-webkit-slider-runnable-track { background: transparent; }
.dreambyte-slider-input::-moz-range-track { background: transparent; }
.dreambyte-slider-input:focus { outline: none; }
`

function getEntranceAnimation(anim: string | undefined): string | undefined {
  switch (anim) {
    case 'fade':
      return 'dreambyte-entrance-fade 0.4s ease-out forwards'
    case 'slide-up':
      return 'dreambyte-entrance-slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards'
    case 'pop':
      return 'dreambyte-entrance-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards'
    default:
      return undefined
  }
}

export function InteractionStyles() {
  return <style>{STYLES}</style>
}

// ── StyledPanel ──────────────────────────────────────────────────────────────

function StyledPanel({
  children,
  s,
  extra,
}: {
  children: React.ReactNode
  s: InteractionStyle
  extra?: React.CSSProperties
}) {
  const bgRgb = hexToRgb(s.bgColor)
  return (
    <div style={panelCSS(s, extra)}>
      {s.innerGlow > 0 && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              background: `linear-gradient(90deg, transparent, rgba(${bgRgb}, ${Math.min(s.innerGlow * 1.6, 0.8)}), transparent)`,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: '100%',
              background: `linear-gradient(180deg, rgba(${bgRgb}, ${Math.min(s.innerGlow * 1.6, 0.8)}), transparent, rgba(${bgRgb}, ${s.innerGlow * 0.6}))`,
            }}
          />
        </>
      )}
      {children}
    </div>
  )
}

// ── Main renderer ────────────────────────────────────────────────────────────

export function InteractionRenderer({
  element: el,
  callbacks,
  firstAppearance = false,
}: {
  element: InteractionElement
  callbacks: InteractionCallbacks
  firstAppearance?: boolean
}) {
  const entranceAnim = firstAppearance ? getEntranceAnimation(el.entranceAnimation) : undefined
  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.width}%`,
    height: el.type === 'choice' || el.type === 'quiz' || el.type === 'form' ? undefined : `${el.height}%`,
    animation: entranceAnim,
    pointerEvents: 'auto',
  }

  switch (el.type) {
    case 'hotspot':
      return <HotspotRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    case 'choice':
      return <ChoiceRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    case 'quiz':
      return <QuizRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    case 'gate':
      return <GateRenderer element={el} callbacks={callbacks} />
    case 'tooltip':
      return <TooltipRenderer element={el} style={wrapStyle} />
    case 'form':
      return <FormRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    case 'slider':
      return <SliderRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    case 'toggle':
      return <ToggleRenderer element={el} callbacks={callbacks} style={wrapStyle} />
    default:
      return null
  }
}

// ── Hotspot ──────────────────────────────────────────────────────────────────

function HotspotRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'hotspot' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const s = useStyle(el)

  return (
    <div style={{ ...style, position: 'absolute', overflow: 'visible' }}>
      {/* Dot trigger */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: `translate(-50%, -50%) scale(${hover ? 1.15 : 1})`,
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: el.color,
          border: '2px solid white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          color: 'white',
          boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
          transition: 'transform 0.15s ease',
          zIndex: 2,
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => {
          setOpen(!open)
          callbacks.onHotspotClick(el)
        }}
      >
        {open ? '×' : '+'}
      </div>

      {/* Pulse ring */}
      {el.style === 'pulse' && !open && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 26,
            height: 26,
            borderRadius: '50%',
            border: `2px solid ${el.color}`,
            opacity: 0.4,
            animation: 'dreambyte-ripple 2s ease-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Popover card */}
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 'calc(50% + 18px)',
            top: 'calc(50% - 40px)',
            background: 'white',
            border: '0.5px solid rgba(0,0,0,0.12)',
            borderRadius: 8,
            padding: '10px 13px',
            minWidth: 160,
            maxWidth: 220,
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
            zIndex: 10,
            fontFamily: s.fontFamily || '-apple-system, BlinkMacSystemFont, sans-serif',
            animation: 'dreambyte-entrance-fade 0.15s ease-out',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontWeight: 500, fontSize: 13, color: '#1a1a18', marginBottom: 3, lineHeight: 1.4 }}>
              {el.label}
            </div>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setOpen(false)
              }}
              style={{ color: '#aaa', fontSize: 13, cursor: 'pointer', marginLeft: 6, lineHeight: 1 }}
            >
              ×
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Choice ───────────────────────────────────────────────────────────────────

function ChoiceRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'choice' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const s = useStyle(el)

  return (
    <StyledPanel s={s} extra={style}>
      {el.question && (
        <p
          style={{
            color: s.textColor,
            fontSize: s.fontSize + 3,
            fontWeight: 700,
            fontFamily: s.fontFamily,
            textAlign: s.textAlign,
            marginBottom: s.gap * 2,
            margin: `0 0 ${s.gap * 2}px`,
            lineHeight: 1.3,
          }}
        >
          {el.question}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: el.layout === 'vertical' ? 'column' : 'row', gap: s.gap }}>
        {el.options.map((opt) => (
          <span
            key={opt.id}
            role="button"
            tabIndex={0}
            onClick={() => callbacks.onChoiceSelect(el, opt.id, opt.jumpsToSceneId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') callbacks.onChoiceSelect(el, opt.id, opt.jumpsToSceneId)
            }}
            onMouseEnter={() => setHoveredId(opt.id)}
            onMouseLeave={() => setHoveredId(null)}
            style={itemCSS(s, hoveredId === opt.id, opt.color || undefined)}
          >
            {opt.icon && <span>{opt.icon}</span>}
            {opt.label}
          </span>
        ))}
      </div>
    </StyledPanel>
  )
}

// ── Quiz ─────────────────────────────────────────────────────────────────────

function QuizRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'quiz' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [shaking, setShaking] = useState(false)
  const s = useStyle(el)
  const isCorrect = selected === el.correctOptionId
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const submit = () => {
    if (!selected || submitted) return
    setSubmitted(true)
    const correct = selected === el.correctOptionId
    if (!correct) {
      setShaking(true)
      setTimeout(() => setShaking(false), 500)
    }
    callbacks.onQuizAnswer(el, selected, correct)
    timerRef.current = setTimeout(() => {
      if (correct) {
        if (!(el.onCorrect === 'jump' && el.onCorrectSceneId)) callbacks.onResume?.()
      } else {
        if (el.onWrong === 'retry') {
          setSubmitted(false)
          setSelected(null)
        } else if (!(el.onWrong === 'jump' && el.onWrongSceneId)) callbacks.onResume?.()
      }
    }, 2000)
  }

  const font = s.fontFamily || '-apple-system, BlinkMacSystemFont, sans-serif'

  return (
    <div
      style={{
        ...style,
        background: 'white',
        border: '0.5px solid rgba(0,0,0,0.1)',
        borderRadius: 12,
        padding: '20px 24px',
        fontFamily: font,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {/* Question */}
      <p style={{ fontSize: 15, fontWeight: 500, color: '#1a1a18', margin: '0 0 14px', lineHeight: 1.55 }}>
        {el.question}
      </p>

      {/* Options */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          animation: shaking ? 'dreambyte-shake 0.4s ease' : undefined,
        }}
      >
        {el.options.map((opt, i) => {
          const letter = String.fromCharCode(65 + i)
          const isSel = selected === opt.id
          const isOk = submitted && opt.id === el.correctOptionId
          const isWrong = submitted && isSel && !isCorrect

          let bg = '#f9f9f7'
          let border = '0.5px solid rgba(0,0,0,0.1)'
          let color = '#333'
          let circColor = 'currentColor'

          if (isOk) {
            bg = '#f0fdf4'
            border = '1px solid #16a34a'
            color = '#15803d'
            circColor = '#16a34a'
          } else if (isWrong) {
            bg = '#fef2f2'
            border = '1px solid #dc2626'
            color = '#b91c1c'
            circColor = '#dc2626'
          } else if (isSel && !submitted) {
            bg = '#f0f4ff'
            border = '1px solid ' + (s.accentColor || '#2563eb')
            color = s.accentColor || '#2563eb'
            circColor = s.accentColor || '#2563eb'
          }

          return (
            <div
              key={opt.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (!submitted) setSelected(opt.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !submitted) setSelected(opt.id)
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 9,
                padding: '10px 14px',
                border,
                borderRadius: 8,
                cursor: submitted ? 'default' : 'pointer',
                fontSize: 13,
                color,
                background: bg,
                transition: 'all 0.15s ease',
                lineHeight: 1.45,
              }}
            >
              <div
                style={{
                  width: 20,
                  minWidth: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: `1.5px solid ${circColor}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 500,
                  marginTop: 1,
                  flexShrink: 0,
                }}
              >
                {isOk ? '✓' : isWrong ? '✗' : letter}
              </div>
              <span>{opt.label}</span>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 14,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, color: '#aaa' }}>
          Question {el.options.indexOf(el.options.find((o) => o.id === el.correctOptionId)!) + 1 > 0 ? '' : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {submitted && (
            <span style={{ fontSize: 13, color: isCorrect ? '#15803d' : '#b91c1c' }}>
              {isCorrect ? el.explanation || 'Correct!' : el.explanation || 'Incorrect'}
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: !selected || submitted ? 'default' : 'pointer',
              border: '0.5px solid rgba(0,0,0,0.15)',
              background: selected && !submitted ? s.accentColor || '#2563eb' : '#f0f0ee',
              color: selected && !submitted ? 'white' : '#666',
              transition: 'all 0.15s ease',
              opacity: !selected ? 0.5 : 1,
            }}
          >
            {submitted ? (el.onWrong === 'retry' && !isCorrect ? 'Retrying...' : 'Answered') : 'Check answer'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Gate ─────────────────────────────────────────────────────────────────────

function GateRenderer({
  element: el,
  callbacks,
}: {
  element: InteractionElement & { type: 'gate' }
  callbacks: InteractionCallbacks
}) {
  const [visible, setVisible] = useState(false)
  const [hover, setHover] = useState(false)
  const s = useStyle(el)
  const brandColor = s.accentColor || callbacks.brandColor
  const rgb = hexToRgb(brandColor)
  const bgRgb = hexToRgb(s.bgColor)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        animation: 'dreambyte-gate-in 0.5s ease forwards',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: s.gap * 1.5,
        pointerEvents: 'auto',
      }}
    >
      <span
        role="button"
        tabIndex={0}
        onClick={() => callbacks.onGateContinue(el)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') callbacks.onGateContinue(el)
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: `${s.paddingY * 0.7}px ${s.paddingX * 1.5}px`,
          borderRadius: s.borderRadius,
          background:
            el.buttonStyle === 'outline'
              ? `rgba(${bgRgb}, ${s.bgOpacity})`
              : s.preset === 'gradient'
                ? `linear-gradient(135deg, rgba(${rgb}, 0.9), rgba(${hexToRgb(s.bgColor)}, 0.7))`
                : `linear-gradient(135deg, rgba(${rgb}, 0.9), rgba(${rgb}, 0.7))`,
          border: `${s.borderWidth}px solid rgba(${el.buttonStyle === 'outline' ? bgRgb : rgb}, ${s.borderOpacity})`,
          backdropFilter: s.blur > 0 ? `blur(${s.blur}px)` : undefined,
          color: s.textColor,
          fontSize: s.fontSize + 2,
          fontWeight: 700,
          fontFamily: s.fontFamily,
          cursor: 'pointer',
          letterSpacing: `${s.letterSpacing || 0.02}em`,
          boxShadow:
            [
              hover ? `0 8px 32px rgba(${rgb}, 0.35)` : `0 4px 20px rgba(${rgb}, 0.2)`,
              s.innerGlow > 0 ? `inset 0 1px 0 rgba(${bgRgb}, ${s.innerGlow})` : '',
              s.innerGlow > 0 ? `inset 0 0 20px 10px rgba(${bgRgb}, ${s.innerGlow * 0.4})` : '',
              s.preset === 'neon' ? `0 0 20px rgba(${rgb}, 0.4)` : '',
            ]
              .filter(Boolean)
              .join(', ') || 'none',
          opacity: visible ? 1 : 0,
          transform: visible ? (hover ? `scale(${s.hoverScale})` : 'scale(1)') : 'scale(0.9) translateY(8px)',
          transition: `all ${s.transitionSpeed * 1.5}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          animation: visible ? 'dreambyte-float 3s ease-in-out infinite' : undefined,
        }}
      >
        {s.innerGlow > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              background: `linear-gradient(90deg, transparent, rgba(${bgRgb}, 0.8), transparent)`,
            }}
          />
        )}
        {el.buttonLabel || 'Continue'}
      </span>
      <p
        style={{
          color: `rgba(${hexToRgb(s.textColor)}, 0.3)`,
          fontSize: 12,
          fontWeight: 500,
          fontFamily: s.fontFamily,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          opacity: visible ? 1 : 0,
          transition: `opacity 0.5s ease 0.3s`,
        }}
      >
        Click to continue
      </p>
    </div>
  )
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

/** Largest square inscribed in the interaction box so `border-radius: 50%` is a true circle, not an oval. */
function TooltipCircleFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          aspectRatio: '1',
          height: '100%',
          width: 'auto',
          maxWidth: '100%',
          maxHeight: '100%',
          flexShrink: 0,
          pointerEvents: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function TooltipRenderer({
  element: el,
  style,
}: {
  element: InteractionElement & { type: 'tooltip' }
  style: React.CSSProperties
}) {
  const [hovered, setHovered] = useState(false)
  const s = useStyle(el)
  const rgb = hexToRgb(el.triggerColor)
  const bgRgb = hexToRgb(s.bgColor)
  const isCircle = el.triggerShape === 'circle'
  const proCircle = s.preset === 'professional' && isCircle

  const pos: React.CSSProperties =
    el.tooltipPosition === 'top'
      ? { bottom: '120%', left: '50%', transform: 'translateX(-50%)' }
      : el.tooltipPosition === 'bottom'
        ? { top: '120%', left: '50%', transform: 'translateX(-50%)' }
        : el.tooltipPosition === 'left'
          ? { right: '120%', top: '50%', transform: 'translateY(-50%)' }
          : { left: '120%', top: '50%', transform: 'translateY(-50%)' }

  const triggerInner: React.CSSProperties = proCircle
    ? {
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '50%',
        background: `linear-gradient(180deg, rgba(${rgb}, 0.94), rgba(${rgb}, 0.72))`,
        border: `${s.borderWidth}px solid rgba(255,255,255,${hovered ? 0.42 : 0.24})`,
        backdropFilter: s.blur > 0 ? `blur(${s.blur}px)` : undefined,
        boxShadow:
          [
            `0 6px ${Math.max(s.shadowSpread, 16)}px rgba(${hexToRgb(s.shadowColor)}, ${Math.min(0.35, s.shadowOpacity + 0.08)})`,
            hovered ? `0 0 22px rgba(${rgb}, 0.42)` : `0 0 14px rgba(${rgb}, 0.28)`,
            s.innerGlow > 0 ? `inset 0 1px 0 rgba(${bgRgb}, ${s.innerGlow})` : '',
            s.innerGlow > 0 ? `inset 0 0 18px 8px rgba(${bgRgb}, ${s.innerGlow * 0.45})` : '',
          ]
            .filter(Boolean)
            .join(', ') || 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'help',
        transition: `all ${s.transitionSpeed}ms ease`,
        animation: hovered ? undefined : 'dreambyte-pulse 3s ease-in-out infinite',
      }
    : {
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: cssBorderRadiusForTooltipTrigger(el.triggerShape, s.borderRadius),
        background: `rgba(${rgb}, ${s.bgOpacity})`,
        border: `${s.borderWidth}px solid rgba(${rgb}, ${hovered ? s.borderOpacity * 2 : s.borderOpacity})`,
        backdropFilter: s.blur > 0 ? `blur(${s.blur}px)` : undefined,
        boxShadow:
          s.innerGlow > 0
            ? `inset 0 1px 0 rgba(${bgRgb}, ${s.innerGlow}), ${hovered ? `0 0 16px rgba(${rgb}, 0.25)` : `0 0 8px rgba(${rgb}, 0.1)`}`
            : `${hovered ? `0 0 16px rgba(${rgb}, 0.25)` : 'none'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'help',
        transition: `all ${s.transitionSpeed}ms ease`,
        animation: hovered ? undefined : 'dreambyte-pulse 3s ease-in-out infinite',
      }

  const triggerBody = (
    <>
      {s.innerGlow > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: `linear-gradient(90deg, transparent, rgba(${bgRgb}, 0.5), transparent)`,
          }}
        />
      )}
      {proCircle ? (
        <AlertCircle
          className="pointer-events-none shrink-0 text-white"
          strokeWidth={2.5}
          aria-hidden
          style={{ width: '56%', height: '56%', minWidth: 16, minHeight: 16, maxWidth: 32, maxHeight: 32 }}
        />
      ) : (
        el.triggerLabel && (
          <span
            style={{
              color: s.preset === 'professional' ? '#f8fafc' : el.triggerColor,
              fontSize: s.preset === 'professional' ? 13 : 12,
              fontWeight: 700,
              fontFamily: s.fontFamily,
              textShadow: s.preset === 'professional' ? '0 1px 3px rgba(0,0,0,0.45)' : undefined,
            }}
          >
            {el.triggerLabel}
          </span>
        )
      )}
    </>
  )

  const a11yLabel = el.triggerLabel?.trim() || el.tooltipTitle || 'More information'

  const trigger = isCircle ? (
    <TooltipCircleFrame>
      <div tabIndex={0} role="button" aria-label={a11yLabel} style={triggerInner}>
        {triggerBody}
      </div>
    </TooltipCircleFrame>
  ) : (
    <div tabIndex={0} role="button" aria-label={a11yLabel} style={triggerInner}>
      {triggerBody}
    </div>
  )

  if (s.preset === 'professional') {
    return (
      <div style={style}>
        <ProfessionalTooltip
          open={hovered}
          onOpenChange={setHovered}
          position={el.tooltipPosition}
          contentMaxWidth={el.tooltipMaxWidth}
          content={
            <>
              <p className="mb-1.5 text-[12px] font-bold leading-snug tracking-tight">{el.tooltipTitle}</p>
              <p className="text-[12px] font-normal leading-relaxed text-slate-300">{el.tooltipBody}</p>
            </>
          }
        >
          {trigger}
        </ProfessionalTooltip>
      </div>
    )
  }

  return (
    <div style={style} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {trigger}
      <div
        style={{
          position: 'absolute',
          ...pos,
          maxWidth: el.tooltipMaxWidth,
          ...panelCSS(s, { padding: `${s.paddingY * 0.6}px ${s.paddingX * 0.7}px` }),
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? 'auto' : 'none',
          transition: `all ${s.transitionSpeed * 1.2}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          zIndex: 30,
        }}
      >
        <p
          style={{
            color: s.textColor,
            fontSize: s.fontSize - 2,
            fontWeight: 700,
            fontFamily: s.fontFamily,
            margin: '0 0 4px',
          }}
        >
          {el.tooltipTitle}
        </p>
        <p
          style={{
            color: `rgba(${hexToRgb(s.textColor)}, 0.6)`,
            fontSize: s.fontSize - 3,
            fontFamily: s.fontFamily,
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {el.tooltipBody}
        </p>
      </div>
    </div>
  )
}

// ── Form ─────────────────────────────────────────────────────────────────────

function FormRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'form' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [hover, setHover] = useState(false)
  const s = useStyle(el)
  const brandColor = s.accentColor || callbacks.brandColor
  const rgb = hexToRgb(brandColor)
  const bgRgb = hexToRgb(s.bgColor)
  const borderRgb = hexToRgb(s.borderColor)

  const handleSubmit = () => {
    for (const m of el.setsVariables) callbacks.setVariable?.(m.variableName, values[m.fieldId] ?? '')
    callbacks.onFormSubmit(el, values)
  }

  const inputStyle = (fieldId: string): React.CSSProperties => ({
    width: '100%',
    padding: `${Math.max(s.paddingY * 0.4, 8)}px ${Math.max(s.paddingX * 0.5, 12)}px`,
    borderRadius: Math.max(s.borderRadius / 2, 6),
    border: `1px solid ${focused === fieldId ? `rgba(${rgb}, 0.4)` : `rgba(${borderRgb}, ${s.borderOpacity * 0.4})`}`,
    background: focused === fieldId ? `rgba(${rgb}, 0.06)` : `rgba(${bgRgb}, ${s.bgOpacity * 0.4})`,
    color: s.textColor,
    fontSize: s.fontSize,
    fontFamily: s.fontFamily,
    outline: 'none',
    transition: `all ${s.transitionSpeed}ms ease`,
    boxSizing: 'border-box' as const,
    boxShadow: focused === fieldId ? `0 0 0 3px rgba(${rgb}, 0.08)` : 'none',
  })

  return (
    <StyledPanel s={s} extra={style}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: s.gap * 1.5 }}>
        {el.fields.map((field) => (
          <div key={field.id}>
            <label
              style={{
                color: `rgba(${hexToRgb(s.textColor)}, 0.55)`,
                fontSize: s.fontSize - 4,
                fontWeight: 600,
                fontFamily: s.fontFamily,
                marginBottom: 6,
                display: 'block',
                letterSpacing: '0.05em',
                textTransform: 'uppercase' as const,
              }}
            >
              {field.label}
              {field.required && <span style={{ color: brandColor, marginLeft: 3 }}>*</span>}
            </label>
            {field.type === 'text' && (
              <input
                type="text"
                placeholder={field.placeholder ?? ''}
                value={values[field.id] ?? ''}
                onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}
                onFocus={() => setFocused(field.id)}
                onBlur={() => setFocused(null)}
                style={inputStyle(field.id)}
              />
            )}
            {field.type === 'select' && (
              <select
                value={values[field.id] ?? ''}
                onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}
                onFocus={() => setFocused(field.id)}
                onBlur={() => setFocused(null)}
                style={{
                  ...inputStyle(field.id),
                  appearance: 'none' as const,
                  backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='rgba(255,255,255,0.3)' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 12px center',
                  paddingRight: 32,
                }}
              >
                <option value="" style={{ background: '#1a1a2e' }}>
                  Select...
                </option>
                {field.options.map((opt) => (
                  <option key={opt} value={opt} style={{ background: '#1a1a2e' }}>
                    {opt}
                  </option>
                ))}
              </select>
            )}
            {field.type === 'radio' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
                {field.options.map((opt) => {
                  const sel = values[field.id] === opt
                  return (
                    <label
                      key={opt}
                      style={{
                        color: s.textColor,
                        fontSize: s.fontSize - 2,
                        fontFamily: s.fontFamily,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        cursor: 'pointer',
                        padding: `${Math.max(s.paddingY * 0.3, 6)}px ${Math.max(s.paddingX * 0.4, 10)}px`,
                        borderRadius: Math.max(s.borderRadius / 2, 6),
                        border: `1px solid ${sel ? `rgba(${rgb}, 0.35)` : `rgba(${borderRgb}, ${s.borderOpacity * 0.3})`}`,
                        background: sel ? `rgba(${rgb}, 0.06)` : 'transparent',
                        transition: `all ${s.transitionSpeed}ms ease`,
                      }}
                    >
                      <div
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          border: `2px solid ${sel ? brandColor : `rgba(${hexToRgb(s.textColor)}, 0.2)`}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {sel && <div style={{ width: 8, height: 8, borderRadius: '50%', background: brandColor }} />}
                      </div>
                      <input
                        type="radio"
                        name={field.id}
                        value={opt}
                        checked={sel}
                        onChange={(e) => setValues({ ...values, [field.id]: e.target.value })}
                        style={{ display: 'none' }}
                      />
                      {opt}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div
        style={{
          height: 1,
          background: `rgba(${bgRgb}, 0.06)`,
          margin: `${s.gap * 2}px -${s.paddingX}px ${s.gap * 1.5}px`,
        }}
      />
      <span
        role="button"
        tabIndex={0}
        onClick={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit()
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'block',
          width: '100%',
          padding: `${Math.max(s.paddingY * 0.55, 11)}px`,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: Math.max(s.borderRadius - 8, 6),
          background: hover
            ? `linear-gradient(135deg, rgba(${rgb}, 1), rgba(${rgb}, 0.8))`
            : `linear-gradient(135deg, rgba(${rgb}, 0.85), rgba(${rgb}, 0.65))`,
          color: s.textColor,
          fontSize: s.fontSize,
          fontWeight: 700,
          fontFamily: s.fontFamily,
          textAlign: 'center',
          cursor: 'pointer',
          transition: `all ${s.transitionSpeed}ms ease`,
          boxShadow: hover ? `0 6px 24px rgba(${rgb}, 0.3)` : `0 4px 16px rgba(${rgb}, 0.15)`,
          transform: hover ? `scale(${s.hoverScale})` : 'none',
        }}
      >
        {s.innerGlow > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 1,
              background: `linear-gradient(90deg, transparent, rgba(${bgRgb}, 0.6), transparent)`,
            }}
          />
        )}
        {el.submitLabel || 'Continue'}
      </span>
    </StyledPanel>
  )
}

// ── Slider ──────────────────────────────────────────────────────────────────

function SliderRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'slider' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const s = useStyle(el)
  const accent = el.trackColor || s.accentColor
  const accentRgb = hexToRgb(accent)
  const [value, setValue] = useState<number>(el.defaultValue)
  const [dragging, setDragging] = useState(false)

  // Sync from parent variable changes
  const extVal = callbacks.variables?.[el.setsVariable]
  useEffect(() => {
    if (typeof extVal === 'number' && extVal !== value) setValue(extVal)
  }, [extVal])

  const pct = ((value - el.min) / (el.max - el.min)) * 100
  const speed = Math.min(s.transitionSpeed, 200)

  return (
    <div style={style}>
      <div
        style={{
          ...panelCSS(s, { padding: `${Math.max(s.paddingY * 0.7, 12)}px ${s.paddingX}px` }),
          display: 'flex',
          flexDirection: 'column',
          gap: Math.max(s.gap, 8),
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.textColor }}>{el.label}</span>
          {el.showValue && (
            <span
              style={{
                fontSize: s.fontSize * 1.15,
                fontWeight: 700,
                color: accent,
                fontVariantNumeric: 'tabular-nums',
                minWidth: '3em',
                textAlign: 'right',
              }}
            >
              {Number(value).toFixed(el.step < 1 ? 1 : 0)}
              {el.unit || ''}
            </span>
          )}
        </div>
        <div style={{ position: 'relative', height: 36, display: 'flex', alignItems: 'center' }}>
          {/* Track background */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: 6,
              borderRadius: 3,
              background: `rgba(${hexToRgb(s.textColor)}, 0.12)`,
            }}
          />
          {/* Track fill */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              width: `${pct}%`,
              height: 6,
              borderRadius: 3,
              background: accent,
              transition: dragging ? 'none' : `width ${speed}ms ease-out`,
            }}
          />
          {/* Custom thumb */}
          <div
            style={{
              position: 'absolute',
              left: `${pct}%`,
              transform: `translateX(-50%) scale(${dragging ? 1.15 : 1})`,
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: el.thumbColor || accent,
              boxShadow: dragging
                ? `0 0 0 6px rgba(${accentRgb}, 0.15), 0 4px 12px rgba(${accentRgb}, 0.4)`
                : `0 2px 8px rgba(${accentRgb}, 0.35)`,
              transition: dragging ? 'transform 100ms ease-out, box-shadow 100ms ease-out' : `all ${speed}ms ease-out`,
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
          {/* Native range input — fully reset via CSS class, captures all events */}
          <input
            type="range"
            className="dreambyte-slider-input"
            min={el.min}
            max={el.max}
            step={el.step}
            value={value}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onChange={(e) => {
              const v = Number(e.target.value)
              setValue(v)
              callbacks.onSliderChange?.(el, v)
            }}
            style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              margin: 0,
              padding: 0,
              zIndex: 2,
              cursor: 'pointer',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── Toggle ──────────────────────────────────────────────────────────────────

function ToggleRenderer({
  element: el,
  callbacks,
  style,
}: {
  element: InteractionElement & { type: 'toggle' }
  callbacks: InteractionCallbacks
  style: React.CSSProperties
}) {
  const s = useStyle(el)
  const [on, setOn] = useState<boolean>(el.defaultValue)
  const activeColor = el.activeColor || s.accentColor
  const activeRgb = hexToRgb(activeColor)
  const speed = Math.min(s.transitionSpeed, 200)

  // Sync from parent variable changes
  const extVal = callbacks.variables?.[el.setsVariable]
  useEffect(() => {
    if (typeof extVal === 'boolean' && extVal !== on) setOn(extVal)
  }, [extVal])

  const toggle = () => {
    const next = !on
    setOn(next)
    callbacks.onToggleChange?.(el, next)
  }

  return (
    <div style={style}>
      <div
        style={{
          ...panelCSS(s, { padding: `${Math.max(s.paddingY * 0.7, 12)}px ${s.paddingX}px` }),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s.gap * 2,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        role="switch"
        aria-checked={on}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.textColor }}>{el.label}</span>
          {(el.onLabel || el.offLabel) && (
            <span
              style={{
                fontSize: s.fontSize * 0.8,
                color: `rgba(${hexToRgb(s.textColor)}, 0.45)`,
                transition: `color ${speed}ms ease`,
              }}
            >
              {on ? el.onLabel || 'ON' : el.offLabel || 'OFF'}
            </span>
          )}
        </div>
        {/* Toggle track */}
        <div
          style={{
            flexShrink: 0,
            width: 52,
            height: 28,
            borderRadius: 14,
            background: on ? activeColor : `rgba(${hexToRgb(s.textColor)}, 0.18)`,
            boxShadow: on
              ? `0 0 0 1px rgba(${activeRgb}, 0.3), inset 0 1px 2px rgba(0,0,0,0.1)`
              : `inset 0 1px 3px rgba(0,0,0,0.15)`,
            transition: `background ${speed}ms ease, box-shadow ${speed}ms ease`,
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 3,
              left: on ? 27 : 3,
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2), 0 0 1px rgba(0,0,0,0.1)',
              transition: `left ${speed}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            }}
          />
        </div>
      </div>
    </div>
  )
}
