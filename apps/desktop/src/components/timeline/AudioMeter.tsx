'use client'

/**
 * Master audio meter — RMS level of the timeline audio engine's output,
 * rendered as a compact horizontal bar (green → amber → red) with a 1.5s
 * peak-hold tick. Sits in the timeline toolbar; hidden entirely while no
 * standalone audio voices are active so it never adds chrome for video-only
 * projects.
 */

import { useEffect, useRef, useState } from 'react'
import { getTimelineAudioEngine } from '@/lib/audio/timeline-audio-engine'

const W = 64
const H = 6

export function AudioMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [active, setActive] = useState(false)
  const peakRef = useRef({ level: 0, at: 0 })

  useEffect(() => {
    const engine = getTimelineAudioEngine()
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const hasVoices = engine.hasActiveVoices()
      setActive((prev) => (prev === hasVoices ? prev : hasVoices))
      const canvas = canvasRef.current
      if (!canvas || !hasVoices) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const level = engine.getLevel()
      const now = performance.now()
      if (level >= peakRef.current.level || now - peakRef.current.at > 1500) {
        peakRef.current = { level, at: now }
      }
      ctx.clearRect(0, 0, W, H)
      // Track background
      ctx.fillStyle = 'rgba(127,127,127,0.18)'
      ctx.fillRect(0, 0, W, H)
      // Level bar — green body, amber > 0.6, red > 0.85
      const w = Math.round(level * W)
      const grad = ctx.createLinearGradient(0, 0, W, 0)
      grad.addColorStop(0, '#3f9e58')
      grad.addColorStop(0.6, '#3f9e58')
      grad.addColorStop(0.75, '#d9a13b')
      grad.addColorStop(0.9, '#d9534f')
      grad.addColorStop(1, '#d9534f')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, H)
      // Peak-hold tick
      const px = Math.min(W - 1, Math.round(peakRef.current.level * W))
      if (px > 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)'
        ctx.fillRect(px, 0, 1, H)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      data-testid="timeline-audio-meter"
      title="Master audio level"
      style={{ display: active ? 'block' : 'none', borderRadius: 3 }}
    />
  )
}
