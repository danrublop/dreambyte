import { describe, it, expect } from 'vitest'
import { nextRenderableSceneId } from './preview-sequence'

describe('nextRenderableSceneId', () => {
  const order = ['a', 'b', 'c', 'd']

  it('returns the immediate next scene when it is renderable', () => {
    expect(nextRenderableSceneId(order, () => false, 'a')).toBe('b')
  })

  it('skips a single errored scene', () => {
    const errored = (id: string) => id === 'b'
    expect(nextRenderableSceneId(order, errored, 'a')).toBe('c')
  })

  it('skips consecutive errored scenes', () => {
    const errored = (id: string) => id === 'b' || id === 'c'
    expect(nextRenderableSceneId(order, errored, 'a')).toBe('d')
  })

  it('returns null when every later scene is errored (freeze → clean stop)', () => {
    const errored = (id: string) => id !== 'a'
    expect(nextRenderableSceneId(order, errored, 'a')).toBeNull()
  })

  it('returns null at the end of the sequence', () => {
    expect(nextRenderableSceneId(order, () => false, 'd')).toBeNull()
  })

  it('returns null when the starting scene is not in the order', () => {
    expect(nextRenderableSceneId(order, () => false, 'zzz')).toBeNull()
  })

  it('only looks forward — an earlier renderable scene is never returned', () => {
    // From 'c', 'a'/'b' are renderable but behind us; 'd' is errored → null.
    const errored = (id: string) => id === 'd'
    expect(nextRenderableSceneId(order, errored, 'c')).toBeNull()
  })
})
