'use client'

import { useEffect } from 'react'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app/error]', error)
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-primary,#0a0a0a)] p-8 text-[var(--color-text-primary,#f5f5f5)]">
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-white/10 bg-white/[0.02] p-6">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-white/60">
          {error.message || 'An unexpected error occurred while rendering this page.'}
        </p>
        {error.digest && <p className="font-mono text-[11px] text-white/30">error id: {error.digest}</p>}
        <div className="flex gap-2 pt-2">
          <button
            onClick={reset}
            className="rounded border border-white/20 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
          >
            Try again
          </button>
          <a href="/" className="rounded border border-transparent px-3 py-1.5 text-sm text-white/60 hover:text-white">
            Back home
          </a>
        </div>
      </div>
    </div>
  )
}
