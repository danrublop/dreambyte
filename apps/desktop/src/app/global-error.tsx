'use client'

import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app/global-error]', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#f5f5f5',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '2rem',
        }}
      >
        <div
          style={{
            maxWidth: '32rem',
            width: '100%',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '0.5rem',
            padding: '1.5rem',
          }}
        >
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 0.75rem' }}>Dreambyte crashed</h1>
          <p style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.6)', margin: '0 0 0.75rem' }}>
            {error.message || 'A fatal error occurred in the app shell.'}
          </p>
          {error.digest && (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>
              error id: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: '0.75rem',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.05)',
              color: 'inherit',
              padding: '0.4rem 0.8rem',
              fontSize: '0.875rem',
              borderRadius: '0.25rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
