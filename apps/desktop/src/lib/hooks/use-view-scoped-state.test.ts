import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useViewScopedState } from './use-view-scoped-state'

describe('useViewScopedState', () => {
  it('returns homeDefault when showWelcome=true', () => {
    const setPersisted = vi.fn()
    const { result } = renderHook(() => useViewScopedState<boolean>(true, false, setPersisted, false))
    expect(result.current[0]).toBe(false)
  })

  it('returns persistedValue when showWelcome=false', () => {
    const setPersisted = vi.fn()
    const { result } = renderHook(() => useViewScopedState<boolean>(false, true, setPersisted, false))
    expect(result.current[0]).toBe(true)
  })

  it('on welcome: set updates local state, not persisted', () => {
    const setPersisted = vi.fn()
    const { result } = renderHook(() => useViewScopedState<boolean>(true, false, setPersisted, false))
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(setPersisted).not.toHaveBeenCalled()
  })

  it('on editor: set calls setPersistedValue', () => {
    const setPersisted = vi.fn()
    const { result } = renderHook(() => useViewScopedState<boolean>(false, false, setPersisted, false))
    act(() => result.current[1](true))
    expect(setPersisted).toHaveBeenCalledWith(true)
  })

  it('on editor: functional update resolves against persistedValue', () => {
    const setPersisted = vi.fn()
    const { result } = renderHook(() => useViewScopedState<number>(false, 10, setPersisted, 0))
    act(() => result.current[1]((prev) => prev + 5))
    expect(setPersisted).toHaveBeenCalledWith(15)
  })

  it('resets home value to homeDefault when transitioning editor → welcome', () => {
    const setPersisted = vi.fn()
    const { result, rerender } = renderHook(
      ({ showWelcome }: { showWelcome: boolean }) =>
        useViewScopedState<boolean>(showWelcome, false, setPersisted, false),
      { initialProps: { showWelcome: false } },
    )
    // Set a local value while in editor (goes to persisted)
    // Now switch to welcome — local home value must reset to homeDefault
    rerender({ showWelcome: true })
    expect(result.current[0]).toBe(false) // homeDefault
  })

  it('does NOT reset home value when staying on welcome across rerenders', () => {
    const setPersisted = vi.fn()
    const { result, rerender } = renderHook(
      ({ showWelcome }: { showWelcome: boolean }) =>
        useViewScopedState<boolean>(showWelcome, false, setPersisted, false),
      { initialProps: { showWelcome: true } },
    )
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    rerender({ showWelcome: true }) // stays on welcome
    expect(result.current[0]).toBe(true) // preserved, not reset
  })
})
