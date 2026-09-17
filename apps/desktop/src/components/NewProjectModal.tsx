'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { ASPECT_RATIO_OPTIONS, type AspectRatio } from '@/lib/dimensions'

export default function NewProjectModal() {
  const { isNewProjectModalOpen, closeNewProjectModal, createNewProject } = useVideoStore()
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState<AspectRatio>('16:9')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (isNewProjectModalOpen) {
      setName('')
      setAspect('16:9')
      setCreating(false)
    }
  }, [isNewProjectModalOpen])

  if (!isNewProjectModalOpen) return null

  const confirm = async () => {
    if (creating) return
    setCreating(true)
    try {
      const trimmed = name.trim()
      await createNewProject(trimmed || undefined, aspect)
      closeNewProjectModal()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4"
      onClick={() => !creating && closeNewProjectModal()}
    >
      <div
        className="w-[480px] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 border-b border-[var(--color-border)] flex items-center px-4 justify-between">
          <span className="text-sm font-semibold text-[var(--color-text-muted)]">New project</span>
          <button
            onClick={closeNewProjectModal}
            disabled={creating}
            className="no-style hover:bg-white/[0.05] rounded-md transition-colors"
            style={{ color: 'var(--color-text-muted)', padding: '4px' }}
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-2">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirm()
                if (e.key === 'Escape') closeNewProjectModal()
              }}
              placeholder="Untitled Project"
              className="w-full px-0 py-1 text-[14px] bg-transparent text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none transition-colors"
              style={{ border: 'none', borderBottom: '1px solid var(--color-border)', borderRadius: 0 }}
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-2">Dimensions</label>
            <div className="flex items-center gap-2">
              {ASPECT_RATIO_OPTIONS.map((opt) => {
                const selected = aspect === opt.value
                return (
                  <button
                    key={opt.value}
                    onClick={() => setAspect(opt.value)}
                    className={`no-style flex-1 flex flex-col items-center gap-0.5 px-3 py-2 rounded-md transition-colors ${
                      selected
                        ? 'text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                    }`}
                    style={{
                      background: selected
                        ? 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)'
                        : 'transparent',
                    }}
                  >
                    <span className="text-[13px] font-medium">{opt.label}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">{opt.description}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <div className="px-6 pb-5 flex items-center justify-end gap-2">
          <button
            onClick={closeNewProjectModal}
            disabled={creating}
            className="no-style text-sm font-semibold rounded-md hover:opacity-80 transition-opacity"
            style={{
              background: 'transparent',
              color: 'var(--color-text-muted)',
              padding: '2px 6px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={creating}
            className="no-style text-sm font-semibold rounded-md hover:opacity-80 disabled:opacity-50 transition-opacity"
            style={{
              background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
              color: 'var(--color-text-muted)',
              padding: '2px 6px',
            }}
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
