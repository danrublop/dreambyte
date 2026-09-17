import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerPreviewFrame,
  isRegisteredPreviewFrame,
  __clearPreviewFrameRegistryForTesting,
} from './preview-frame-registry'

const frame = (tag: string) => ({ contentWindow: { tag } })

describe('preview-frame-registry', () => {
  beforeEach(() => __clearPreviewFrameRegistryForTesting())

  it('binds a report to its registered frame and rejects others', () => {
    const f = frame('branch')
    registerPreviewFrame('scene-1', f)
    expect(isRegisteredPreviewFrame('scene-1', f.contentWindow)).toBe(true)
    // Wrong window → rejected (sibling-forgery case).
    expect(isRegisteredPreviewFrame('scene-1', frame('other').contentWindow)).toBe(false)
    // Wrong scene id → rejected.
    expect(isRegisteredPreviewFrame('scene-2', f.contentWindow)).toBe(false)
  })

  it('supports multiple frames per scene id (editor + branch copy share an id)', () => {
    const editor = frame('editor')
    const branch = frame('branch')
    registerPreviewFrame('scene-1', editor)
    registerPreviewFrame('scene-1', branch)
    expect(isRegisteredPreviewFrame('scene-1', editor.contentWindow)).toBe(true)
    expect(isRegisteredPreviewFrame('scene-1', branch.contentWindow)).toBe(true)
  })

  it('unregister removes only that frame', () => {
    const a = frame('a')
    const b = frame('b')
    const offA = registerPreviewFrame('scene-1', a)
    registerPreviewFrame('scene-1', b)
    offA()
    expect(isRegisteredPreviewFrame('scene-1', a.contentWindow)).toBe(false)
    expect(isRegisteredPreviewFrame('scene-1', b.contentWindow)).toBe(true)
  })

  it('rejects non-string / empty ids and unregistered scenes', () => {
    expect(isRegisteredPreviewFrame(undefined, frame('x').contentWindow)).toBe(false)
    expect(isRegisteredPreviewFrame('', frame('x').contentWindow)).toBe(false)
    expect(isRegisteredPreviewFrame('nope', frame('x').contentWindow)).toBe(false)
  })

  it('ignores null frames but returns a safe no-op unregister', () => {
    const off = registerPreviewFrame('scene-1', null)
    expect(() => off()).not.toThrow()
    expect(isRegisteredPreviewFrame('scene-1', null)).toBe(false)
  })

  it('a frame without a contentWindow never binds (detached iframe)', () => {
    const detached = { contentWindow: null }
    registerPreviewFrame('scene-1', detached)
    expect(isRegisteredPreviewFrame('scene-1', null)).toBe(false)
  })
})
