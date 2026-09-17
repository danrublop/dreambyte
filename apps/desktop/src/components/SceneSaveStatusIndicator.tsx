'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Check, Loader2, RefreshCw } from 'lucide-react'
import { useVideoStore } from '@/lib/store'

interface Props {
  sceneId: string | null
  className?: string
}

export default function SceneSaveStatusIndicator({ sceneId, className = '' }: Props) {
  const sceneStatus = useVideoStore((s) => (sceneId ? s.sceneSaveStatus[sceneId] : undefined))
  const sceneLastSavedAt = useVideoStore((s) => (sceneId ? s.sceneLastSavedAt[sceneId] : undefined))
  const sceneErrorMessage = useVideoStore((s) => (sceneId ? s.sceneWriteErrors[sceneId] : undefined))
  const projectStatus = useVideoStore((s) => s.projectSaveStatus)
  const projectLastSavedAt = useVideoStore((s) => s.projectLastSavedAt)
  const projectErrorMessage = useVideoStore((s) => s.projectSaveError)
  const saveSceneHTML = useVideoStore((s) => s.saveSceneHTML)
  const saveProjectToDb = useVideoStore((s) => s.saveProjectToDb)

  const status = sceneStatus === 'saving' || sceneStatus === 'error' ? sceneStatus : projectStatus
  const lastSavedAt = status === 'saved' ? (projectLastSavedAt ?? sceneLastSavedAt) : undefined
  const errorMessage = status === 'error' ? (sceneErrorMessage ?? projectErrorMessage) : undefined
  const retryDisabled = sceneStatus === 'error' && !sceneId

  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'saved' || !lastSavedAt) return
    const id = setInterval(() => setTick((t) => t + 1), 5000)
    return () => clearInterval(id)
  }, [status, lastSavedAt])

  const isError = status === 'error' || (!!errorMessage && status !== 'saving')
  if (status === 'saving') {
    return (
      <span data-testid="app-save-status" className={`flex items-center gap-1.5 ${className}`}>
        <Loader2 size={11} className="animate-spin" />
        Saving...
      </span>
    )
  }

  if (isError) {
    return (
      <span
        data-testid="app-save-status"
        className={`flex items-center gap-2 text-red-400 ${className}`}
        title={errorMessage ?? undefined}
      >
        <AlertCircle size={11} />
        Save failed
        <button
          type="button"
          onClick={() => {
            if (sceneStatus === 'error' && sceneId) void saveSceneHTML(sceneId)
            else void saveProjectToDb()
          }}
          className="flex items-center gap-1 rounded px-1 text-[10px] underline decoration-dotted hover:text-red-300"
          disabled={retryDisabled}
        >
          <RefreshCw size={10} />
          Retry
        </button>
      </span>
    )
  }

  if (status === 'saved' && lastSavedAt) {
    return (
      <span data-testid="app-save-status" className={`flex items-center gap-1.5 ${className}`}>
        <Check size={11} className="text-green-400" />
        Saved {formatRelativeTime(lastSavedAt)}
      </span>
    )
  }

  return null
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
