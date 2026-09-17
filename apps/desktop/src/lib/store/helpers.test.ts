import { describe, it, expect } from 'vitest'

import { ensureValidProjectId, createDefaultProject } from './helpers'
import type { Project } from '../types'

describe('ensureValidProjectId', () => {
  const fallback = createDefaultProject()

  it('keeps a persisted project whose id is a valid UUID', () => {
    const persisted = { ...createDefaultProject(), id: '1204bc53-6132-4036-a211-5e76b12e8697', name: 'Real' } as Project
    const out = ensureValidProjectId(persisted, fallback)
    expect(out).toBe(persisted)
    expect(out.id).toBe('1204bc53-6132-4036-a211-5e76b12e8697')
  })

  it('falls back to the default when the persisted id is the empty string (the legacy bug)', () => {
    const persisted = { ...createDefaultProject(), id: '' } as Project
    const out = ensureValidProjectId(persisted, fallback)
    expect(out).toBe(fallback)
    expect(out.id).not.toBe('')
  })

  it('falls back for a non-UUID / null / undefined project', () => {
    expect(ensureValidProjectId({ ...createDefaultProject(), id: 'legacy-slug' } as Project, fallback)).toBe(fallback)
    expect(ensureValidProjectId(null, fallback)).toBe(fallback)
    expect(ensureValidProjectId(undefined, fallback)).toBe(fallback)
  })

  it('prefers a valid activeProjectId over the fresh default when the project id is blank', () => {
    const persisted = { ...createDefaultProject(), id: '', name: 'Drifted' } as Project
    const activeId = '1204bc53-6132-4036-a211-5e76b12e8697'
    const out = ensureValidProjectId(persisted, fallback, activeId)
    // Reuses the real id loadProject will hydrate — not the non-DB fresh default.
    expect(out.id).toBe(activeId)
    expect(out.name).toBe('Drifted')
    expect(out).not.toBe(fallback)
  })

  it('falls back to the default when the project id is blank AND activeProjectId is unusable', () => {
    const persisted = { ...createDefaultProject(), id: '' } as Project
    expect(ensureValidProjectId(persisted, fallback, '')).toBe(fallback)
    expect(ensureValidProjectId(persisted, fallback, null)).toBe(fallback)
    expect(ensureValidProjectId(persisted, fallback, 'not-a-uuid')).toBe(fallback)
  })

  it('reconciles a VALID-but-drifted project.id to activeProjectId (the persisted-fake-uuid case)', () => {
    // An earlier heal persisted a fresh default uuid that is NOT a DB row; it is
    // a valid UUID so it would slip through a validity-only check, but it does
    // not match the authoritative activeProjectId loadProject will hydrate.
    const drifted = { ...createDefaultProject(), id: 'a0d50d5f-3c8e-408c-bbd4-3003aa4d279d', name: 'Stale' } as Project
    const activeId = '1204bc53-6132-4036-a211-5e76b12e8697'
    const out = ensureValidProjectId(drifted, fallback, activeId)
    expect(out.id).toBe(activeId)
    expect(out.name).toBe('Stale')
  })

  it('returns the project untouched when its valid id already matches activeProjectId', () => {
    const activeId = '1204bc53-6132-4036-a211-5e76b12e8697'
    const matched = { ...createDefaultProject(), id: activeId } as Project
    expect(ensureValidProjectId(matched, fallback, activeId)).toBe(matched)
  })
})
