/**
 * memory/ OKF export view.
 *
 * SQLite (`user_memory`) is the STORE OF RECORD. This module
 * produces a generated, READ-ONLY VIEW of that store: an OKF `memory/` bundle of
 * markdown concepts so learned preferences are portable/inspectable as files.
 *
 * LOCKED decisions this file embodies (mirroring src/lib/skills/distill.ts's shape):
 *  - One-way VIEW: regenerate-from-SQLite, overwrite/upsert, NO migration, never
 *    a store-of-record. We never read these files back into user_memory.
 *  - Output dir is the writable convention `~/.dreambyte/memory/`, resolved
 *    LAZILY via os.homedir() on every call so tests can override $HOME for fs
 *    isolation (mirrors registry.getUserStylesDir).
 *  - One markdown concept per memory row, keyed `<category>__<key>`. OKF
 *    frontmatter PRIMITIVES ONLY (type/title/description/tags/timestamp +
 *    category/key/scope/confidence) so the registry's `yaml`-backed
 *    parseFrontmatter round-trips it. Rich text (the value) lives in the body.
 *  - Path-guarded writes (src/lib/agents/dreambyte-fs/path-guard) so a crafted
 *    category/key with `../` can never escape the bundle dir.
 *  - Honest + safe: an empty memory set yields a VALID empty bundle (just an
 *    index.md with zero entries); generation never throws on empty/sparse input.
 *  - NOT wired into the agent loop and has NO in-app consumer yet (accepted) —
 *    this is an export/inspection artifact, regenerated on demand.
 *
 * This bundle lives in a SEPARATE dir (~/.dreambyte/memory/) from the skills
 * library and its `gen:okf` stale-gate — generating it must never touch the
 * skills index or trip scripts/okf/gen-okf-index.ts --check.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { safeResolve } from '../agents/dreambyte-fs/path-guard'
import { getMemoriesForUser, getMemoriesScoped } from '../db/queries/user-memory'
import type { ScopedMemory } from '../db/queries/user-memory'

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single memory fact in the bundle's input shape. This is the {@link ScopedMemory}
 * shape from the scoped read, with `layer` mapped to a human `scope` label. The
 * pure render/index fns take this so tests drive them without a DB.
 */
export interface MemoryConcept {
  category: string
  key: string
  value: string
  confidence: number
  /** user-global vs project (vs workspace-derived) — surfaced in the body. */
  scope: 'user' | 'project' | 'workspace'
}

export interface RenderedConcept {
  /** Filesystem-safe concept id → `<id>.md`. */
  id: string
  markdown: string
  concept: MemoryConcept
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Slugify a token into a filesystem- and id-safe fragment (mirrors distill.slug). */
function slugFragment(s: string): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'untitled'
  )
}

/**
 * Deterministic concept id from (category, key). A user-global and a
 * project-scoped row can carry the SAME (category, key) — the scoped read
 * already collapses them to the narrowest-wins single fact per key (so the
 * bundle never holds both).
 *
 * NOT injective: `slugFragment` is lossy (case-folds, collapses runs of
 * non-`[a-z0-9]` to a single `-`, and slices to 64 chars), so DISTINCT raw
 * (category, key) pairs — e.g. key `bg color` vs `bg-color` vs `bg_color`, or
 * two 64+ char keys differing only past the cutoff — can map to the SAME id.
 * Callers that key files/maps by this id MUST de-duplicate on collision (see
 * {@link buildRenderedConcepts}) or one concept is silently dropped. Pure.
 */
export function memoryConceptId(category: string, key: string): string {
  return `${slugFragment(category)}__${slugFragment(key)}`
}

/**
 * Shape of the regex memoryConceptId produces: `<category-slug>__<key-slug>.md`
 * where each slug is `[a-z0-9-]+` (slugFragment's output alphabet). Plus the
 * fixed `index.md`. This is the set of filenames THIS generator owns — the
 * sweep is scoped to it so a user-/tool-authored `notes.md`/`README.md` in the
 * bundle dir is never touched. A disambiguated id (see
 * {@link buildRenderedConcepts}) appends `-<hash>` to the key slug, which still
 * matches `[a-z0-9-]+`, so collision-broken files remain generator-owned.
 */
