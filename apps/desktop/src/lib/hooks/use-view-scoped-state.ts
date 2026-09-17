'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * View-scoped UI state.
 *
 * In editor mode, reads/writes go to the persisted backing value.
 * In welcome mode, a transient local value is used instead — and that local
 * value resets to `homeDefault` every time the user (re-)enters the welcome
 * view, so the home page always starts in a clean state and toggles made
 * there never leak into the editor's persisted preferences.
 */
export function useViewScopedState<T>(
  showWelcome: boolean,
  persistedValue: T,
  setPersistedValue: ((next: T | ((prev: T) => T)) => void) | ((value: T) => void),
  homeDefault: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [homeValue, setHomeValue] = useState<T>(homeDefault)
  const wasWelcomeRef = useRef(showWelcome)

  useEffect(() => {
    if (showWelcome && !wasWelcomeRef.current) setHomeValue(homeDefault)
    wasWelcomeRef.current = showWelcome
  }, [showWelcome, homeDefault])

  const value = showWelcome ? homeValue : persistedValue
  const setValue = (next: T | ((prev: T) => T)) => {
    if (showWelcome) {
      setHomeValue((prev) => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next))
    } else {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(persistedValue) : next
      ;(setPersistedValue as (value: T) => void)(resolved)
    }
  }

  return [value, setValue]
}
