// @vitest-environment node

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { loadAgentPromptDocs } from './prompt-docs'
import { buildAgentContext } from './context-builder'
import type { GlobalStyle } from '../types'

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dreambyte-prompt-docs-'))
  mkdirSync(path.join(root, 'docs/agent'), { recursive: true })
  return root
}

describe('loadAgentPromptDocs', () => {
  it('loads ROUTER.md + SYSTEM.md into a static prompt block, router first, with hashes', () => {
    const root = makeFixture()
    writeFileSync(path.join(root, 'docs/agent/ROUTER.md'), '# Router\n\nRoute the request first.')
    writeFileSync(path.join(root, 'docs/agent/SYSTEM.md'), '# System\n\nSoftware owns deterministic work.')

    const loaded = loadAgentPromptDocs({ rootDir: root })

    expect(loaded.block).toContain('# Dreambyte Agent Contracts')
    expect(loaded.block).toContain('Route the request first.')
    expect(loaded.block).toContain('Software owns deterministic work.')
    // Router is injected before the operating contract.
    expect(loaded.block.indexOf('Route the request first.')).toBeLessThan(
      loaded.block.indexOf('Software owns deterministic work.'),
    )
    expect(loaded.docs).toHaveLength(2)
    expect(loaded.docs.every((doc) => doc.loaded && doc.hash && doc.hash.length === 12)).toBe(true)
  })

  it('does NOT inject the retired docs/agent/DESIGN.md prose contract', () => {
    const root = makeFixture()
    writeFileSync(path.join(root, 'docs/agent/ROUTER.md'), '# Router\n\nRoute first.')
    writeFileSync(path.join(root, 'docs/agent/SYSTEM.md'), '# System\n\nSoftware owns deterministic work.')
    // Even if a stale DESIGN.md is sitting on disk, the loader must not pick it up.
    writeFileSync(
      path.join(root, 'docs/agent/DESIGN.md'),
      '# Design\n\nEvery generated scene should feel like intentional motion design',
    )

    const loaded = loadAgentPromptDocs({ rootDir: root })

    expect(loaded.docs).toHaveLength(2)
    expect(loaded.docs.some((doc) => doc.relativePath.endsWith('DESIGN.md'))).toBe(false)
    expect(loaded.block).not.toContain('intentional motion design')
  })

  it('handles missing docs without throwing', () => {
    const root = makeFixture()

    const loaded = loadAgentPromptDocs({ rootDir: root })

    expect(loaded.block).toBe('')
    expect(loaded.docs).toHaveLength(2)
    expect(loaded.docs.every((doc) => doc.loaded === false && doc.error === 'missing')).toBe(true)
  })

  it('truncates oversized docs and records the original character count', () => {
    const root = makeFixture()
    writeFileSync(path.join(root, 'docs/agent/SYSTEM.md'), `# System\n\n${'A'.repeat(120)}`)

    const loaded = loadAgentPromptDocs({ rootDir: root, maxCharsPerDoc: 80 })
    const systemDoc = loaded.docs.find((doc) => doc.id === 'system')

    expect(systemDoc?.truncated).toBe(true)
    expect(systemDoc?.chars).toBeGreaterThan(80)
    expect(loaded.block).toContain('[Prompt doc truncated by loader]')
  })
})

describe('buildAgentContext prompt docs', () => {
  it('injects the repository SYSTEM.md operating contract into the static prompt', () => {
    const globalStyle: GlobalStyle = {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    }

    const ctx = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: [], sceneContext: 'all' },
      [],
      globalStyle,
      'Prompt Docs Test',
      'mp4',
    )

    expect(ctx.staticPrompt).toContain('Do not tell the user to manually edit generated scene HTML.')
    // The Tier-0 router reaches the cached static prompt too.
    expect(ctx.staticPrompt).toContain('route the request and match your effort')
    // The static prompt must NOT carry the vague DESIGN.md prose contract.
    expect(ctx.staticPrompt).not.toContain('Every generated scene should feel like intentional motion design')
    expect(ctx.promptDocs?.every((doc) => doc.loaded && doc.hash)).toBe(true)
  })

  it('a sub-agent gets the operating contract but NOT the parent-facing router', () => {
    const globalStyle: GlobalStyle = {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    }
    const ctx = buildAgentContext(
      'scene-maker',
      { agentType: 'scene-maker', activeTools: [], sceneContext: 'all', isSubAgent: true },
      [],
      globalStyle,
      'Sub Agent Test',
      'mp4',
    )
    // SYSTEM.md still present; ROUTER.md excluded (a builder can't route or delegate).
    expect(ctx.staticPrompt).toContain('Do not tell the user to manually edit generated scene HTML.')
    expect(ctx.staticPrompt).not.toContain('route the request and match your effort')
    expect(ctx.promptDocs?.some((doc) => doc.id === 'router')).toBe(false)
  })
})
