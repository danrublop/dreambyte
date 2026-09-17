import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePersistedState } from './use-persisted-state'

describe('usePersistedState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the initial value when nothing is stored', () => {
    const { result } = renderHook(() => usePersistedState('k', 42))
    expect(result.current[0]).toBe(42)
  })

  it('hydrates from localStorage on mount', () => {
    localStorage.setItem('k', JSON.stringify(99))
    const { result } = renderHook(() => usePersistedState('k', 0))
    expect(result.current[0]).toBe(99)
  })

  it('persists a new value to localStorage after set', () => {
    const { result } = renderHook(() => usePersistedState('k', 0))
    act(() => result.current[1](7))
    expect(result.current[0]).toBe(7)
    expect(JSON.parse(localStorage.getItem('k')!)).toBe(7)
  })

  it('supports functional updates', () => {
    localStorage.setItem('k', JSON.stringify(10))
    const { result } = renderHook(() => usePersistedState('k', 0))
    act(() => result.current[1]((prev) => prev + 5))
    expect(result.current[0]).toBe(15)
  })

  it('falls back to initial on corrupted JSON in storage', () => {
    localStorage.setItem('k', 'not-json{{{')
    const { result } = renderHook(() => usePersistedState('k', 'fallback'))
    expect(result.current[0]).toBe('fallback')
  })

  it('works with boolean values', () => {
    const { result } = renderHook(() => usePersistedState('flag', false))
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(JSON.parse(localStorage.getItem('flag')!)).toBe(true)
  })

  it('works with object values', () => {
    const { result } = renderHook(() => usePersistedState<{ x: number }>('obj', { x: 1 }))
    act(() => result.current[1]({ x: 2 }))
    expect(result.current[0]).toEqual({ x: 2 })
    expect(JSON.parse(localStorage.getItem('obj')!)).toEqual({ x: 2 })
  })

  it('does not throw when localStorage throws on write (quota)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => usePersistedState('k', 0))
    expect(() => act(() => result.current[1](1))).not.toThrow()
    spy.mockRestore()
  })
})
