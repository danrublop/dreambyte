'use client'

import { useState, useCallback, useEffect } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'

/** Rounded-square glyph — the workspace (project) symbol. */
function WorkspaceGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
    </svg>
  )
}

// Minimal shape we render from the conversations IPC (avoids coupling to a
// specific ConversationSummary variant — the IPC and store types differ).
type ChatRow = { id: string; title?: string | null; isArchived?: boolean }

type CacheState = { loading: boolean; error: boolean; items: ChatRow[] | null }

/**
 * A project row in the sidebar tree (project = workspace). Expanding it lazily
 * loads that project's agent chats (conversations) via the conversations IPC and
 * caches them. Clicking the project opens it (chat view) and expands; clicking a
 * nested chat opens that project on that conversation.
 */
export default function ProjectTreeItem({
  id,
  name,
  active,
  activeConversationId,
  defaultExpanded = false,
  onOpenProject,
  onOpenChat,
}: {
  id: string
  name: string
  active: boolean
  activeConversationId: string | null
  defaultExpanded?: boolean
  onOpenProject: (projectId: string) => void
  onOpenChat: (projectId: string, conversationId: string) => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [cache, setCache] = useState<CacheState>({ loading: false, error: false, items: null })

  // `silent` keeps the current items visible while re-fetching (no spinner /
  // no flash to empty) — used for background refreshes when the list goes stale.
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setCache({ loading: true, error: false, items: null })
      try {
        const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.conversations : undefined
        if (!ipc?.list) {
          if (!silent) setCache({ loading: false, error: false, items: [] })
          return
        }
        const res = await ipc.list(id)
        const items = ((res?.conversations as ChatRow[] | undefined) ?? []).filter((c) => !c.isArchived)
        setCache({ loading: false, error: false, items })
      } catch {
        // A failed silent refresh leaves the existing list intact.
        if (!silent) setCache({ loading: false, error: true, items: null })
      }
    },
    [id],
  )

  // Lazy initial load: the first time the row is expanded (incl. defaultExpanded
  // for the active project), fetch its chats. Runs in an effect so it never
  // fires during a render-phase state update. A prior error is left for the
  // retry button, not auto-retried.
  useEffect(() => {
    if (expanded && cache.items === null && !cache.loading && !cache.error) void load()
  }, [expanded, cache.items, cache.loading, cache.error, load])

  // Keep the expanded list fresh: when a new conversation becomes active in
  // THIS project (e.g. the agent created a chat in the chat view) and it isn't
  // in the cached list yet, the list is stale — refresh it in the background.
  useEffect(() => {
    if (!expanded || !active || !activeConversationId) return
    const items = cache.items
    if (!items || cache.loading) return
    if (!items.some((c) => c.id === activeConversationId)) void load(true)
  }, [expanded, active, activeConversationId, cache.items, cache.loading, load])

  const toggle = useCallback(() => setExpanded((prev) => !prev), [])

  const openProject = () => {
    onOpenProject(id)
    if (!expanded) setExpanded(true)
  }

  return (
    <div>
      <div
        className={`group flex h-[30px] items-center gap-2.5 rounded-[var(--radius-md)] px-3 text-[13.5px] ${
          active
            ? 'bg-[var(--card)] text-[var(--ink)]'
            : 'text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]'
        }`}
      >
        {/* Symbol slot: media-library glyph by default; chevron appears on hover. */}
        <button
          onClick={toggle}
          className="no-style relative grid h-4 w-4 shrink-0 place-items-center"
          title={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
        >
          <span
            className="text-[var(--graphite)] transition-opacity group-hover:opacity-0"
            style={active ? { color: 'var(--accent)' } : undefined}
          >
            <WorkspaceGlyph size={16} />
          </span>
          <ChevronRight
            size={13}
            className="absolute text-[var(--graphite)] opacity-0 transition-all group-hover:opacity-100"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
          />
        </button>
        <button onClick={openProject} className="no-style min-w-0 flex-1 truncate text-left">
          {name || 'Untitled'}
        </button>
      </div>

      {expanded && (
        <div className="ml-[30px]">
          {cache.loading && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-[var(--mute)]">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          )}
          {cache.error && (
            <button
              onClick={() => void load()}
              className="no-style px-2 py-1.5 text-[12px] text-[var(--graphite)] hover:text-[var(--ink)]"
            >
              Couldn&apos;t load chats — retry
            </button>
          )}
          {!cache.loading && !cache.error && cache.items?.length === 0 && (
            <div className="px-2 py-1.5 text-[12px] text-[var(--mute)]">No chats yet</div>
          )}
          {!cache.loading &&
            !cache.error &&
            cache.items?.map((c) => {
              const chatActive = active && activeConversationId === c.id
              return (
                <button
                  key={c.id}
                  onClick={() => onOpenChat(id, c.id)}
                  className={`no-style flex h-[26px] w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] ${
                    chatActive
                      ? 'bg-[var(--card)] text-[var(--ink)]'
                      : 'text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]'
                  }`}
                >
                  <span
                    className="h-[5px] w-[5px] flex-none rounded-full"
                    style={{ background: chatActive ? 'var(--accent)' : 'var(--mute)' }}
                  />
                  <span className="truncate">{c.title || 'New chat'}</span>
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}
