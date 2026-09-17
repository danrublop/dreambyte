'use client'

import { useState, useEffect } from 'react'

/**
 * useState backed by localStorage. SSR-safe: returns `initial` on the server
 * and on any JSON parse error (e.g. corrupted storage). Writes are fire-and-forget
 * (quota / privacy-mode errors are swallowed).
 */
export function usePersistedState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = window.localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / privacy mode — ignore */
    }
  }, [key, value])
  return [value, setValue]
}
