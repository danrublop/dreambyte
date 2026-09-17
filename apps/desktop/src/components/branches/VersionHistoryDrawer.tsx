'use client'

import { useCallback, useEffect, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'

interface VersionMeta {
  id: string
  sceneId: string
  branchId: string
  versionNumber: number
  operation: string | null
  label: string | null
  batchId: string | null
  source: string
  createdAt: Date
}

interface Props {
  projectId: string | null
  sceneId: string | null
  branchId: string | null
  /** Called after a successful restore so the parent can reload the scene preview. */
  onRestored?: () => void
}

function formatTime(d: Date | string | number): string {
  const date = new Date(typeof d === 'number' ? d * 1000 : d)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function sourceLabel(source: string, operation: string | null): string {
  if (source === 'agent' || operation === 'agent_run') return 'Agent edit'
  if (source === 'restore' || operation === 'restore') return 'Restored'
  if (source === 'branch-init') return 'Branch created'
  if (source === 'user') return 'Saved'
  if (source === 'autosave') return 'Autosave'
  if (operation) return operation.replace(/_/g, ' ')
  return 'Edit'
}

// Sources worth showing by default — agent edits, restores, branch-inits, user pins.
// Autosaves are hidden unless the user explicitly asks to see all.
const MEANINGFUL_SOURCES = new Set(['agent', 'restore', 'branch-init', 'user'])

export default function VersionHistoryDrawer({ projectId, sceneId, branchId, onRestored }: Props) {
  const [versions, setVersions] = useState<VersionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined

  const load = useCallback(async () => {
    if (!ipc || !projectId || !sceneId || !branchId) return
    setLoading(true)
    setError(null)
    try {
      const { versions: list } = await ipc.listVersions({ projectId, sceneId, branchId })
      setVersions(list as VersionMeta[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [ipc, projectId, sceneId, branchId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setShowAll(false)
  }, [sceneId, branchId])

  async function handleRestore(versionId: string) {
    if (!ipc) return
    setRestoring(versionId)
    setError(null)
    try {
      await ipc.restoreVersion({ projectId: projectId!, versionId })
      await load()
      onRestored?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed')
    } finally {
      setRestoring(null)
    }
  }

  if (!ipc || !projectId || !sceneId || !branchId) return null

  const displayed = showAll ? versions : versions.filter((v) => MEANINGFUL_SOURCES.has(v.source))
  const hiddenCount = versions.length - displayed.length

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <History size={14} className="text-[var(--color-text-muted)]" />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">Version history</span>
        {displayed.length > 0 && (
          <span className="text-[10px] text-[var(--color-text-muted)]">{displayed.length} saved</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {error && <p className="px-4 py-1 text-[11px] text-red-400">{error}</p>}

        {loading && <p className="px-4 py-2 text-[11px] text-[var(--color-text-muted)]">Loading...</p>}

        {!loading && displayed.length === 0 && (
          <p className="px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
            {versions.length > 0
              ? 'No agent or manual saves yet.'
              : 'No versions yet. Versions are created automatically on every save.'}
          </p>
        )}

        {displayed.slice(0, 50).map((v) => (
          <div
            key={v.id}
            className="group flex items-center gap-2 px-4 py-1.5 hover:bg-[var(--agent-chat-user-surface)]"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[11px] text-[var(--color-text-primary)]">
                v{v.versionNumber}
                {v.label ? ` — ${v.label}` : ` — ${sourceLabel(v.source, v.operation)}`}
              </span>
              <span className="text-[10px] text-[var(--color-text-muted)]">{formatTime(v.createdAt)}</span>
            </div>

            <button
              type="button"
              onClick={() => handleRestore(v.id)}
              disabled={restoring === v.id}
              className="no-style hidden h-6 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text-primary)] disabled:opacity-40 group-hover:flex"
              data-tooltip="Restore to this version"
            >
              <RotateCcw size={10} />
              {restoring === v.id ? 'Restoring...' : 'Restore'}
            </button>
          </div>
        ))}

        {displayed.length > 50 && (
          <p className="px-4 py-1 text-[10px] text-[var(--color-text-muted)]">
            Showing 50 of {displayed.length} versions
          </p>
        )}

        {hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="no-style px-4 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            + {hiddenCount} autosave{hiddenCount !== 1 ? 's' : ''} — show all
          </button>
        )}
        {showAll && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="no-style px-4 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            Hide autosaves
          </button>
        )}
      </div>
    </div>
  )
}
