'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { ConversationSearchResult } from '@/types/dreambyte-api'

export const COMMAND_ITEMS: { id: string; label: string; hint?: string; action: string }[] = [
  { id: 'settings', label: 'Settings', hint: 'General settings', action: 'settings' },
  { id: 'agents', label: 'Agents', hint: 'Agent configuration', action: 'agents' },
  { id: 'projects', label: 'Projects', hint: 'Open projects panel', action: 'projects' },
  { id: 'new-scene', label: 'New Scene', hint: 'Add a new scene', action: 'new-scene' },
  { id: 'layers', label: 'Layers', hint: 'Scenes & layers panel', action: 'layers' },
  { id: 'media', label: 'Library', hint: 'Media library', action: 'media' },
  { id: 'export', label: 'Export / Publish', hint: 'Export or publish project', action: 'export' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', hint: 'Show all keyboard shortcuts', action: 'shortcuts' },
  {
    id: 'tier2-mirror',
    label: 'Mirror project to folder…',
    hint: 'Pick a folder for the .dreambyte/ mirror',
    action: 'tier2-mirror',
  },
  {
    id: 'tier2-export',
    label: 'Update folder mirror',
    hint: 'Re-export to the configured .dreambyte/ folder',
    action: 'tier2-export',
  },
  {
    id: 'tier2-reveal',
    label: 'Reveal mirror in Finder',
    hint: 'Open the project’s .dreambyte/ folder',
    action: 'tier2-reveal',
  },
  {
    id: 'git-panel',
    label: 'Git: branches & history…',
    hint: 'Open the Tier 2 git panel (branches + commits + diff)',
    action: 'git-panel',
  },
]

export type CommandPaletteAction =
  | { type: 'command'; action: string }
  | { type: 'open-project'; projectId: string }
  | { type: 'open-conversation'; projectId: string; conversationId: string }

/** Debounced conversation search. Excludes archived by default. */
function useConversationSearch(query: string): ConversationSearchResult[] {
  const [results, setResults] = useState<ConversationSearchResult[]>([])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
    if (!ipc?.search) {
      setResults([])
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      ipc
        .search({ query: q, limit: 50 })
        .then((r) => {
          if (!cancelled) setResults(r.results)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query])

  return results
}

/**
 * Global command palette. Lifted out of Editor so the shell-scoped
 * Search button can open it in any view. Sections:
 *   - Projects (welcome/home only — when `projects` is non-empty)
 *   - Commands (editor actions)
 *   - Conversations (title + message content search, archived excluded)
 */
export function CommandPalette({
  onClose,
  onAction,
  projects = [],
}: {
  onClose: () => void
  onAction: (action: CommandPaletteAction) => void
  projects?: { id: string; name: string }[]
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const isProjectSearch = projects.length > 0
  const conversationResults = useConversationSearch(query)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const lowerQuery = query.toLowerCase()
  const filteredProjects = isProjectSearch ? projects.filter((p) => p.name.toLowerCase().includes(lowerQuery)) : []
  const filteredCommands = isProjectSearch
    ? []
    : COMMAND_ITEMS.filter(
        (item) =>
          item.label.toLowerCase().includes(lowerQuery) || (item.hint && item.hint.toLowerCase().includes(lowerQuery)),
      )

  // Flattened navigable list: projects → commands → conversations.
  type Row =
    | { kind: 'project'; id: string; name: string }
    | { kind: 'command'; id: string; label: string; hint?: string; action: string }
    | { kind: 'conversation'; result: ConversationSearchResult }
  const rows: Row[] = [
    ...filteredProjects.map((p) => ({ kind: 'project' as const, id: p.id, name: p.name })),
    ...filteredCommands.map((c) => ({ kind: 'command' as const, ...c })),
    ...conversationResults.map((r) => ({ kind: 'conversation' as const, result: r })),
  ]

  const [selectedIndex, setSelectedIndex] = useState(0)
  useEffect(() => setSelectedIndex(0), [query])

  const fire = (row: Row) => {
    if (row.kind === 'project') onAction({ type: 'open-project', projectId: row.id })
    else if (row.kind === 'command') onAction({ type: 'command', action: row.action })
    else
      onAction({
        type: 'open-conversation',
        projectId: row.result.projectId,
        conversationId: row.result.conversationId,
      })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && rows[selectedIndex]) {
      fire(rows[selectedIndex])
    }
  }

  const conversationStart = filteredProjects.length + filteredCommands.length

  return (
    <>
      <div className="fixed inset-0 z-[9999] bg-transparent" onClick={onClose} />
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[10000] w-[min(540px,90vw)] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in slide-in-from-top-1 duration-150">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
          <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isProjectSearch ? 'Search projects & conversations...' : 'Search commands & conversations...'}
            className="flex-1 bg-transparent border-none outline-none text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
            style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1 }}
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto custom-scrollbar" style={{ padding: 4 }}>
          {rows.length === 0 && (
            <p
              className="px-4 py-8 text-center text-[var(--color-text-muted)]"
              style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1 }}
            >
              No results found
            </p>
          )}

          {rows.map((row, i) => {
            const isFirstConversation = i === conversationStart && row.kind === 'conversation'
            return (
              <div key={`${row.kind}-${i}`}>
                {isFirstConversation && (
                  <div
                    style={{
                      padding: '4px 8px 2px',
                      fontSize: 10,
                      fontWeight: 600,
                      lineHeight: 1,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    Conversations
                  </div>
                )}
                <div
                  onClick={() => fire(row)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className="flex items-center cursor-pointer"
                  style={{
                    gap: 8,
                    padding: '5px 8px',
                    borderRadius: 6,
                    transition: 'background 0.12s ease',
                    background:
                      i === selectedIndex
                        ? 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
                        : 'transparent',
                  }}
                >
                  {row.kind === 'project' && (
                    <>
                      <span
                        className="flex-1 whitespace-nowrap text-[var(--color-text-primary)]"
                        style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1 }}
                      >
                        {row.name}
                      </span>
                      <span
                        className="text-[var(--color-text-muted)]"
                        style={{ fontSize: 10, fontWeight: 600, lineHeight: 1 }}
                      >
                        Open
                      </span>
                    </>
                  )}
                  {row.kind === 'command' && (
                    <>
                      <span
                        className="flex-1 whitespace-nowrap text-[var(--color-text-primary)]"
                        style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1 }}
                      >
                        {row.label}
                      </span>
                      {row.hint && (
                        <span
                          className="text-[var(--color-text-muted)]"
                          style={{ fontSize: 10, fontWeight: 600, lineHeight: 1 }}
                        >
                          {row.hint}
                        </span>
                      )}
                    </>
                  )}
                  {row.kind === 'conversation' && (
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[var(--color-text-primary)]"
                        style={{ fontSize: 12.5, fontWeight: 450, lineHeight: 1 }}
                      >
                        {row.result.title || 'Untitled chat'}
                      </div>
                      {row.result.matchedOn === 'message' && row.result.snippet && (
                        <div
                          className="truncate text-[var(--color-text-muted)]"
                          style={{ fontSize: 10, fontWeight: 450, lineHeight: 1.3, marginTop: 2 }}
                        >
                          {row.result.snippet}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

export default CommandPalette