const GENERATOR_OWNED_MD = /^(?:[a-z0-9-]+__[a-z0-9-]+|index)\.md$/

/** True iff `name` is a markdown file THIS generator owns (concept or index). */
function isGeneratorOwnedFile(name: string): boolean {
  return GENERATOR_OWNED_MD.test(name)
}

/**
 * Build the rendered concept set from raw memory facts, de-duplicating
 * id collisions so two distinct rows whose (category, key) slugify to the SAME
 * {@link memoryConceptId} each get a DISTINCT file instead of one silently
 * clobbering the other.
 *
 * On collision we disambiguate DETERMINISTICALLY: the second-and-later concept
 * to claim an id gets `-<hash>` appended to its key slug, where `<hash>` is the
 * first 8 hex chars of sha256(`<rawCategory>:<rawKey>`) — stable across runs
 * and derived from the RAW (pre-slug) pair, so the same row always lands on the
 * same file. The first claimant keeps the bare id (single-row behaviour is
 * unchanged). Collisions are surfaced in {@link MemoryBundleResult.collisions}
 * so the drop-avoidance is observable, never silent. PURE.
 */
export function buildRenderedConcepts(concepts: MemoryConcept[]): {
  rendered: RenderedConcept[]
  collisions: ConceptCollision[]
} {
  const claimed = new Set<string>()
  const rendered: RenderedConcept[] = []
  const collisions: ConceptCollision[] = []
  for (const c of concepts) {
    const baseId = memoryConceptId(c.category, c.key)
    let id = baseId
    if (claimed.has(id)) {
      const hash = crypto.createHash('sha256').update(`${c.category}:${c.key}`).digest('hex').slice(0, 8)
      id = `${slugFragment(c.category)}__${slugFragment(c.key)}-${hash}`
      // Extremely unlikely, but guard against a hash-suffixed id ALSO colliding
      // (e.g. an upstream row already carrying that literal slug): keep
      // extending with the hash until unique so we never drop a concept.
      while (claimed.has(id)) id = `${id}-${hash}`
      collisions.push({ baseId, id, category: c.category, key: c.key })
    }
    claimed.add(id)
    rendered.push(renderMemoryConceptWithId(c, id))
  }
  return { rendered, collisions }
}

/** Today's date as a UTC YYYY-MM-DD stamp — a freshness marker, not a content hash. */
function isoDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Collapse a string to a single-line frontmatter-safe scalar. The naive YAML
 * subset some readers use trips on a stray `:`/`[`/`#`/`{`; the registry's
 * `yaml`-backed parser is robust, but we still quote risky values so the bundle
 * round-trips through EITHER parser. Mirrors distill.sanitizeScalar.
 */
