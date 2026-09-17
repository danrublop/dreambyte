'use client'

import { useVideoStore } from '@/lib/store'
import ExportPanel from './ExportPanel'

/**
 * Modal wrapper around ExportPanel. Used in non-Electron (web) layouts
 * where the center tab strip doesn't exist. Electron layouts mount
 * <ExportPanel inTab /> directly inside the center tab.
 */
export default function ExportModal() {
  const { closeExportModal, isExporting } = useVideoStore()

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4"
      onClick={!isExporting ? closeExportModal : undefined}
    >
      <div
        className="w-[480px] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <ExportPanel onClose={closeExportModal} />
      </div>
    </div>
  )
}
