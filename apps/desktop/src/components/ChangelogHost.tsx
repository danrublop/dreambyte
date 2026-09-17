'use client'

import { useEffect, useState } from 'react'
import { ChangelogModal } from './ChangelogModal'
import { getPendingChangelog, type ChangelogEntry } from '@/lib/changelog'
import { usePersistedState } from '@/lib/hooks/use-persisted-state'

/**
 * Wires the once-per-version "What's new" overlay into the editor.
 *
 * On mount it reads the running app version (Electron IPC) and the persisted
 * lastSeenVersion (localStorage). getPendingChangelog enforces the
 * contract: show only on a genuine upgrade, never on a fresh install, exactly
 * once. We persist the new version the moment the overlay is computed to show,
 * so a relaunch on the same version won't re-trigger it.
 *
 * Web build (no Electron bridge): no version source → never shows. That's fine;
 * the changelog is an after-update affordance for the desktop app.
 */
export function ChangelogHost() {
  const [lastSeen, setLastSeen] = usePersistedState<string>('dreambyte.lastSeenVersion', '')
  const [pending, setPending] = useState<ChangelogEntry | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const appApi = (
        window as unknown as { dreambyteApi?: { app?: { getVersion?: () => Promise<{ version: string }> } } }
      ).dreambyteApi?.app
      if (!appApi?.getVersion) return
      let current = ''
      try {
        const res = await appApi.getVersion()
        current = res?.version ?? ''
      } catch {
        return
      }
      if (cancelled || !current) return
      const entry = getPendingChangelog(current, lastSeen)
      // Always advance the marker on a real version change so the overlay shows
      // exactly once — even if there's no entry for this version (entry === null
      // simply means nothing to show, but we still don't want to re-check).
      if (current !== lastSeen) setLastSeen(current)
      if (entry) setPending(entry)
    })()
    return () => {
      cancelled = true
    }
    // Intentionally run once on mount — lastSeen is read at that point and
    // advanced here; re-running on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!pending) return null
  return <ChangelogModal entry={pending} onClose={() => setPending(null)} />
}
