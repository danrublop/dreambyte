'use client'

import { useVideoStore } from '@/lib/store'
import { Download } from 'lucide-react'
import PreviewBranchButton from '@/components/branches/PreviewBranchButton'
import { useBranches } from '@/lib/hooks/use-branches'

const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)

function ChatIcon({ size = 19 }: { size?: number }) {
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
      <path d="M18 9V7.2C18 6.0799 18 5.51984 17.782 5.09202C17.5903 4.71569 17.2843 4.40973 16.908 4.21799C16.4802 4 15.9201 4 14.8 4H7.2C6.0799 4 5.51984 4 5.09202 4.21799C4.71569 4.40973 4.40973 4.71569 4.21799 5.09202C4 5.51984 4 6.0799 4 7.2V18L8 16M20 20L17.8062 18.5374C17.5065 18.3377 17.3567 18.2378 17.1946 18.167C17.0507 18.1042 16.9 18.0586 16.7454 18.031C16.5713 18 16.3912 18 16.0311 18H11.2C10.0799 18 9.51984 18 9.09202 17.782C8.71569 17.5903 8.40973 17.2843 8.21799 16.908C8 16.4802 8 15.9201 8 14.8V12.2C8 11.0799 8 10.5198 8.21799 10.092C8.40973 9.71569 8.71569 9.40973 9.09202 9.21799C9.51984 9 10.0799 9 11.2 9H16.8C17.9201 9 18.4802 9 18.908 9.21799C19.2843 9.40973 19.5903 9.71569 19.782 10.092C20 10.5198 20 11.0799 20 12.2V20Z" />
    </svg>
  )
}

const iconBtn =
  'no-style grid h-8 w-8 place-items-center rounded-[var(--radius-md)] text-[var(--graphite)] hover:bg-[var(--card)] hover:text-[var(--ink)]'

/**
 * Editor-view header tools, lifted into the shell top bar: a Chat button (go to
 * chat view), the agent-panel open/close toggle, the branch (main) selector,
 * the timeline open/close toggle, and Export. Store-driven so it lives outside
 * Editor.tsx; the editor's own titlebar is hidden in embedded mode.
 */
export default function EditorHeaderTools() {
  const rightPanelTab = useVideoStore((s) => s.rightPanelTab)
  const setRightPanelTab = useVideoStore((s) => s.setRightPanelTab)
  const centerOpenTabs = useVideoStore((s) => s.centerOpenTabs)
  const centerTab = useVideoStore((s) => s.centerTab)
  const setCenterTab = useVideoStore((s) => s.setCenterTab)
  const switchProjectBranch = useVideoStore((s) => s.switchProjectBranch)
  const projectActiveBranchId = useVideoStore((s) => s.projectActiveBranchId)
  const publishProject = useVideoStore((s) => s.publishProject)
  const outputMode = useVideoStore((s) => s.project?.outputMode)
  const projectId = useVideoStore((s) => s.project?.id)
  const branches = useBranches(projectId)

  const agentOpen = rightPanelTab === 'prompt'

  // Mirrors Editor.tsx triggerExport: this header only renders in the embedded
  // shell, so MP4 opens the Export center tab; other output modes publish.
  const triggerExport = () => {
    if (outputMode !== 'mp4') {
      void publishProject()
      return
    }
    setCenterTab('export')
  }

  return (
    <div className="flex items-center gap-1.5">
      <PreviewBranchButton
        branches={branches}
        openTabIds={centerOpenTabs}
        activeTabId={centerTab}
        isElectron={isElectron}
        className={iconBtn}
        onSelectBranch={(branchId) => {
          // switchProjectBranch opens+activates the preview tab as a side effect,
          // but early-returns when this branch is already active — so it would
          // never (re)open the tab. Open it directly in that case.
          if (projectActiveBranchId === branchId) {
            const b = branches.find((x) => x.id === branchId)
            setCenterTab(b?.isDefault ? 'preview' : (`preview:${branchId}` as const))
          } else {
            void switchProjectBranch(branchId)
          }
        }}
        onOpenDefault={() => {
          const def = branches.find((b) => b.isDefault)
          if (def && projectActiveBranchId !== def.id) {
            void switchProjectBranch(def.id)
          } else {
            // Already on the default branch (or no branches yet) — just open the
            // preview tab. This is the common case when the tab was closed.
            setCenterTab('preview')
          }
        }}
      />

      <button
        onClick={() => setRightPanelTab(agentOpen ? null : 'prompt')}
        className={`${iconBtn} ${agentOpen ? 'bg-[var(--card)]' : ''}`}
        title={agentOpen ? 'Hide agent' : 'Show agent'}
      >
        <ChatIcon size={21} />
      </button>

      <button onClick={triggerExport} className={iconBtn} title="Export">
        <Download size={16} strokeWidth={1.7} />
      </button>
    </div>
  )
}
