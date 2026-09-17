'use client'

import { useEffect } from 'react'
import { Toaster, toast } from 'sonner'
import { useVideoStore } from '@/lib/store'

function AppToaster() {
  // Bridge for the MCP renderer notifier (src/electron/main.ts executeJavaScript):
  // when an external agent updates a DIFFERENT project while the user is
  // mid-work, the notifier suppresses the auto-switch and calls this hook so
  // the user decides — sonner's toast isn't reachable from eval'd code, and
  // this reuses the existing toaster instead of growing a parallel surface.
  useEffect(() => {
    ;(window as any).__dreambyteExternalProjectUpdate = (projectId: string, name?: string) => {
      toast(`Agent updated ${name ? `“${name}”` : 'another project'}`, {
        action: {
          label: 'Open',
          onClick: () => {
            void useVideoStore.getState().loadProject(projectId)
          },
        },
        duration: 10000,
      })
    }
    return () => {
      delete (window as any).__dreambyteExternalProjectUpdate
    }
  }, [])

  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        style: {
          background: 'rgba(20,20,20,0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.92)',
        },
      }}
    />
  )
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AppToaster />
    </>
  )
}
