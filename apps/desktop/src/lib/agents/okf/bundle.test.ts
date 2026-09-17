// @vitest-environment node

// walkOkfBundle over the REAL canonical bundle — doubles as a guard that the
// bundle stays graph-able (frontmatter parses, types/tags present).

import { describe, it, expect } from 'vitest'
import { walkOkfBundle, canonicalBundleRoots } from './bundle'

describe('walkOkfBundle (canonical bundle)', () => {
  const bundle = walkOkfBundle(canonicalBundleRoots())

  it('finds concept nodes across both remaining groups', () => {
    // pipelines/ was deleted entirely in the 22→4 corpus cut.
    expect(bundle.nodes.length).toBeGreaterThan(5)
    const groups = new Set(bundle.nodes.map((n) => n.group))
    expect(groups).toEqual(new Set(['rules', 'library']))
  })

  it('reads frontmatter type + tags for a known craft pack', () => {
    const audio = bundle.nodes.find((n) => n.id === 'rules/audio')
    expect(audio).toBeTruthy()
    expect(audio!.type).toBe('rule')
    expect(audio!.tags).toContain('core')
  })

  it('builds tag hubs and tag edges (audio → tag:core)', () => {
    expect(bundle.tagHubs).toContain('tag:core')
    const edge = bundle.edges.find((e) => e.source === 'rules/audio' && e.target === 'tag:core')
    expect(edge).toBeTruthy()
    expect(edge!.kind).toBe('tag')
  })

  it('every node has a non-empty type (conformance reflected in the graph)', () => {
    const untyped = bundle.nodes.filter((n) => !n.type || n.type === 'unknown').map((n) => n.id)
    expect(untyped, `untyped nodes:\n${untyped.join('\n')}`).toEqual([])
  })

  it('skips reserved files (no index.md/log.md as concept nodes)', () => {
    expect(bundle.nodes.some((n) => n.id.endsWith('/index') || n.id.endsWith('/log'))).toBe(false)
  })
})
