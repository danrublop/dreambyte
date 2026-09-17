'use client'

import { useCallback, useEffect, useState } from 'react'
import { GitBranch, GitCommit, Plus, RefreshCw, Globe, ArrowUpCircle, ArrowDownCircle, Key, Trash2 } from 'lucide-react'
import { isNotInitialisedError, remoteTransportLabel, remoteAuthKind } from './git-ui-helpers'

/**
 * GitBranchesPanel.
 *
 * Surface for the Tier 2 git mirror — distinct from the in-DB `branches`
 * concept. The user picks a project folder (Tier 2), runs `git_init`
 * once, and then can branch / commit / inspect history from this panel.
 *
 * Talks to main via `window.dreambyteApi.git.*` (registered in
 * `src/electron/ipc/git.ts`). Stays render-only; no business logic here.
 */

interface Commit {
  sha: string
  date: string
  authorName: string
  authorEmail: string
  subject: string
}

interface Remote {
  name: string
  fetchUrl: string
  pushUrl: string
}

interface Props {
  projectId: string
}

export default function GitBranchesPanel({ projectId }: Props) {
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.git : undefined

  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [commits, setCommits] = useState<Commit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [notInitialised, setNotInitialised] = useState(false)
  const [remotes, setRemotes] = useState<Remote[]>([])
  const [remoteTokenState, setRemoteTokenState] = useState<Record<string, boolean>>({})
  const [connectingRemote, setConnectingRemote] = useState(false)
  const [newRemoteName, setNewRemoteName] = useState('origin')
  const [newRemoteUrl, setNewRemoteUrl] = useState('')
  const [newRemoteToken, setNewRemoteToken] = useState('')
  const [busyRemote, setBusyRemote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!ipc || !projectId) return
    setLoading(true)
    setError(null)
    try {
      const { branches: list, current: cur } = await ipc.branchList({ projectId })
      setBranches(list)
      setCurrent(cur)
      setNotInitialised(false)
      const { commits: log } = await ipc.log({ projectId, maxCount: 30 })
      setCommits(log)
      const { remotes: remoteList } = await ipc.remoteList({ projectId })
      setRemotes(remoteList)
      // Probe token presence for each remote — parallel, best-effort.
      const tokenChecks = await Promise.all(
        remoteList.map((r) =>
          ipc
            .hasRemoteToken({ projectId, remoteName: r.name })
            .then((res) => [r.name, res.has] as const)
            .catch(() => [r.name, false] as const),
        ),
      )
      setRemoteTokenState(Object.fromEntries(tokenChecks))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load git state'
      if (isNotInitialisedError(msg)) {
        setNotInitialised(true)
        setError(null)
      } else {
        setError(msg)
      }
      setBranches([])
      setCommits([])
      setRemotes([])
      setRemoteTokenState({})
    } finally {
      setLoading(false)
    }
  }, [ipc, projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function init() {
    if (!ipc || !projectId) return
    setLoading(true)
    setError(null)
    try {
      await ipc.init({ projectId })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'git init failed')
    } finally {
      setLoading(false)
    }
  }

  async function checkout(branch: string) {
    if (!ipc || !projectId || branch === current) return
    setLoading(true)
    setError(null)
    try {
      await ipc.checkout({ projectId, branch })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'checkout failed')
    } finally {
      setLoading(false)
    }
  }

  async function createBranch() {
    if (!ipc || !projectId || !newName.trim()) return
    setLoading(true)
    setError(null)
    try {
      await ipc.branchCreate({ projectId, name: newName.trim(), checkout: true })
      setNewName('')
      setCreating(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create branch failed')
    } finally {
      setLoading(false)
    }
  }

  async function commit() {
    if (!ipc || !projectId || !commitMessage.trim()) return
    setLoading(true)
    setError(null)
    try {
      await ipc.commit({ projectId, message: commitMessage.trim(), addAll: true })
      setCommitMessage('')
      setCommitting(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'commit failed')
    } finally {
      setLoading(false)
    }
  }

  async function connectRemote() {
    if (!ipc || !projectId || !newRemoteUrl.trim()) return
    setLoading(true)
    setError(null)
    const name = newRemoteName.trim() || 'origin'
    try {
      await ipc.remoteAdd({ projectId, name, url: newRemoteUrl.trim() })
      if (newRemoteToken.trim() && remoteAuthKind(newRemoteUrl.trim()) === 'https') {
        await ipc.setRemoteToken({ projectId, remoteName: name, token: newRemoteToken.trim() })
      }
      setNewRemoteName('origin')
      setNewRemoteUrl('')
      setNewRemoteToken('')
      setConnectingRemote(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect remote failed')
    } finally {
      setLoading(false)
    }
  }

  async function pushTo(remoteName: string) {
    if (!ipc || !projectId || !current) return
    setBusyRemote(remoteName)
    setError(null)
    try {
      await ipc.push({ projectId, remote: remoteName, ref: current })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'push failed')
    } finally {
      setBusyRemote(null)
    }
  }

  async function pullFrom(remoteName: string) {
    if (!ipc || !projectId || !current) return
    setBusyRemote(remoteName)
    setError(null)
    try {
      await ipc.pull({ projectId, remote: remoteName, ref: current })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'pull failed')
    } finally {
      setBusyRemote(null)
    }
  }

  async function clearTokenFor(remoteName: string) {
    if (!ipc || !projectId) return
    setBusyRemote(remoteName)
    try {
      await ipc.clearRemoteToken({ projectId, remoteName })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'clear token failed')
    } finally {
      setBusyRemote(null)
    }
  }

  async function setTokenFor(remoteName: string) {
    if (!ipc || !projectId) return
    const token = window.prompt(`Paste Personal Access Token for ${remoteName} (stored in OS keychain):`)
    if (!token) return
    setBusyRemote(remoteName)
    try {
      await ipc.setRemoteToken({ projectId, remoteName, token })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'set token failed')
    } finally {
      setBusyRemote(null)
    }
  }

  if (!ipc) {
    return (
      <div className="p-3 text-[11px] text-[var(--color-text-muted)]">
        Git collab is only available in the desktop app.
      </div>
    )
  }

  if (notInitialised) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-[11px] text-[var(--color-text-muted)]">
          This project's Tier 2 folder hasn't been initialised as a git repo. Run init to begin tracking history.
        </p>
        <button
          type="button"
          onClick={init}
          disabled={loading}
          className="no-style flex items-center gap-1.5 rounded bg-[var(--agent-chat-user-surface)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          <GitBranch size={12} />
          {loading ? 'Initialising…' : 'git init'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-[11px] text-[var(--color-text-primary)]">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
          <GitBranch size={11} />
          Tier 2 git
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh"
          className="no-style flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <p className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1 text-[10px] text-red-400">{error}</p>
      )}

      <section className="rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          <span>Branches ({branches.length})</span>
          <button
            type="button"
            onClick={() => setCreating((c) => !c)}
            className="no-style flex items-center gap-1 text-[10px] hover:text-[var(--color-text-primary)]"
          >
            <Plus size={10} /> New
          </button>
        </header>
        {creating && (
          <div className="flex items-center gap-1 px-2 py-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createBranch()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              placeholder="branch-name"
              className="flex-1 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] outline-none"
              disabled={loading}
            />
            <button
              type="button"
              onClick={createBranch}
              disabled={loading || !newName.trim()}
              className="no-style rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            >
              Create
            </button>
          </div>
        )}
        <ul className="max-h-32 overflow-y-auto">
          {branches.length === 0 && !loading && (
            <li className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">No branches yet.</li>
          )}
          {branches.map((b) => (
            <li key={b}>
              <button
                type="button"
                onClick={() => checkout(b)}
                disabled={loading || b === current}
                className={`no-style flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-[var(--agent-chat-user-surface)] ${b === current ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
              >
                <GitBranch size={10} />
                <span className="truncate">{b}</span>
                {b === current && (
                  <span className="ml-auto rounded bg-[var(--color-bg)] px-1 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                    current
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          <span>Remotes ({remotes.length})</span>
          <button
            type="button"
            onClick={() => setConnectingRemote((c) => !c)}
            className="no-style flex items-center gap-1 text-[10px] hover:text-[var(--color-text-primary)]"
          >
            <Globe size={10} /> Connect
          </button>
        </header>
        {connectingRemote && (
          <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-2 py-1">
            <input
              autoFocus
              value={newRemoteName}
              onChange={(e) => setNewRemoteName(e.target.value)}
              placeholder="name (default: origin)"
              className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] outline-none"
              disabled={loading}
            />
            <input
              value={newRemoteUrl}
              onChange={(e) => setNewRemoteUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] outline-none"
              disabled={loading}
            />
            <input
              type="password"
              value={newRemoteToken}
              onChange={(e) => setNewRemoteToken(e.target.value)}
              placeholder="Personal Access Token (https only — stored in OS keychain)"
              className="rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] outline-none"
              disabled={loading}
            />
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => {
                  setConnectingRemote(false)
                  setNewRemoteUrl('')
                  setNewRemoteToken('')
                }}
                className="no-style rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={connectRemote}
                disabled={loading || !newRemoteUrl.trim()}
                className="no-style rounded bg-[var(--agent-chat-user-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg)] disabled:opacity-50"
              >
                Connect
              </button>
            </div>
          </div>
        )}
        <ul>
          {remotes.length === 0 && !loading && (
            <li className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">No remotes configured.</li>
          )}
          {remotes.map((r) => {
            const transport = remoteTransportLabel(r.fetchUrl)
            const isHttps = remoteAuthKind(r.fetchUrl) === 'https'
            const hasToken = remoteTokenState[r.name] === true
            const busy = busyRemote === r.name
            return (
              <li
                key={r.name}
                className="flex flex-col gap-0.5 border-b border-[var(--color-border)] px-2 py-1 last:border-b-0"
              >
                <div className="flex items-center gap-1.5">
                  <Globe size={10} className="text-[var(--color-text-muted)]" />
                  <span className="text-[11px] text-[var(--color-text-primary)]">{r.name}</span>
                  <span className="text-[9px] text-[var(--color-text-muted)]">{transport}</span>
                  {isHttps && (
                    <span
                      className={`ml-1 rounded px-1 py-[1px] text-[9px] ${
                        hasToken ? 'bg-green-400/15 text-green-400' : 'bg-yellow-400/15 text-yellow-400'
                      }`}
                    >
                      {hasToken ? 'token saved' : 'no token'}
                    </span>
                  )}
                </div>
                <span className="truncate text-[10px] text-[var(--color-text-muted)]">{r.fetchUrl}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => pushTo(r.name)}
                    disabled={busy || !current}
                    className="no-style flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                    data-tooltip={current ? `Push ${current}` : 'No branch checked out'}
                  >
                    <ArrowUpCircle size={10} /> Push
                  </button>
                  <button
                    type="button"
                    onClick={() => pullFrom(r.name)}
                    disabled={busy || !current}
                    className="no-style flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                  >
                    <ArrowDownCircle size={10} /> Pull
                  </button>
                  {isHttps && (
                    <button
                      type="button"
                      onClick={() => setTokenFor(r.name)}
                      disabled={busy}
                      className="no-style ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                      data-tooltip={hasToken ? 'Replace token' : 'Set token'}
                    >
                      <Key size={10} />
                    </button>
                  )}
                  {isHttps && hasToken && (
                    <button
                      type="button"
                      onClick={() => clearTokenFor(r.name)}
                      disabled={busy}
                      className="no-style flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-red-400 disabled:opacity-40"
                      data-tooltip="Clear token"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="flex flex-1 flex-col rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          <span>History ({commits.length})</span>
          <button
            type="button"
            onClick={() => setCommitting((c) => !c)}
            className="no-style flex items-center gap-1 text-[10px] hover:text-[var(--color-text-primary)]"
          >
            <GitCommit size={10} /> Commit
          </button>
        </header>
        {committing && (
          <div className="flex items-center gap-1 px-2 py-1">
            <input
              autoFocus
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') {
                  setCommitting(false)
                  setCommitMessage('')
                }
              }}
              placeholder="commit message"
              className="flex-1 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] outline-none"
              disabled={loading}
            />
            <button
              type="button"
              onClick={commit}
              disabled={loading || !commitMessage.trim()}
              className="no-style rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            >
              Commit
            </button>
          </div>
        )}
        <ul className="flex-1 overflow-y-auto">
          {commits.length === 0 && !loading && (
            <li className="px-2 py-2 text-[10px] text-[var(--color-text-muted)]">No commits yet.</li>
          )}
          {commits.map((c) => (
            <li
              key={c.sha}
              className="flex flex-col gap-0.5 border-b border-[var(--color-border)] px-2 py-1 last:border-b-0"
            >
              <span className="text-[11px] text-[var(--color-text-primary)]">{c.subject}</span>
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {c.authorName} · {c.sha.slice(0, 7)} · {new Date(c.date).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
