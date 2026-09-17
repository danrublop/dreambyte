'use client'

import { useVideoStore } from '@/lib/store'
import {
  Package2,
  Briefcase,
  History,
  Download,
  Sparkles,
  Layers,
  Film,
  Volume2,
  Type,
  Code2,
  Loader2,
  X,
} from 'lucide-react'
import { type LayersStripTabId, LAYERS_STRIP_TAB_LABELS, parseLayersStripCenterTabId } from '@/lib/layers-strip-dock'
import { useBranches } from '@/lib/hooks/use-branches'

function parseBranchPreviewTabId(tabId: string): string | null {
  return tabId.startsWith('preview:') ? tabId.slice('preview:'.length) : null
}

/** The editor's original preview glyph (rounded square + play triangle). */
function PreviewIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M10 8.5V15.5L16 12L10 8.5Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Media-library glyph — matches the sidebar Library icon and editor Media button. */
function MediaTabIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.1935 16.793C20.8437 19.2739 20.6689 20.5143 19.7717 21.2572C18.8745 22 17.5512 22 14.9046 22H9.09536C6.44881 22 5.12553 22 4.22834 21.2572C3.33115 20.5143 3.15626 19.2739 2.80648 16.793L2.38351 13.793C1.93748 10.6294 1.71447 9.04765 2.66232 8.02383C3.61017 7 5.29758 7 8.67239 7H15.3276C18.7024 7 20.3898 7 21.3377 8.02383C22.0865 8.83268 22.1045 9.98979 21.8592 12" />
      <path d="M19.5617 7C19.7904 5.69523 18.7863 4.5 17.4617 4.5H6.53788C5.21323 4.5 4.20922 5.69523 4.43784 7" />
      <path d="M17.4999 4.5C17.5283 4.24092 17.5425 4.11135 17.5427 4.00435C17.545 2.98072 16.7739 2.12064 15.7561 2.01142C15.6497 2 15.5194 2 15.2588 2H8.74099C8.48035 2 8.35002 2 8.24362 2.01142C7.22584 2.12064 6.45481 2.98072 6.45704 4.00434C6.45727 4.11135 6.47146 4.2409 6.49983 4.5" />
      <circle cx="16.5" cy="11.5" r="1.5" />
      <path d="M19.9999 20L17.1157 17.8514C16.1856 17.1586 14.8004 17.0896 13.7766 17.6851L13.5098 17.8403C12.7984 18.2542 11.8304 18.1848 11.2156 17.6758L7.37738 14.4989C6.6113 13.8648 5.38245 13.8309 4.5671 14.4214L3.24316 15.3803" />
    </svg>
  )
}

function LayerDockTabIcon({ id, size = 13 }: { id: LayersStripTabId; size?: number }) {
  const p = { size, strokeWidth: 1.5 as const }
  switch (id) {
    case 'studio':
      return <Film {...p} />
    case 'audio':
      return <Volume2 {...p} />
    case 'text':
      return <Type {...p} />
    case 'nodemap':
    default:
      return <Layers {...p} />
  }
}

/**
 * The editor's open center tabs, rendered as pills for the shell top bar (inline
 * with the project name). Store-driven so it can live outside Editor.tsx. The
 * editor's own VS Code tab strip is hidden in embedded mode; content switching
 * still keys off the store's `centerTab`.
 */
export default function CenterTabs() {
  const centerOpenTabs = useVideoStore((s) => s.centerOpenTabs)
  const centerTab = useVideoStore((s) => s.centerTab)
  const setCenterTab = useVideoStore((s) => s.setCenterTab)
  const closeCenterTab = useVideoStore((s) => s.closeCenterTab)
  const projectId = useVideoStore((s) => s.project?.id)
  const branches = useBranches(projectId)
  const switchProjectBranch = useVideoStore((s) => s.switchProjectBranch)
  const isExporting = useVideoStore((s) => s.isExporting)
  const lastExportStatus = useVideoStore((s) => s.lastExportStatus)

  const tabs = centerOpenTabs.filter((id) => id !== 'settings')
  if (tabs.length === 0) return null

  return (
    <div className="flex items-center gap-0.5">
      {tabs.map((id) => {
        const isActive = centerTab === id
        const dockStripId = parseLayersStripCenterTabId(id)
        const branchPreviewId = parseBranchPreviewTabId(id)
        const isWelcome = id === 'welcome'

        const label =
          dockStripId != null
            ? LAYERS_STRIP_TAB_LABELS[dockStripId]
            : branchPreviewId != null
              ? (branches.find((b) => b.id === branchPreviewId)?.name ?? branchPreviewId.slice(0, 6))
              : id === 'preview'
                ? (branches.find((b) => b.isDefault)?.name ?? 'main')
                : id === 'workspace'
                  ? 'Workspaces'
                  : id === 'customize'
                    ? 'Customize'
                    : id === 'history'
                      ? 'Version history'
                      : id === 'export'
                        ? 'Export'
                        : id === 'media'
                          ? 'Library'
                          : id === 'code'
                            ? 'Code'
                            : id === 'welcome'
                              ? 'Welcome'
                              : id

        const icon =
          dockStripId != null ? (
            <LayerDockTabIcon id={dockStripId} />
          ) : id === 'preview' || branchPreviewId != null ? (
            <PreviewIcon size={13} />
          ) : id === 'workspace' ? (
            <Package2 size={13} strokeWidth={1.5} />
          ) : id === 'customize' ? (
            <Briefcase size={13} strokeWidth={1.5} />
          ) : id === 'history' ? (
            <History size={13} strokeWidth={1.5} />
          ) : id === 'export' ? (
            <Download size={13} strokeWidth={1.5} />
          ) : id === 'media' ? (
            <MediaTabIcon size={13} />
          ) : id === 'code' ? (
            <Code2 size={13} strokeWidth={1.5} />
          ) : id === 'welcome' ? (
            <Sparkles size={13} strokeWidth={1.5} />
          ) : null

        const activateTab = () => {
          const bId = parseBranchPreviewTabId(id)
          if (bId) {
            void switchProjectBranch(bId)
          } else if (id === 'preview') {
            const def = branches.find((b) => b.isDefault)
            if (def) void switchProjectBranch(def.id)
          }
          setCenterTab(id)
        }

        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onClick={activateTab}
            onKeyDown={(e) => {
              // Keyboard activation for the tab strip.
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                activateTab()
              }
            }}
            className={`group flex h-6 cursor-pointer select-none items-center gap-1 rounded-[var(--radius-pill)] border px-2 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
              isActive
                ? 'border-[var(--hairline-strong)] bg-[var(--panel)] text-[var(--ink)]'
                : 'border-transparent text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]'
            }`}
          >
            <span className="opacity-80">{icon}</span>
            <span className="max-w-[140px] truncate">{label}</span>
            {id === 'export' && isExporting && <Loader2 size={11} className="animate-spin" />}
            {id === 'export' && !isExporting && !isActive && lastExportStatus === 'success' && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" aria-label="Export complete" />
            )}
            {id === 'export' && !isExporting && !isActive && lastExportStatus === 'error' && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--danger)]" aria-label="Export failed" />
            )}
            {!isWelcome && (
              <button
                type="button"
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeCenterTab(id)
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="no-style grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] text-[var(--mute)] opacity-0 transition-opacity hover:bg-[var(--card-hover)] hover:text-[var(--ink)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
              >
                <X size={12} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
