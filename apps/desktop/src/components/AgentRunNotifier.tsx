'use client'

import { useEffect, useRef } from 'react'
import { useVideoStore } from '@/lib/store'

/**
 * Fires the General-tab notification preferences when an agent run finishes
 * (isAgentRunning true -> false). Prefs are read from localStorage at fire
 * time (not via React state) so this stays in sync with the toggle components
 * without coupling to them. Mounted once in AppShell — always present across
 * home / chat / editor, so a long run notifies even if you navigated away.
 */
export default function AgentRunNotifier() {
  const running = useVideoStore((s) => s.isAgentRunning)
  const prev = useRef(running)

  useEffect(() => {
    const finished = prev.current && !running
    prev.current = running
    if (!finished || typeof window === 'undefined') return

    try {
      // System notifications default ON; completion sound defaults OFF
      // (see src/components/settings/GeneralSettingsTab.tsx).
      if (window.localStorage.getItem('dreambyte:settings:systemNotifications') !== 'false') {
        notify('Agent finished', 'Your dreambyte agent finished responding.')
      }
      if (window.localStorage.getItem('dreambyte:settings:completionSound') === 'true') {
        playDing()
      }
    } catch {
      /* notifications / audio unavailable — ignore */
    }
  }, [running])

  return null
}

function notify(title: string, body: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
  } else if (Notification.permission !== 'denied') {
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification(title, { body })
    })
  }
}

/** Short two-note chime via WebAudio — no bundled asset needed. */
function playDing() {
  const Ctx =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return
  const ctx = new Ctx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = 'sine'
  osc.frequency.setValueAtTime(880, ctx.currentTime)
  osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.08)
  gain.gain.setValueAtTime(0.0001, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
  osc.start()
  osc.stop(ctx.currentTime + 0.36)
  osc.onended = () => void ctx.close()
}
