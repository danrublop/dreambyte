import { useState, useEffect } from 'react'

interface ConfiguredProviders {
  audio: Set<string>
  media: Set<string>
  loaded: boolean
}

let cachedResult: ConfiguredProviders | null = null

/**
 * Fetches which providers are actually configured (API key set, server running).
 * Caches the result for the session. Reads via `window.dreambyteApi.settings.listProviders`;
 * returns an empty result if the desktop runtime is unavailable.
 */
export function useConfiguredProviders(): ConfiguredProviders {
  const [result, setResult] = useState<ConfiguredProviders>(
    cachedResult ?? { audio: new Set(), media: new Set(), loaded: false },
  )

  useEffect(() => {
    if (cachedResult) {
      setResult(cachedResult)
      return
    }
    let cancelled = false

    const loadProviders = async (): Promise<{
      providers?: Record<'tts' | 'sfx' | 'music', { id: string; available: boolean }[]>
      media?: { id: string; available: boolean }[]
    }> => {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi : undefined
      if (ipc?.settings?.listProviders) {
        return ipc.settings.listProviders()
      }
      return {}
    }

    loadProviders()
      .then((data) => {
        if (cancelled) return
        const audioIds = new Set<string>()
        for (const cat of ['tts', 'sfx', 'music'] as const) {
          for (const p of data.providers?.[cat] ?? []) {
            if (p.available) audioIds.add(p.id)
          }
        }
        const mediaIds = new Set<string>((data.media ?? []).filter((p) => p.available).map((p) => p.id))
        const next = { audio: audioIds, media: mediaIds, loaded: true }
        cachedResult = next
        setResult(next)
      })
      .catch(() => {
        // On error, leave the UI unblocked rather than fail the whole panel.
        if (!cancelled) setResult({ audio: new Set(), media: new Set(), loaded: false })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return result
}
