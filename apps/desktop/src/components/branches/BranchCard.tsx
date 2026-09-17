'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitBranch, Plus, MoreVertical, RotateCcw, Check, Loader2, History, X } from 'lucide-react'
import { MenuGroup, MenuRow, MenuSurface } from '@/components/ui/MenuDropdown'
import { Segmented } from '@/components/settings/shared'
import type { BranchRecord, BranchHistoryEntry } from '@/types/dreambyte-api'
import { useBranchActions } from './use-branch-actions'

interface BranchCardProps {
  projectId: string
  branches: BranchRecord[]
  activeBranchId: string | null
  /** Switch the editor to a branch. */
  onSwitch: (id: string) => void
  /** Force-reload the active branch's scenes (used after a restore, which
   *  mutates the already-active branch in place). */
  onReload: () => void
  onClose: () => void
  /** Bump the branch-list cache so the list refetches after a mutation. */
  onChanged: () => void
  /** Navigate the editor to a (forked) project. */
  onOpenProject: (id: string) => void
}

type Tab = 'branches' | 'history'

/** Which inline name-input is open (instead of window.prompt()). */
type PendingInput = { kind: 'rename' | 'clone' | 'fork'; branch: BranchRecord } | null
/** Which inline confirm is open (instead of window.confirm()). */
type PendingConfirm = { kind: 'delete'; branch: BranchRecord } | { kind: 'restore'; entry: BranchHistoryEntry } | null

function relTime(d: Date | string | number): string {
  const date = new Date(d)
  const diff = Date.now() - date.getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function entryLabel(e: BranchHistoryEntry): string {
  if (e.label) return e.label
  if (e.source === 'branch-init') return 'Branch created'
  if (e.source === 'restore') return 'Restored'
  if (e.operation) return e.operation.replace(/_/g, ' ')
  return 'Edit'
}

/** The card's inline name editor — one component for create / rename / clone /
 *  fork so every name flow shares the polished row instead of window.prompt. */
function InlineNameInput({
  icon,
  placeholder,
  initialValue,
  confirmLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  icon?: React.ReactNode
  placeholder: string
  initialValue?: string
  confirmLabel: string
  busy: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue ?? '')
  const canSubmit = value.trim().length > 0 && !busy
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      {icon}
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSubmit) onSubmit(value.trim())
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        className="no-style flex-1 bg-transparent outline-none"
        style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}
      />
      <button
        type="button"
        onClick={() => canSubmit && onSubmit(value.trim())}
        disabled={!canSubmit}
        className="no-style text-[11px] px-1.5 py-0.5 rounded disabled:opacity-40"
        style={{ color: 'var(--color-accent, var(--color-text-primary))', fontWeight: 500 }}
      >
        {busy ? '…' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="no-style text-[11px] px-1 py-0.5 rounded"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Cancel
      </button>
    </div>
  )
}

