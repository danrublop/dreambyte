import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock useVideoStore before importing the hook
const mockSaveSceneHTML = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/store', () => ({
  useVideoStore: (selector: (s: any) => any) => selector({ saveSceneHTML: mockSaveSceneHTML }),
}))

// Import after mock is registered
const { useLayerCommit } = await import('../use-layer-commit')

describe('useLayerCommit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSaveSceneHTML.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('commit() calls saveSceneHTML immediately', async () => {
    const { result } = renderHook(() => useLayerCommit('scene-1'))
    await act(async () => {
      await result.current.commit()
    })
    expect(mockSaveSceneHTML).toHaveBeenCalledOnce()
    expect(mockSaveSceneHTML).toHaveBeenCalledWith('scene-1')
  })

  it('commitDebounced() batches multiple rapid calls into one saveSceneHTML call', () => {
    const { result } = renderHook(() => useLayerCommit('scene-2'))

    act(() => {
      result.current.commitDebounced()
      result.current.commitDebounced()
      result.current.commitDebounced()
    })

    // Not yet called — debounce window still open
    expect(mockSaveSceneHTML).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(150)
    })

    // Exactly one call after 150ms, despite 3 rapid invocations
    expect(mockSaveSceneHTML).toHaveBeenCalledOnce()
    expect(mockSaveSceneHTML).toHaveBeenCalledWith('scene-2')
  })

  it('commitDebounced() resets the timer on each call', () => {
    const { result } = renderHook(() => useLayerCommit('scene-3'))

    act(() => {
      result.current.commitDebounced()
    })
    act(() => {
      vi.advanceTimersByTime(100) // 100ms — still within 150ms window
    })

    // Not yet — second call should reset
    act(() => {
      result.current.commitDebounced()
    })
    act(() => {
      vi.advanceTimersByTime(100) // 200ms total but timer reset, only 100ms since last call
    })

    expect(mockSaveSceneHTML).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(50) // 150ms since last commitDebounced call
    })

    expect(mockSaveSceneHTML).toHaveBeenCalledOnce()
  })
})
