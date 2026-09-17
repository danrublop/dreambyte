// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

let storeState: Record<string, unknown>
const toggleLayerTreeExpanded = vi.fn()
// The panel reads the store three ways: `useVideoStore((s) => s.scenes)`, a
// bare `useVideoStore()` it destructures actions off, and
// `useVideoStore.getState()` inside handlers. Support all three.
vi.mock('@/lib/store', () => {
  const useVideoStore = (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(storeState) : storeState
  useVideoStore.getState = () => storeState
  return { useVideoStore }
})

import SceneLayersStackPanel from './SceneLayersStackPanel'

function scene(id: string, name: string) {
  return {
    id,
    name,
    duration: 5,
    sceneType: 'react',
    sceneCode: '',
    prompt: '',
    aiLayers: [],
    svgObjects: [],
    textOverlays: [],
    interactions: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    scenes: [scene('s1', 'Opening'), scene('s2', 'Second')],
    selectedSceneId: 's1',
    selectScene: vi.fn(),
    project: { timeline: { tracks: [] } },
    selectedClipIds: [],
    setSelectedClipIds: vi.fn(),
    openLayerStackProperties: vi.fn(),
    openLayersSection: vi.fn(),
    openTextTabForSlot: vi.fn(),
    openCodeEditor: vi.fn(),
    setTextEditorSlotKey: vi.fn(),
    updateScene: vi.fn(),
    saveSceneHTML: vi.fn(),
    removeAILayer: vi.fn(),
    removeSvgObject: vi.fn(),
    removeTextOverlay: vi.fn(),
    removeInteraction: vi.fn(),
    layerTreeExpanded: {},
    toggleLayerTreeExpanded,
  }
})

/** Chevron label per scene row, in render order: open rows say "Collapse". */
function expansionState() {
  return screen.getAllByRole('button', { name: /(Collapse|Expand) scene layers/ }).map((b) => {
    const label = b.getAttribute('aria-label') ?? ''
    return label.startsWith('Collapse') ? 'open' : 'closed'
  })
}

describe('SceneLayersStackPanel — scene tree expansion', () => {
  it('starts fully collapsed — nothing opens on its own', () => {
    render(<SceneLayersStackPanel fillAvailableHeight />)
    expect(expansionState()).toEqual(['closed', 'closed'])
  })

  it('does NOT expand a scene when the selection moves', () => {
    // Regression: playback crossing a scene boundary, clicking a clip, and
    // scrubbing all call selectScene(). Each used to pop that scene's layer
    // tree open and collapse the previous one, mid-playback.
    const { rerender } = render(<SceneLayersStackPanel fillAvailableHeight />)
    storeState.selectedSceneId = 's2'
    rerender(<SceneLayersStackPanel fillAvailableHeight />)

    expect(expansionState()).toEqual(['closed', 'closed'])
  })

  it('opens only what the user clicks', () => {
    render(<SceneLayersStackPanel fillAvailableHeight />)
    fireEvent.click(screen.getAllByRole('button', { name: /Expand scene layers/ })[0])
    expect(toggleLayerTreeExpanded).toHaveBeenCalledWith('s1')
  })

  it('survives a round-trip through the Properties panel', () => {
    // The reported bug: drilling into Properties swaps this component out
    // (LayersTab renders `key ? <Properties/> : <Stack/>`), so the back arrow
    // REMOUNTS it. Expansion lives in the store precisely so a remount neither
    // re-opens the selected scene nor forgets what the user had open.
    storeState.layerTreeExpanded = { s2: true }
    const { unmount } = render(<SceneLayersStackPanel fillAvailableHeight />)
    expect(expansionState()).toEqual(['closed', 'open'])

    unmount() // drill into Properties
    render(<SceneLayersStackPanel fillAvailableHeight />) // back arrow

    expect(expansionState()).toEqual(['closed', 'open'])
  })
})
