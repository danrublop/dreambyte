/**
 * OKF bundle model — walks the canonical knowledge bundle into a graph of
 * concept nodes + edges, for (a) the visualizer (P6, "see what the agent knows")
 * and (b) generated index.md files. Pure-ish: reads disk, returns plain data;
 * the HTML/markdown rendering lives in the gen script so this stays testable.
 */
import fs from 'fs'
import path from 'path'
import { parseFrontmatter } from './frontmatter'

const RESERVED = new Set(['index.md', 'log.md', 'README.md'])

export interface OkfNode {
  /** stable id = `${group}/${filename-without-md}` */
  id: string
  /** frontmatter `type` (rule/doctrine/playbook/skill/guide) or 'unknown' */
  type: string
  title: string
  description: string
  tags: string[]
  /** which sub-bundle it came from (rules/library) */
  group: string
  /** absolute path on disk */
  filePath: string
}

export type OkfEdgeKind = 'tag' | 'link'

export interface OkfEdge {
  source: string
  target: string
  kind: OkfEdgeKind
}

export interface OkfBundle {
  nodes: OkfNode[]
  /** synthetic tag-hub node ids (type 'tag') for graph clustering */
  tagHubs: string[]
  edges: OkfEdge[]
}

export interface BundleRoot {
  dir: string
  group: string
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

/**
 * Walk the given roots into a bundle graph. Concept nodes come from each
 * non-reserved `.md`'s frontmatter; tag-hub nodes + `tag` edges cluster concepts
 * that share a tag (a star per tag, not an O(n²) pairwise hairball). Missing dirs
 * are skipped. Deterministic ordering (group, then id).
 */
export function walkOkfBundle(roots: BundleRoot[]): OkfBundle {
  const nodes: OkfNode[] = []
  for (const root of roots) {
    let names: string[]
    try {
      names = fs.readdirSync(root.dir).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.md') || RESERVED.has(name)) continue
      const filePath = path.join(root.dir, name)
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch {
        continue
      }
      const { meta } = parseFrontmatter(raw)
      const base = name.slice(0, -3)
      const tags = Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : []
      nodes.push({
        id: `${root.group}/${base}`,
        type: str(meta.type, 'unknown'),
        title: str(meta.title, base),
        description: str(meta.description),
        tags,
        group: root.group,
        filePath,
      })
    }
  }

  // Tag hubs + tag edges: one hub per distinct tag, each concept linked to its tags.
  const tagSet = new Set<string>()
  for (const n of nodes) for (const t of n.tags) tagSet.add(t)
  const tagHubs = [...tagSet].sort().map((t) => `tag:${t}`)
  const edges: OkfEdge[] = []
  for (const n of nodes) {
    for (const t of n.tags) edges.push({ source: n.id, target: `tag:${t}`, kind: 'tag' })
  }

  return { nodes, edges, tagHubs }
}

/** The canonical bundle roots (resolved against cwd, like the other loaders). */
export function canonicalBundleRoots(cwd: string = process.cwd()): BundleRoot[] {
  return [
    { dir: path.join(cwd, '.claude', 'skills', 'dreambyte', 'rules'), group: 'rules' },
    { dir: path.join(cwd, 'src', 'lib', 'skills', 'library'), group: 'library' },
  ]
}
