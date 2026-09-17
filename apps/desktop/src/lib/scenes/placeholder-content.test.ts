import { describe, it, expect } from 'vitest'
import { isPlaceholderContent, pickNonPlaceholder } from './placeholder-content'

describe('isPlaceholderContent (A0/T1 predicate)', () => {
  it('matches the exact generated placeholder shape', () => {
    expect(isPlaceholderContent('[8243 chars]')).toBe(true)
    expect(isPlaceholderContent('[0 chars]')).toBe(true)
    expect(isPlaceholderContent('  [12 chars]  ')).toBe(true) // trimmed
  })

  it('does NOT match real code that merely CONTAINS the placeholder substring (name-collision)', () => {
    // A scene legitimately rendering the text "[12 chars]" inside larger code
    // must not be mistaken for a stripped placeholder.
    expect(isPlaceholderContent('const label = "[12 chars]"; export default () => label')).toBe(false)
    expect(isPlaceholderContent('// limit is [12 chars]')).toBe(false)
    expect(isPlaceholderContent('[12 chars] and more')).toBe(false)
    expect(isPlaceholderContent('prefix [12 chars]')).toBe(false)
  })

  it('does NOT match malformed near-misses', () => {
    expect(isPlaceholderContent('[chars]')).toBe(false)
    expect(isPlaceholderContent('[12 char]')).toBe(false)
    expect(isPlaceholderContent('[12chars]')).toBe(false)
    expect(isPlaceholderContent('[ 12 chars ]')).toBe(false)
    expect(isPlaceholderContent('(12 chars)')).toBe(false)
  })

  it('treats empty / nullish as non-placeholder', () => {
    expect(isPlaceholderContent('')).toBe(false)
    expect(isPlaceholderContent(undefined)).toBe(false)
    expect(isPlaceholderContent(null)).toBe(false)
  })
})

describe('pickNonPlaceholder (code-fill pick)', () => {
  it('placeholder client value loses to real server code', () => {
    expect(pickNonPlaceholder('[8243 chars]', 'export default real()')).toBe('export default real()')
  })

  it('real client code wins over real server code', () => {
    expect(pickNonPlaceholder('client real', 'server real')).toBe('client real')
  })

  it('real client code wins over empty server', () => {
    expect(pickNonPlaceholder('client real', '')).toBe('client real')
  })

  it('empty client falls through to server (today’s behavior)', () => {
    expect(pickNonPlaceholder('', 'server real')).toBe('server real')
  })

  it('placeholder client + empty server → empty (never persist the placeholder)', () => {
    expect(pickNonPlaceholder('[8243 chars]', '')).toBe('')
    expect(pickNonPlaceholder('[8243 chars]', undefined)).toBe('')
  })

  it('placeholder on BOTH sides → empty', () => {
    expect(pickNonPlaceholder('[8243 chars]', '[100 chars]')).toBe('')
  })

  it('name-collision client value is real code and wins', () => {
    expect(pickNonPlaceholder('label = "[12 chars]"', 'server')).toBe('label = "[12 chars]"')
  })
})
