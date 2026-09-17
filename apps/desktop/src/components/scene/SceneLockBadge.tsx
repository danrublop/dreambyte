'use client'

import { useEffect, useState } from 'react'
import { Bot, Lock, User as UserIcon } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { formatLockAge, isStale, type SceneLock } from '@/lib/store/scene-lock'

// Lock indicator badge — replaces the conflict modal entirely (W0 design D3).
// Shows who owns the scene right now, when they acquired it, and offers a
// "Take over" affordance after the existing lock has been idle for >30s.
// Styling follows the electron-titlebar-icon flat header pattern (no bg,
// inline icon + label) per memory feedback_no_kbd_nav.

export interface SceneLockBadgeProps {
  sceneId: string
  /** Reader-side perspective: which side is *viewing* this badge. Drives the
   *  Take-over button's resulting owner. Default: the user. */
  viewer?: 'user' | 'agent'
  /** Optional callback fired when the user clicks Take over. Wires into
   *  app-level intent (e.g. close agent run, then forceTakeover). When
   *  unset the badge calls forceTakeoverSceneLock directly. */
  onTakeOver?: () => void
}

export default function SceneLockBadge({ sceneId, viewer = 'user', onTakeOver }: SceneLockBadgeProps) {
  const lock = useVideoStore((s) => s.scenes.find((sc) => sc.id === sceneId)?.lock ?? null)
  const forceTakeoverSceneLock = useVideoStore((s) => s.forceTakeoverSceneLock)

  // Tick once a second so age + stale state stay current. Cheap; one timer
  // per mounted badge. We could lift to a singleton but that's premature.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lock) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [lock])

  if (!lock) return null

  const ownedByViewer = lock.owner === viewer
  const stale = isStale(lock)
  const ownerLabel = ownerLabelFor(lock, viewer)
  const ageLabel = formatLockAge(lock)
  const Icon = lock.owner === 'agent' ? Bot : UserIcon

  // aria-live announcement: only fires for the OTHER side, since it's the
  // editor that learns about the lock. Phrasing matches design D6 spec.
  const announcement = ownedByViewer ? null : `${ownerLabel} is editing this scene — ${ageLabel}`

  const handleTakeOver = () => {
    if (onTakeOver) onTakeOver()
    else forceTakeoverSceneLock(sceneId, viewer, 'in-app')
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        color: ownedByViewer ? 'var(--color-text-muted)' : 'var(--color-text-secondary, var(--color-text-primary))',
      }}
      data-tooltip={ownedByViewer ? `You acquired this scene ${ageLabel}` : `${ownerLabel} ${ageLabel}`}
      data-tooltip-pos="top"
    >
      <Icon size={10} aria-hidden="true" />
      <span className="leading-none">{ownerLabel}</span>
      {!ownedByViewer && stale && (
        <button
          type="button"
          onClick={handleTakeOver}
          className="no-style ml-0.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-white/[0.06]"
          aria-label="Take over scene editing"
        >
          <Lock size={9} aria-hidden="true" />
          Take over
        </button>
      )}
      {announcement && (
        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
      )}
    </span>
  )
}

function ownerLabelFor(lock: SceneLock, viewer: 'user' | 'agent'): string {
  if (lock.owner === viewer) return 'You'
  return lock.owner === 'agent' ? 'Agent' : 'User'
}