function sanitizeScalar(v: string): string {
  const cleaned = String(v).replace(/\s+/g, ' ').trim()
  if (cleaned === '') return '""'
  if (/[:#[\]{}>"'@|*&!%]/.test(cleaned) || /^[-?]/.test(cleaned)) return JSON.stringify(cleaned)
  return cleaned
}

/** Derive a short, frontmatter-safe one-line description from category/key/value. */
function describeConcept(c: MemoryConcept): string {
  const valueBit = c.value.replace(/\s+/g, ' ').trim().slice(0, 120)
  return `Learned ${c.category} preference "${c.key}": ${valueBit}`.slice(0, 200)
}

/** Build the flat YAML tag array for a concept, sanitized to bare scalar tokens. */
function tagsLine(c: MemoryConcept): string {
  const raw = ['memory', 'preference', c.category, c.scope]
  const seen = new Set<string>()
  const tags: string[] = []
  for (const t of raw) {
    const cleaned = slugFragment(t)
    if (cleaned && cleaned !== 'untitled' && !seen.has(cleaned)) {
      seen.add(cleaned)
      tags.push(cleaned)
    }
  }
  return `[${tags.join(', ')}]`
}

/**
 * Render one memory fact into an OKF `{ id, markdown }` concept. PURE.
 *
 * Frontmatter is PRIMITIVES ONLY (type/title/description/tags/timestamp +
 * category/key/scope/confidence) — every value a scalar or flat string array, so
 * the registry's parseFrontmatter round-trips it. The VALUE (free text, may carry
 * `:`/newlines) lives in the body, where it can't corrupt the frontmatter.
 */
export function renderMemoryConcept(c: MemoryConcept): RenderedConcept {
  return renderMemoryConceptWithId(c, memoryConceptId(c.category, c.key))
}

/**
 * Render with an EXPLICIT id (the collision-disambiguated case routes here so
 * the on-disk `<id>.md` and the frontmatter `id:` agree). {@link
 * renderMemoryConcept} is the bare-id entry point. PURE.
 */
function renderMemoryConceptWithId(c: MemoryConcept, id: string): RenderedConcept {
  const title = `${c.category} / ${c.key}`
  const confidence = Number.isFinite(c.confidence) ? Math.max(0, Math.min(1, c.confidence)) : 0
  const confidenceStr = confidence.toFixed(2)

  const frontmatter = [
    '---',
    `id: ${id}`,
    'type: preference',
    `title: ${sanitizeScalar(title)}`,
    `description: ${sanitizeScalar(describeConcept(c))}`,
    `tags: ${tagsLine(c)}`,
    `category: ${sanitizeScalar(c.category)}`,
    `key: ${sanitizeScalar(c.key)}`,
    `scope: ${c.scope}`,
    `confidence: ${confidenceStr}`,
    `timestamp: ${isoDay()}`,
    '---',
  ].join('\n')

  const scopeWord =
    c.scope === 'project' ? 'project-scoped' : c.scope === 'workspace' ? 'workspace-derived' : 'user-global'

  // The value is free text — emit it as a fenced/blockquote-safe block so a
  // multi-line or markdown-bearing value reads cleanly and can't be mistaken for
  // frontmatter or a heading.
  const valueLines = c.value.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'))

  const body = [
    `# ${title}`,
    '',
    `> Learned ${scopeWord} preference — a read-only VIEW of the \`user_memory\` SQLite row (the store of record).`,
    '',
    '## Value',
    '',
    ...valueLines,
    '',
    '## Metadata',
    '',
    `- **Category:** ${c.category}`,
    `- **Key:** ${c.key}`,
    `- **Scope:** ${scopeWord}`,
    `- **Confidence:** ${confidenceStr}`,
    '',
  ].join('\n')

  return { id, markdown: `${frontmatter}\n${body}`, concept: c }
}

/**
 * Build the bundle's index.md. PURE. Lists every concept with its scope +
 * confidence so a reader can scan the whole learned-taste set at a glance. An
 * EMPTY concept list still yields a valid index (the empty-bundle contract).
 */
export function buildMemoryIndex(concepts: RenderedConcept[]): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('type: index')
  lines.push('title: Memory Bundle Index')
  lines.push(
    'description: Read-only OKF view of learned user preferences (user_memory). Generated from SQLite; SQLite is authoritative.',
  )
  lines.push('tags: [memory, preference, index, okf]')
  lines.push(`count: ${concepts.length}`)
  lines.push(`timestamp: ${isoDay()}`)
  lines.push('---')
  lines.push('')
  lines.push(GENERATED_BANNER)
  lines.push('')
  lines.push('# Memory Bundle Index')
  lines.push('')
  lines.push(
    "A generated, **read-only** view of the user's learned preferences. The store of record is the `user_memory` table in SQLite — this bundle is regenerated from it on demand and is never written back. Editing these files has no effect on the agent.",
  )
  lines.push('')
  if (concepts.length === 0) {
    lines.push('_No learned preferences yet._')
    lines.push('')
    return lines.join('\n')
  }
  // Stable order: by scope rank, then category, then key.
  const RANK: Record<MemoryConcept['scope'], number> = { project: 0, workspace: 1, user: 2 }
  const sorted = [...concepts].sort((a, b) => {
    const r = RANK[a.concept.scope] - RANK[b.concept.scope]
    if (r !== 0) return r
    if (a.concept.category !== b.concept.category) return a.concept.category.localeCompare(b.concept.category)
    return a.concept.key.localeCompare(b.concept.key)
  })
  for (const { id, concept } of sorted) {
    const conf = (Number.isFinite(concept.confidence) ? concept.confidence : 0).toFixed(2)
    lines.push(`- \`${id}.md\` — **${concept.category} / ${concept.key}** (${concept.scope}, confidence ${conf})`)
  }
  lines.push('')
  return lines.join('\n')
}

const GENERATED_BANNER =
  '<!-- GENERATED read-only VIEW of the user_memory SQLite table — do not edit by hand. Regenerate with `npm run gen:memory-okf`. SQLite is the store of record. -->'

// ── Write (path-guarded, overwrite) ──────────────────────────────────────────

/**
 * Writable bundle dir, resolved LAZILY via os.homedir() (so a per-test
 * $HOME/USERPROFILE swap isolates writes). Mirrors registry.getUserStylesDir's
 * convention — sibling to ~/.dreambyte/skills/, a SEPARATE dir from the
 * skills-library OKF index, so this generator never touches that stale-gate.
 */
export function getMemoryBundleDir(): string {
  return path.join(os.homedir(), '.dreambyte', 'memory')
}

/**
 * A concept id collision that was disambiguated to avoid a silent drop: two
 * distinct rows slugified to the same `baseId`, so this (later) row was given a
 * distinct `id` instead. Surfaced in {@link MemoryBundleResult.collisions}.
 */
export interface ConceptCollision {
  /** The id both rows initially mapped to (the first row keeps it). */
  baseId: string
  /** The distinct, hash-disambiguated id this row was given instead. */
  id: string
  category: string
  key: string
}

export interface MemoryBundleResult {
  dir: string
  /** Relative names written (concepts + index.md). */
  written: string[]
  /** Relative names removed because they're stale (a key that no longer exists). */
  removed: string[]
  conceptCount: number
  /**
   * Id collisions that were disambiguated this run (empty in the common case).
   * Non-empty means distinct rows slugified to the same id and were split onto
   * separate files rather than one silently clobbering the other.
   */
  collisions: ConceptCollision[]
}

/**
 * Render + write a memory bundle from already-fetched concepts. PURE of the DB
 * (the SQLite read is {@link generateMemoryOkfView}'s job) so tests drive it
 * directly. Overwrites in place: every concept file + index.md is (re)written,
 * and any pre-existing GENERATOR-OWNED `.md` in the dir that is NOT in this
 * generation is removed — so a deleted/decayed memory key never leaves a stale
 * file (the regenerate-with-no-dup contract). A foreign `.md` (a user- or
 * tool-authored notes.md/README.md that doesn't match the concept-id shape) is
 * left untouched. Path-guarded. Never throws on an empty set.
 *
 * Distinct rows whose (category, key) slugify to the SAME id are split onto
 * distinct files (see {@link buildRenderedConcepts}) rather than one silently
 * clobbering the other; any such disambiguation is reported in
 * {@link MemoryBundleResult.collisions}.
 */
export async function writeMemoryBundle(concepts: MemoryConcept[]): Promise<MemoryBundleResult> {
  const dir = getMemoryBundleDir()
  fs.mkdirSync(dir, { recursive: true })

  const { rendered, collisions } = buildRenderedConcepts(concepts)
  const index = buildMemoryIndex(rendered)

  // The set of files this generation OWNS (path-guarded targets).
  const desired = new Map<string, string>() // realpath target → content
  for (const r of rendered) {
    const target = await guardBundleFile(dir, `${r.id}.md`)
    desired.set(target, r.markdown)
  }
  const indexTarget = await guardBundleFile(dir, 'index.md')
  desired.set(indexTarget, index)

  // Sweep stale `.md` files (a removed key) BEFORE writing, so the bundle is an
  // exact mirror of the current store with no duplicates. Only GENERATOR-OWNED
  // `.md` files directly in the dir are touched — a foreign notes.md/README.md
  // that doesn't match the concept-id shape is left alone (we never delete what
  // we didn't write).
  const removed: string[] = []
  let existing: string[]
  try {
    existing = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && isGeneratorOwnedFile(f))
  } catch {
    existing = []
  }
  const desiredRealNames = new Set([...desired.keys()].map((p) => path.basename(p)))
  for (const f of existing) {
    if (desiredRealNames.has(f)) continue
    try {
      fs.unlinkSync(path.join(dir, f))
      removed.push(f)
    } catch {
      // best-effort — a vanished file just doesn't count
    }
  }

  // Write every desired file (atomic tmp+rename so a concurrent reader never
  // sees a truncated file).
  const written: string[] = []
  for (const [target, content] of desired) {
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, target)
    written.push(path.basename(target))
  }

  return { dir, written, removed, conceptCount: rendered.length, collisions }
}

