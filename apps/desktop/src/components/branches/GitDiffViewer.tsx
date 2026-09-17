'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileDiff, GitCompare, ChevronDown, ChevronRight } from 'lucide-react'
import { diffActionLogs, type ActionLogDiff } from '@/lib/git/action-diff'
import type { Action } from '@/lib/actions'
import { summariseFileStatuses, colorForFileStatus, colorForActionKind } from './git-ui-helpers'

/**
 * GitDiffViewer.
 *
 * Renders two complementary views for a single from→to ref pair:
 *
 *   1. **File diff** (git name-status) — what touched the .dreambyte/ folder
 *      on disk. Useful for sanity-checking before pushing.
 *   2. **Action diff** — the deeper, more meaningful view. Lists the
 *      `action_log` rows stamped with commits in this range so the user
 *      sees "+ clip/add (clip-12)" rather than "+ scenes/scene-001.code.json".
 *
 * Action diff is sourced from the `git.listActionsForRange` IPC, which joins
 * commit SHAs in the range against `action_log.commit_sha`. Rows without a
 * `commit_sha` never match, so those commits return `[]`.
 */

interface FileDiffEntry {
  status: string
  path: string
  oldPath?: string
}

interface Props {
  projectId: string
  fromRef: string
  toRef: string
}

export default function GitDiffViewer({ projectId, fromRef, toRef }: Props) {
  const git = typeof window !== 'undefined' ? window.dreambyteApi?.git : undefined

  const [files, setFiles] = useState<FileDiffEntry[]>([])
  const [actionDiff, setActionDiff] = useState<ActionLogDiff | null>(null)
  const [commitCount, setCommitCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showFiles, setShowFiles] = useState(true)
  const [showActions, setShowActions] = useState(true)

  const refresh = useCallback(async () => {
    if (!git || !projectId) return
    setLoading(true)
    setError(null)
    try {
      // File-level diff is direct: ask git.
      const fileResult = await git.diff({ projectId, from: fromRef, to: toRef })
      setFiles(fileResult.entries)

      // Ask for the actions stamped with the SHAs in this commit range.
      // Returns [] (and commitShas:[]) for commits whose action rows have
      // commit_sha=NULL.
      const { actions, commitShas } = await git.listActionsForRange({
        projectId,
        from: fromRef,
        to: toRef,
        includeUncommitted: false,
      })
      setCommitCount(commitShas.length)
      const typed = actions as unknown as Action[]
      const diff = diffActionLogs([], typed)
      setActionDiff(diff)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'diff failed')
    } finally {
      setLoading(false)
    }
  }, [git, projectId, fromRef, toRef])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!git) {
    return (
      <div className="p-3 text-[11px] text-[var(--color-text-muted)]">
        Git diff is only available in the desktop app.
      </div>
    )
  }

  const counts = summariseFileStatuses(files)

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-[11px] text-[var(--color-text-primary)]">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <GitCompare size={11} />
          {fromRef.slice(0, 7)} → {toRef.slice(0, 7)}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {loading ? 'Loading…' : `${files.length} file(s)${commitCount !== null ? ` · ${commitCount} commit(s)` : ''}`}
        </span>
      </header>

      {error && (
        <p className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1 text-[10px] text-red-400">{error}</p>
      )}

      <section className="rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
        <button
          type="button"
          onClick={() => setShowFiles((v) => !v)}
          className="no-style flex w-full items-center gap-1.5 border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          {showFiles ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <FileDiff size={10} />
          <span>Files</span>
          <span className="ml-auto">
            <span className="text-green-400">+{counts.added}</span>{' '}
            <span className="text-yellow-400">~{counts.modified}</span>{' '}
            <span className="text-red-400">-{counts.deleted}</span>
          </span>
        </button>
        {showFiles && (
          <ul className="max-h-32 overflow-y-auto">
            {files.length === 0 && !loading && (
              <li className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">No file changes.</li>
            )}
            {files.map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] hover:bg-[var(--agent-chat-user-surface)]"
              >
                <span className={`w-3 text-center text-[10px] ${colorForFileStatus(f.status)}`}>{f.status}</span>
                <span className="truncate">{f.path}</span>
                {f.oldPath && <span className="text-[10px] text-[var(--color-text-muted)]">← {f.oldPath}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-1 flex-col rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
        <button
          type="button"
          onClick={() => setShowActions((v) => !v)}
          className="no-style flex w-full items-center gap-1.5 border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          {showActions ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span>Actions ({actionDiff?.entries.length ?? 0})</span>
          {actionDiff && (
            <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">
              {actionDiff.summary.length} run(s)
            </span>
          )}
        </button>
        {showActions && (
          <div className="flex flex-1 flex-col overflow-y-auto">
            {!actionDiff && (
              <p className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">Action log unavailable.</p>
            )}
            {actionDiff && actionDiff.summary.length > 0 && (
              <div className="border-b border-[var(--color-border)] px-2 py-1 text-[10px]">
                <span className="text-[var(--color-text-muted)]">Summary:</span>
                <ul className="mt-1 space-y-0.5">
                  {actionDiff.summary.map((s, i) => (
                    <li key={`${s.runId ?? 'none'}-${i}`} className="text-[var(--color-text-primary)]">
                      {s.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="flex-1">
              {actionDiff && actionDiff.entries.length === 0 && (
                <li className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">No action changes.</li>
              )}
              {actionDiff?.entries.map((e, i) => (
                <li
                  key={`${e.action.id}-${i}`}
                  className={`px-2 py-0.5 text-[11px] hover:bg-[var(--agent-chat-user-surface)] ${colorForActionKind(e.kind)}`}
                >
                  {e.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
