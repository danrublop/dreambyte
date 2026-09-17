'use client'

import { useState, useEffect } from 'react'
import AppShell from '@/components/AppShell'
import { useVideoStore } from '@/lib/store'

export default function Home() {
  // Wait for the persisted store to hydrate so appView/projectView/activeProjectId
  // (and the content overlay) resume correctly on refresh — the persisted store
  // is the single source of view truth.
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (useVideoStore.persist.hasHydrated()) {
      setReady(true)
      return
    }
    return useVideoStore.persist.onFinishHydration(() => setReady(true))
  }, [])

  if (!ready) return null
  return <AppShell />
}
