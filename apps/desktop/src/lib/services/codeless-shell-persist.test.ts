// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect } from 'vitest'

import { cleanScenesForAgentPersistence } from './agent-runner'
import { isEmptyAgentShell } from '@/lib/store/helpers'
import type { Scene } from '@/lib/types'

/**
 * Regression gate for docs/AGENT_REGRESSION_FIX_PLAN.md #5.
 *
 * The renderer drops codeless agent shells on sync, but the PERSIST path did
 * not — so a never-coded create_scene placeholder got written to the DB and
 * then served a dreambyte:// 404 "Not found" on reload. The persist boundary
 * must drop NEW empty shells with the same predicate the renderer uses, while
 * NEVER dropping a pre-existing scene.
 */

function scene(p: Partial<Scene> & { id: string }): Scene {
  return { reactCode: '', sceneCode: '', svgContent: '', prompt: '', messages: [], ...p } as unknown as Scene
}

describe('isEmptyAgentShell (#5)', () => {
  it('true for a no-content, no-prompt, no-message scene', () => {
    expect(isEmptyAgentShell(scene({ id: 'a' }))).toBe(true)
  })
  it('false when the scene has code', () => {
    expect(isEmptyAgentShell(scene({ id: 'b', reactCode: 'function Scene(){return null}' }))).toBe(false)
  })
  it('false when the scene has a prompt (build intent)', () => {
    expect(isEmptyAgentShell(scene({ id: 'c', prompt: 'a bitcoin hook scene' }))).toBe(false)
  })
  it('false when the scene has only an audio bed (real content)', () => {
    expect(
      isEmptyAgentShell(scene({ id: 'd', audioLayer: { enabled: true, src: 'bed.mp3' } as never })),
    ).toBe(false)
  })
  it('false when the scene has only text overlays', () => {
    expect(isEmptyAgentShell(scene({ id: 'e', textOverlays: [{ id: 't' }] as never }))).toBe(false)
  })
  it('false when the scene has only svg objects', () => {
    expect(isEmptyAgentShell(scene({ id: 'f', svgObjects: [{ id: 's' }] as never }))).toBe(false)
  })
})

describe('cleanScenesForAgentPersistence drops NEW codeless shells (#5)', () => {
  it('drops a NEW empty shell but keeps coded + prompted scenes', () => {
    const original: Scene[] = []
    const updated: Scene[] = [
      scene({ id: 'coded', reactCode: 'function Scene(){return null}' }),
      scene({ id: 'prompted', prompt: 'keys & signatures' }),
      scene({ id: 'orphan' }), // NEW codeless shell — must be dropped
    ]
    const out = cleanScenesForAgentPersistence(updated, original)
    const ids = out.map((s) => (s as Scene).id)
    expect(ids).toContain('coded')
    expect(ids).toContain('prompted')
    expect(ids).not.toContain('orphan')
  })

  it('NEVER drops a PRE-EXISTING scene, even if empty', () => {
    const preExisting = scene({ id: 'old-empty' })
    const out = cleanScenesForAgentPersistence([preExisting], [preExisting])
    expect(out.map((s) => (s as Scene).id)).toContain('old-empty')
  })

  it('KEEPS a NEW audio-only scene (not mistaken for an empty shell)', () => {
    const updated: Scene[] = [
      scene({ id: 'coded', reactCode: 'function Scene(){return null}' }),
      scene({ id: 'audio', audioLayer: { enabled: true, src: 'bed.mp3' } as never }),
    ]
    const out = cleanScenesForAgentPersistence(updated, [])
    expect(out.map((s) => (s as Scene).id)).toContain('audio')
  })

  it('keeps everything when the run produced NO renderable scene (matches renderer)', () => {
    // hasContentScene guard: an audio-bed-only run (no code scene anywhere) must
    // not have its only scene swept — the renderer keeps it, so persist must too.
    const updated: Scene[] = [scene({ id: 'audio-only', audioLayer: { enabled: true, src: 'bed.mp3' } as never })]
    const out = cleanScenesForAgentPersistence(updated, [])
    expect(out.map((s) => (s as Scene).id)).toContain('audio-only')
  })
})
