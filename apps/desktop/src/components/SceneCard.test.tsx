// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Scene } from '@/lib/types'

const updateScene = vi.fn()
vi.mock('@/lib/store', () => ({
  useVideoStore: () => ({
    selectScene: vi.fn(),
    deleteScene: vi.fn(),
    duplicateScene: vi.fn(),
    moveScene: vi.fn(),
    scenes: [],
    updateScene,
  }),
}))

import SceneCard from './SceneCard'

const scene = { id: 's1', name: 'Intro', sceneType: 'motion', duration: 4 } as unknown as Scene

function openRename() {
  render(<SceneCard scene={scene} index={0} isSelected={false} />)
  fireEvent.contextMenu(screen.getByText('Scene 1'))
  fireEvent.click(screen.getByText('Rename'))
  return screen.getByLabelText('Scene name') as HTMLInputElement
}

describe('SceneCard rename', () => {
  beforeEach(() => updateScene.mockClear())

  it('renames the scene on Enter', () => {
    const input = openRename()
    expect(input.value).toBe('Intro')
    fireEvent.change(input, { target: { value: '  Opening  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(updateScene).toHaveBeenCalledTimes(1)
    expect(updateScene).toHaveBeenCalledWith('s1', { name: 'Opening' })
    expect(screen.queryByLabelText('Scene name')).toBeNull()
  })

  it('cancels on Escape', () => {
    const input = openRename()
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(updateScene).not.toHaveBeenCalled()
  })

  it('ignores a blank name', () => {
    const input = openRename()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(updateScene).not.toHaveBeenCalled()
  })
})