/**
 * Resolve `<name>` under the bundle dir through the REALPATH-based guard and
 * pin it to a DIRECT child of the (real) bundle dir — a crafted name with `../`
 * (from a hostile category/key) or a symlinked bundle dir can't escape. Returns
 * the realpath-validated target. Mirrors distill.guardStyleFile.
 */
async function guardBundleFile(dir: string, name: string): Promise<string> {
  const target = await safeResolve(dir, name)
  const realDir = await fs.promises.realpath(dir)
  if (path.dirname(target) !== realDir) {
    throw new Error(`Refusing to write outside the memory bundle dir: "${name}"`)
  }
  return target
}

// ── Read from SQLite (the one-way VIEW source) ───────────────────────────────

/**
 * Map a {@link ScopedMemory} (the scoped read shape) to a {@link MemoryConcept}.
 * `layer` → `scope`. Pure.
 */
function scopedToConcept(m: ScopedMemory): MemoryConcept {
  return { category: m.category, key: m.key, value: m.value, confidence: m.confidence, scope: m.layer }
}

/**
 * Generate the `memory/` OKF view for a user from SQLite. Reads the authoritative
 * `user_memory` rows (reusing the PR-B queries) and writes the bundle. ONE-WAY:
 * SQLite → files; nothing is read back. Never throws on empty memory — an empty
 * read yields a valid empty bundle (index.md with zero entries).
 *
 * When `projectId` is provided, the SCOPED (narrowest-wins) view is generated so
 * the bundle reflects what the agent would actually see for that project
 * (project memory overrides user-global; workspace taste slots between). With no
 * projectId, the user-global memory set is exported (getMemoriesForUser).
 *
 * `maxItems` defaults high (200) — this is an export, not a prompt-injection
 * budget — so the bundle is a fuller picture than the 20-item inject cap.
 */
export async function generateMemoryOkfView(
  userId: string,
  opts: { projectId?: string | null; workspaceId?: string | null; maxItems?: number } = {},
): Promise<MemoryBundleResult> {
  const maxItems = opts.maxItems ?? 200
  let concepts: MemoryConcept[]
  if (opts.projectId) {
    const scoped = await getMemoriesScoped(userId, opts.projectId, {
      maxItems,
      workspaceId: opts.workspaceId ?? null,
    })
    concepts = scoped.map(scopedToConcept)
  } else {
    const rows = await getMemoriesForUser(userId, maxItems)
    concepts = rows.map((r) => ({
      category: r.category,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      scope: 'user' as const,
    }))
  }
  return writeMemoryBundle(concepts)
}
