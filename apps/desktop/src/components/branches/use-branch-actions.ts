'use client'

/**
 * B12 — branch-mutation orchestration extracted from BranchCard. The card was
 * mixing IPC calls for 6 mutations + history fetch + rendering in one 443-line
 * component, and fork/restore used bespoke .then/.catch chains that SKIPPED
 * the shared run() pipeline — so they never bumped the branch-list cache
 * (onChanged) and their busy/error handling drifted from the other actions.
 *
 * Every mutation now goes through ONE run(): busy keying, error capture,
 * onChanged() on success, and an optional `after` for navigation side effects
 * (fork opens the new project; restore reloads + closes). The card keeps only
 * render state (tabs, menus, pending inline inputs).
 */

import { useCallback, useState } from 'react'
import type { BranchRecord, BranchHistoryEntry } from '@/types/dreambyte-api'

export interface BranchActionCallbacks {
  /** Bump the branch-list cache so the list refetches after a mutation. */
  onChanged: () => void
  /** Force-reload the active branch's scenes (restore mutates it in place). */
  onReload: () => void
  onClose: () => void
  /** Navigate the editor to a (forked) project. */
  onOpenProject: (id: string) => void
}

export function useBranchActions(projectId: string, callbacks: BranchActionCallbacks) {
  const { onChanged, onReload, onClose, onOpenProject } = callbacks
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.branches : undefined
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * The single mutation pipeline: busy key for per-row spinners, error
   * surfaced on the card, onChanged() after EVERY success (a fork or restore
   * can change what the list should show too), then the action's own
   * navigation side effect.
   */
  const run = useCallback(
    async (key: string, fn: () => Promise<void>, after?: () => void) => {
      if (!ipc) return
      setBusy(key)
      setError(null)
      try {
        await fn()
        onChanged()
        after?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Operation failed')
      } finally {
        setBusy(null)
      }
    },
    [ipc, onChanged],
  )

  const createBranch = useCallback(
    (name: string, sourceBranchId?: string) =>
      run('create-new', async () => {
        await ipc!.create({ projectId, name, sourceBranchId })
      }),
    [run, ipc, projectId],
  )

  const rename = useCallback(
    (b: BranchRecord, name: string) =>
      run(`rename:${b.id}`, async () => {
        await ipc!.rename({ projectId, id: b.id, name })
      }),
    [run, ipc, projectId],
  )

  const clone = useCallback(
    (b: BranchRecord, name: string) =>
      run(`clone:${b.id}`, async () => {
        await ipc!.create({ projectId, name, sourceBranchId: b.id })
      }),
    [run, ipc, projectId],
  )

  const setDefault = useCallback(
    (b: BranchRecord) =>
      run(`default:${b.id}`, async () => {
        await ipc!.setDefault({ projectId, id: b.id })
      }),
    [run, ipc, projectId],
  )

  const remove = useCallback(
    (b: BranchRecord) =>
      run(`delete:${b.id}`, async () => {
        await ipc!.delete({ projectId, id: b.id })
      }),
    [run, ipc, projectId],
  )

  const fork = useCallback(
    (b: BranchRecord, name?: string) => {
      let forkedProjectId: string | null = null
      return run(
        `fork:${b.id}`,
        async () => {
          const res = await ipc!.fork({ sourceProjectId: projectId, sourceBranchId: b.id, name })
          forkedProjectId = res.projectId
        },
        () => {
          onClose()
          if (forkedProjectId) onOpenProject(forkedProjectId)
        },
      )
    },
    [run, ipc, projectId, onClose, onOpenProject],
  )

  const restore = useCallback(
    (branchId: string, entry: BranchHistoryEntry) =>
      run(
        `restore:${entry.key}`,
        async () => {
          await ipc!.restoreToPoint({ projectId, branchId, key: entry.key })
        },
        () => {
          onReload() // restore mutates the active branch in place — force a scene reload
          onClose()
        },
      ),
    [run, ipc, projectId, onReload, onClose],
  )

  // ── History (read-only fetch, same error-isolation as before) ───────────────
  const [entries, setEntries] = useState<BranchHistoryEntry[]>([])
  const [histLoading, setHistLoading] = useState(false)

  /** Returns a cancel function — callers (the tab effect) invoke it on cleanup. */
  const loadHistory = useCallback(
    (branchId: string): (() => void) => {
      if (!ipc) return () => {}
      let cancelled = false
      setHistLoading(true)
      ipc
        .history({ projectId, branchId })
        .then((r) => {
          if (!cancelled) setEntries(r.entries as BranchHistoryEntry[])
        })
        .catch(() => !cancelled && setEntries([]))
        .finally(() => !cancelled && setHistLoading(false))
      return () => {
        cancelled = true
      }
    },
    [ipc, projectId],
  )

  return {
    available: !!ipc,
    busy,
    error,
    createBranch,
    rename,
    clone,
    setDefault,
    remove,
    fork,
    restore,
    history: { entries, loading: histLoading, load: loadHistory },
  }
}