/** Inline destructive confirm — replaces window.confirm for delete / restore. */
function InlineConfirm({
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span className="flex-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
        {message}
      </span>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="no-style text-[11px] px-1.5 py-0.5 rounded disabled:opacity-40"
        style={{ color: 'var(--danger)', fontWeight: 500 }}
      >
        {busy ? '…' : confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="no-style text-[11px] px-1 py-0.5 rounded"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Cancel
      </button>
    </div>
  )
}

export default function BranchCard({
  projectId,
  branches,
  activeBranchId,
  onSwitch,
  onReload,
  onClose,
  onChanged,
  onOpenProject,
}: BranchCardProps) {
  const [tab, setTab] = useState<Tab>('branches')
  // Floating row menu (portaled — the card/chat overflow would clip an
  // in-flow dropdown). Anchored to the kebab's rect, right-aligned.
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [pendingInput, setPendingInput] = useState<PendingInput>(null)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null)

  // Close the floating menu on any outside mousedown or Escape (same marker
  // pattern as TrackRow's clip context menu).
  useEffect(() => {
    if (!menuFor) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('[data-branch-row-menu]')) return
      setMenuFor(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  const activeBranch = branches.find((b) => b.id === activeBranchId) ?? branches.find((b) => b.isDefault)
  const actions = useBranchActions(projectId, { onChanged, onReload, onClose, onOpenProject })
  const { busy, error } = actions

  useEffect(() => {
    if (tab !== 'history' || !actions.available || !activeBranch) return
    return actions.history.load(activeBranch.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, actions.available, projectId, activeBranch?.id])

  /** Open an inline name input for a branch action (closes the row menu). */
  const askName = (kind: NonNullable<PendingInput>['kind'], branch: BranchRecord) => {
    setMenuFor(null)
    setPendingConfirm(null)
    setPendingInput({ kind, branch })
  }

  const submitName = (name: string) => {
    if (!pendingInput) return
    const { kind, branch } = pendingInput
    setPendingInput(null)
    if (kind === 'rename') {
      if (name !== branch.name) void actions.rename(branch, name)
    } else if (kind === 'clone') {
      void actions.clone(branch, name)
    } else {
      void actions.fork(branch, name)
    }
  }

  const inputDefaults: Record<
    NonNullable<PendingInput>['kind'],
    { placeholder: string; initial: (b: BranchRecord) => string; confirm: string }
  > = {
    rename: { placeholder: 'Branch name…', initial: (b) => b.name, confirm: 'Rename' },
    clone: { placeholder: 'Cloned branch name…', initial: (b) => `${b.name}-copy`, confirm: 'Clone' },
    fork: { placeholder: 'New project name…', initial: (b) => `${b.name} (fork)`, confirm: 'Fork' },
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // Match the in-chat permission/generation card chrome (full column width,
  // transparent fill, light border, no shadow) so it reads as part of the
  // conversation rather than a floating popover.
  return (
    <div className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent text-[12px]">
      {/* Tabs (segmented control — matches Rules/Skills/Models) + close */}
      <div className="flex items-center gap-1 px-1.5 pt-1.5 pb-1.5">
        <Segmented
          options={[
            { value: 'branches', label: 'Branches' },
            { value: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="no-style grid h-5 w-5 place-items-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--color-text-primary)_12%,transparent)]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <X size={13} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {tab === 'branches' && (
        <>
          <MenuGroup>
            <div>
              {branches.map((b) => {
                const isActive = b.id === activeBranchId
                const rowBusy = busy?.endsWith(`:${b.id}`) ?? false
                const canDelete = !b.isDefault && !isActive
                const rowInput = pendingInput?.branch.id === b.id ? pendingInput : null
                const rowConfirm = pendingConfirm?.kind === 'delete' && pendingConfirm.branch.id === b.id
                return (
                  <div key={b.id} className="relative">
                    <button
                      onClick={() => {
                        onSwitch(b.id)
                        onClose()
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                      className="w-full !flex !flex-row items-center no-style text-left"
                      style={{ gap: 8, padding: '5px 8px', borderRadius: 6, background: 'transparent' }}
                    >
                      <GitBranch size={13} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                      <span
                        className="flex-1 truncate"
                        style={{ fontSize: 12.5, fontWeight: 450, color: 'var(--color-text-primary)' }}
                      >
                        {b.name}
                        {b.isDefault && (
                          <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--color-text-muted)' }}>main</span>
                        )}
                      </span>
                      {rowBusy && (
                        <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                      )}
                      {isActive && !rowBusy && (
                        <Check
                          size={13}
                          strokeWidth={2.5}
                          style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
                        />
                      )}
                      <span
                        role="button"
                        tabIndex={0}
                        // Marker shared with the portal so the outside-mousedown
                        // close SKIPS the kebab: without it, the native mousedown
                        // closed the menu and the synthetic click then re-opened
                        // it — the kebab could never dismiss its own menu
                        // (review #162; TrackRow never hits this because its
                        // right-click trigger has no `click` follow-up).
                        data-branch-row-menu
                        onClick={(e) => {
                          e.stopPropagation()
                          setPendingInput(null)
                          setPendingConfirm(null)
                          if (menuFor?.id === b.id) {
                            setMenuFor(null)
                          } else {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            setMenuFor({ id: b.id, x: rect.right, y: rect.bottom + 4 })
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            ;(e.currentTarget as HTMLElement).click()
                          }
                        }}
                        className="grid h-5 w-5 place-items-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--color-text-primary)_12%,transparent)]"
                        style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
                      >
                        <MoreVertical size={13} />
                      </span>
                    </button>

                    {menuFor?.id === b.id &&
                      typeof document !== 'undefined' &&
                      createPortal(
                        // Floating popover, portaled to body — the card / chat
                        // column clips overflow, so an in-flow dropdown either
                        // grew the card or got cut off. Right-aligned to the
                        // kebab via translateX(-100%).
                        <div
                          role="menu"
                          aria-label={`Branch actions: ${b.name}`}
                          data-branch-row-menu
                          className="fixed z-[1000]"
                          style={{ left: menuFor.x, top: menuFor.y, transform: 'translateX(-100%)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MenuSurface className="min-w-[185px]">
                            <MenuGroup>
                              <MenuRow name="Rename…" onClick={() => askName('rename', b)} />
                              {!b.isDefault && (
                                <MenuRow
                                  name="Set as main"
                                  onClick={() => {
                                    setMenuFor(null)
                                    void actions.setDefault(b)
                                  }}
                                />
                              )}
                              <MenuRow name="Clone branch…" onClick={() => askName('clone', b)} />
                              <MenuRow name="Fork to new project…" onClick={() => askName('fork', b)} />
                            </MenuGroup>
                            <MenuGroup divider>
                              <MenuRow
                                name="Delete"
                                destructive
                                disabled={!canDelete}
                                hint={b.isDefault ? 'main' : isActive ? 'active' : undefined}
                                onClick={() => {
                                  setMenuFor(null)
                                  setPendingConfirm({ kind: 'delete', branch: b })
                                }}
                              />
                            </MenuGroup>
                          </MenuSurface>
                        </div>,
                        document.body,
                      )}

                    {rowInput && (
                      <div
                        // Keyed by kind so switching rename→clone→fork always
                        // remounts the input with the right prefill (its value
                        // state reads initialValue on mount only).
                        key={`${rowInput.kind}:${b.id}`}
                        className="mb-1 ml-5 mr-1 rounded-md border border-[var(--color-border)]"
                        style={{ background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)' }}
                      >
                        <InlineNameInput
                          placeholder={inputDefaults[rowInput.kind].placeholder}
                          initialValue={inputDefaults[rowInput.kind].initial(b)}
                          confirmLabel={inputDefaults[rowInput.kind].confirm}
                          busy={rowBusy}
                          onSubmit={submitName}
                          onCancel={() => setPendingInput(null)}
                        />
                      </div>
                    )}

                    {rowConfirm && (
                      <div
                        className="mb-1 ml-5 mr-1 rounded-md border border-[var(--color-border)]"
                        style={{ background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)' }}
                      >
                        <InlineConfirm
                          message={`Delete branch "${b.name}"? This can't be undone.`}
                          confirmLabel="Delete"
                          busy={rowBusy}
                          onConfirm={() => {
                            setPendingConfirm(null)
                            void actions.remove(b)
                          }}
                          onCancel={() => setPendingConfirm(null)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </MenuGroup>
          <MenuGroup divider>
            {creating ? (
              <InlineNameInput
                icon={<Plus size={13} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />}
                placeholder="Branch name…"
                confirmLabel="Create"
                busy={busy === 'create-new'}
                onSubmit={(name) => {
                  setCreating(false)
                  void actions.createBranch(name, activeBranch?.id)
                }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <MenuRow icon={<Plus size={13} />} name="New branch" muted onClick={() => setCreating(true)} />
            )}
          </MenuGroup>
        </>
      )}

      {tab === 'history' && (
        // Mirrors the Branches list anatomy exactly: MenuGroup wrapper, leading
        // icon, single-line 12.5/450 label with inline muted meta (like the
        // "main" badge), right-side hover affordance.
        <MenuGroup>
          <div className="max-h-[280px] overflow-y-auto">
            {actions.history.loading && (
              <div
                className="flex items-center gap-2 px-2 py-2 text-[11px]"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            )}
            {!actions.history.loading && actions.history.entries.length === 0 && (
              <div className="px-2 py-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                No history yet.
              </div>
            )}
            {!actions.history.loading &&
              actions.history.entries.map((e) => {
                const rowBusy = busy === `restore:${e.key}`
                const confirming = pendingConfirm?.kind === 'restore' && pendingConfirm.entry.key === e.key
                return (
                  <div key={e.key}>
                    <button
                      onClick={() => setPendingConfirm(confirming ? null : { kind: 'restore', entry: e })}
                      onMouseEnter={(ev) => {
                        ev.currentTarget.style.background =
                          'color-mix(in srgb, var(--color-text-primary) 8%, transparent)'
                      }}
                      onMouseLeave={(ev) => {
                        ev.currentTarget.style.background = 'transparent'
                      }}
                      className="group w-full !flex !flex-row items-center no-style text-left"
                      style={{ gap: 8, padding: '5px 8px', borderRadius: 6, background: 'transparent' }}
                    >
                      <History size={13} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                      <span
                        className="flex-1 truncate"
                        style={{ fontSize: 12.5, fontWeight: 450, color: 'var(--color-text-primary)' }}
                      >
                        {entryLabel(e)}
                        <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--color-text-muted)' }}>
                          {relTime(e.createdAt)}
                          {e.sceneCount > 1 ? ` · ${e.sceneCount} scenes` : ''}
                        </span>
                      </span>
                      {rowBusy ? (
                        <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
                      ) : (
                        <RotateCcw
                          size={12}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}
                        />
                      )}
                    </button>
                    {confirming && activeBranch && (
                      <div
                        className="mb-1 ml-5 mr-1 rounded-md border border-[var(--color-border)]"
                        style={{ background: 'color-mix(in srgb, var(--color-text-primary) 4%, transparent)' }}
                      >
                        <InlineConfirm
                          message="Restore to this point? Current scenes revert (history is kept)."
                          confirmLabel="Restore"
                          busy={rowBusy}
                          onConfirm={() => {
                            setPendingConfirm(null)
                            void actions.restore(activeBranch.id, e)
                          }}
                          onCancel={() => setPendingConfirm(null)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </MenuGroup>
      )}
    </div>
  )
}
