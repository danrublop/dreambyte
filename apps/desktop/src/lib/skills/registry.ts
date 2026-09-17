/**
 * Skill registry — indexes skill metadata at startup, loads full content on demand.
 *
 * Architecture inspired by:
 * - Claude Code's snapshot-based tool registry with token-based routing
 * - Composio's meta-tool discovery pattern
 * - Memvid's hybrid search (text + tag matching)
 *
 * Skills are markdown files in src/lib/skills/library/ with YAML frontmatter.
 * Only frontmatter is indexed (fast). Full guide bodies are loaded on demand by the
 * per-scene selector (selectSkillsForScene), which injects them into the builder.
 */

import fs from 'fs'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import os from 'os'
import type {
  SkillMetadata,
  SkillContent,
  SkillSearchResult,
  SkillCategory,
  SkillTier,
  SkillOrigin,
  SkillEnrichment,
} from './types'

// ── Parsing ─────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Parse a skill markdown file into metadata + guide content.
 *
 * `originDefault` is the provenance the scanner ASSIGNS based on which dir the
 * file came from: `curated` for the bundled `library/`, `distilled` for the
 * writable user dir. The frontmatter `origin` field (if present and valid) wins;
 * otherwise this default is stamped, so a distilled file with no explicit
 * `origin:` line is still correctly classified.
 */
function parseSkillFile(filePath: string, originDefault: SkillOrigin = 'curated'): SkillContent | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }

  const match = raw.match(FRONTMATTER_RE)
  if (!match) return null

  const [, frontmatter, guide] = match
  const metadata = parseFrontmatter(frontmatter, path.basename(filePath, '.md'), originDefault)
  if (!metadata) return null

  return { metadata, guide: guide.trim() }
}

/**
 * Parse skill frontmatter into normalised metadata.
 *
 * Backed by the `yaml` library (a real spec-compliant parser) rather than the
 * former hand-rolled line scanner. The hand parser silently dropped `enum:`
 * arrays nested inside `parameters` objects and was brittle around indentation;
 * the OKF substrate needs the frontmatter read with full fidelity. We still
 * normalise/clamp every field here so a malformed or pre-OKF file degrades to
 * sane defaults instead of throwing (callers treat null as "skip this skill").
 */
function parseFrontmatter(
  yamlSrc: string,
  fallbackId: string,
  originDefault: SkillOrigin = 'curated',
): SkillMetadata | null {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlSrc)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [])

  const id = (obj.id as string) || fallbackId
  const name = (obj.name as string) || fallbackId
  const description = (obj.description as string) || ''

  // OKF aliases. `type`/`title`/`timestamp`/`tier` are simple top-level scalars,
  // so they flow through the same keyMatch path as id/name. We normalise here
  // and fall back to registry-native fields so pre-OKF skill files still parse.
  const tierRaw = typeof obj.tier === 'string' ? (obj.tier as string).trim() : ''
  const tier: SkillTier = tierRaw === 'always' ? 'always' : 'on-demand'

  // Distilled-style provenance. `origin` falls back to the dir-based default
  // (curated for library/, distilled for the user dir); `enrichment` is only
  // meaningful on distilled skills and is '' otherwise.
  const originRaw = typeof obj.origin === 'string' ? (obj.origin as string).trim() : ''
  const origin: SkillOrigin = originRaw === 'distilled' || originRaw === 'curated' ? originRaw : originDefault
  const enrichmentRaw = typeof obj.enrichment === 'string' ? (obj.enrichment as string).trim() : ''
  const enrichment: SkillEnrichment | '' = enrichmentRaw === 'llm' || enrichmentRaw === 'stub' ? enrichmentRaw : ''

  return {
    id,
    name,
    category: (obj.category as SkillCategory) || 'technique',
    tags: asStringArray(obj.tags),
    sceneType: (obj.sceneType as string) || 'any',
    complexity: (obj.complexity as 'simple' | 'medium' | 'complex') || 'medium',
    requires: asStringArray(obj.requires),
    description,
    parameters: Array.isArray(obj.parameters)
      ? (obj.parameters as Record<string, unknown>[])
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            name: (p.name as string) || '',
            type: (p.type as string) || 'string',
            default: p.default,
            description: (p.description as string) || '',
            enum: Array.isArray(p.enum) ? p.enum.map((x) => String(x)) : undefined,
          }))
      : [],
    // OKF surface — `title` aliases `name`, `type` defaults to `skill`.
    type: (obj.type as string) || 'skill',
    title: (obj.title as string) || name,
    timestamp: obj.timestamp === undefined || obj.timestamp === null ? '' : String(obj.timestamp),
    tier,
    origin,
    enrichment,
  }
}

/**
 * Test-only: expose the frontmatter parser so unit tests can exercise OKF
 * field parsing, tier normalisation, and pre-OKF fallback without writing
 * fixture files. Not part of the public skill API.
 */
export function __parseFrontmatterForTesting(
  yaml: string,
  fallbackId: string,
  originDefault: SkillOrigin = 'curated',
): SkillMetadata | null {
  return parseFrontmatter(yaml, fallbackId, originDefault)
}

// ── Registry ────────────────────────────────────────────────────────────────

const SKILLS_DIR = path.join(process.cwd(), 'src', 'lib', 'skills', 'library')

/**
 * Writable distilled-style skill dir.
 *
 * Bundled `library/` lives under `process.cwd()`, which is READ-ONLY in a
 * packaged Electron build (the asar / app bundle) — writing a distilled skill
 * there would throw. Distilled style skills
 * therefore live in the same writable convention the MCP socket + instances
 * use: `~/.dreambyte/skills/styles/` (src/electron/mcp-server-manager.ts).
 *
 * Resolved LAZILY through `os.homedir()` on every call rather than cached at
 * module-load, so tests can override `$HOME` (and Windows `USERPROFILE`) for
 * filesystem isolation without re-importing the module. `os.homedir()` reads
 * the env on each call, so this honours a per-test `process.env.HOME` swap.
 */
export function getUserStylesDir(): string {
  return path.join(os.homedir(), '.dreambyte', 'skills', 'styles')
}

/**
 * Generated/reserved markdown files in the library dir that are NOT skills.
 * `index.md` is the OKF routing catalog (a generated VIEW over the registry),
 * so it must never be indexed as a skill — doing so would leak an `index`
 * entry into getAllSkillIds() and the agent's skill list.
 */
const NON_SKILL_FILES = new Set(['index.md'])

/** In-memory skill index — metadata only, loaded once */
let skillIndex: SkillMetadata[] | null = null

/** Full content cache — populated lazily by loadSkill */
const contentCache = new Map<string, SkillContent>()

/**
 * mtime signature of the user styles dir at the last index build (#1 cache
 * coherence). The registry is a module SINGLETON, so an in-app build can't see
 * a distilled skill another process (the MCP daemon) just wrote — its index is
 * stale. Before serving `searchSkills`/`loadSkill` we cheaply re-stat the user
 * dir; if the directory mtime OR any contained `.md` mtime changed, we lazily
 * rebuild. Bundled `library/` is build-frozen, so only the writable dir needs
 * watching. `null` = never indexed / dir absent at last build. */
let userDirSignature: string | null = null

/** Compute a cheap mtime signature of the user styles dir: dir mtime + each
 *  `.md` file's mtime. Returns '' when the dir is absent (graceful — a write
 *  later creates it and the signature flips). Any add/remove/overwrite moves
 *  the dir mtime and/or a file mtime, so the signature changes and triggers a
 *  lazy rebuild. */
function computeUserDirSignature(): string {
  const dir = getUserStylesDir()
  try {
    const dirStat = fs.statSync(dir)
    const parts = [`d:${dirStat.mtimeMs}`]
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue
      try {
        parts.push(`${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`)
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
    return parts.join('|')
  } catch {
    return '' // dir absent
  }
}

/**
 * Lazily rebuild the index when the user styles dir changed under us (cross-
 * process write). Called at the top of every public read entry point. Cheap:
 * one stat + one readdir on the small styles dir; only rebuilds on an actual
 * mtime delta. */
function ensureFreshUserDir(): void {
  if (!skillIndex) return // not built yet — buildIndex will scan fresh anyway
  const sig = computeUserDirSignature()
  if (sig !== userDirSignature) {
    reindexSkills()
  }
}

/**
 * Build the skill index by DUAL-SCANNING:
 *  1. bundled `library/` — read-only curated skills (origin: curated)
 *  2. `~/.dreambyte/skills/styles/` — writable distilled style skills (origin: distilled)
 *
 * A distilled id that collides with a curated id does NOT overwrite the curated
 * skill — curated wins (we skip a user-dir entry whose id is already indexed),
 * so a distilled skill can never shadow a bundled renderer guide. The user dir
 * is scanned even when absent (skipped gracefully); it is only mkdir'd on write
 * (writeStyleSkill), never on read.
 */
function buildIndex(): SkillMetadata[] {
  if (skillIndex) return skillIndex

  skillIndex = []

  // ── 1. Bundled curated library ──────────────────────────────────────────
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
  } else {
    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md') && !NON_SKILL_FILES.has(f))
    for (const file of files) {
      const content = parseSkillFile(path.join(SKILLS_DIR, file), 'curated')
      if (content) {
        skillIndex.push(content.metadata)
        contentCache.set(content.metadata.id, content)
      }
    }
  }

  // ── 2. Writable distilled style dir (graceful when absent) ───────────────
  const userDir = getUserStylesDir()
  if (fs.existsSync(userDir)) {
    const curatedIds = new Set(skillIndex.map((s) => s.id))
    const styleFiles = fs.readdirSync(userDir).filter((f) => f.endsWith('.md'))
    for (const file of styleFiles) {
      const content = parseSkillFile(path.join(userDir, file), 'distilled')
      if (!content) continue
      // Curated skills are authoritative — a distilled id never shadows one.
      if (curatedIds.has(content.metadata.id)) continue
      skillIndex.push(content.metadata)
      contentCache.set(content.metadata.id, content)
    }
  }

  // Record the dir signature this index was built against (cache coherence #1).
  userDirSignature = computeUserDirSignature()

  return skillIndex
}

/** Force re-index (useful after adding new skill files) */
export function reindexSkills(): void {
  skillIndex = null
  contentCache.clear()
  buildIndex()
}

// ── Public API (used by skill tools) ────────────────────────────────────────

/**
 * Search for skills by query text, optional category, scene type, and tags.
 * Uses token-based scoring (inspired by Claude Code's route_prompt).
 */
export function searchSkills(
  query: string,
  filters?: {
    category?: SkillCategory
    sceneType?: string
    tags?: string[]
  },
  limit = 8,
): SkillSearchResult[] {
  ensureFreshUserDir() // #1: pick up a cross-process distilled write before searching
  const index = buildIndex()
  const queryTokens = tokenize(query)

  // Growth governance (#4): distilled style skills are EXCLUDED from default
  // results — they only surface when the caller explicitly asks for
  // category:'style' (or tags a style query). Otherwise the styles dir would
  // dilute every renderer/effect search as it grows toward the cap of 25.
  const includeDistilled = filters?.category === 'style'

  const results: SkillSearchResult[] = []

  for (const skill of index) {
    // Growth governance (#4): hide distilled style skills from non-style searches.
    if (skill.origin === 'distilled' && !includeDistilled) continue
    // Apply filters first (fast rejection)
    if (filters?.category && skill.category !== filters.category) continue
    if (filters?.sceneType && skill.sceneType !== 'any' && skill.sceneType !== filters.sceneType) continue
    if (filters?.tags?.length && !filters.tags.some((t) => skill.tags.includes(t))) continue

    // Score against query tokens
    const score = scoreSkill(queryTokens, skill)
    if (score > 0) {
      results.push({ metadata: skill, score })
    }
  }

  // Sort by score descending, then by name for stability
  results.sort((a, b) => b.score - a.score || a.metadata.name.localeCompare(b.metadata.name))

  return results.slice(0, limit)
}

/**
 * Load a skill's full implementation guide.
 * Returns null if skill not found.
 */
export function loadSkill(skillId: string): SkillContent | null {
  ensureFreshUserDir() // #1: pick up a cross-process distilled write before loading
  buildIndex() // ensure indexed

  // Check cache first
  if (contentCache.has(skillId)) return contentCache.get(skillId)!

  // Never load a reserved/generated file (e.g. index.md) as a skill.
  if (NON_SKILL_FILES.has(`${skillId}.md`)) return null

  // Try loading from the bundled library first (curated authority).
  const filePath = path.join(SKILLS_DIR, `${skillId}.md`)
  const content = parseSkillFile(filePath, 'curated')
  if (content) {
    contentCache.set(skillId, content)
    return content
  }

  // Fall back to the writable distilled style dir.
  const stylePath = path.join(getUserStylesDir(), `${skillId}.md`)
  const styleContent = parseSkillFile(stylePath, 'distilled')
  if (styleContent) {
    contentCache.set(skillId, styleContent)
    return styleContent
  }

  return null
}

/**
 * Load the single library skill whose sceneType matches the given renderer
 * (deterministic renderer→skill map: 'three' → threejs-3d-scene, 'd3' →
 * d3-data-visualization, etc.). Returns null for sceneTypes with no dedicated
 * skill — notably 'react', the default COMPOSED renderer, which carries its own
 * guidance in the React system prompt. Used by the orchestrator
 * to inject the matched skill's guide straight into a scene-builder
 * sub-agent. It is the ONLY path now — the model-elective load_skill was deleted.
 */
export function loadSkillForSceneType(sceneType: string): SkillContent | null {
  if (!sceneType) return null
  const match = buildIndex().find((s) => s.sceneType === sceneType)
  return match ? loadSkill(match.id) : null
}

/**
 * Get all skill IDs (for validation).
 */
export function getAllSkillIds(): string[] {
  ensureFreshUserDir() // #1: reflect cross-process distilled writes/deletes
  return buildIndex().map((s) => s.id)
}

/**
 * Get metadata for specific skill IDs (for pinned skills in custom agents).
 */
export function getSkillMetadata(ids: string[]): SkillMetadata[] {
  const index = buildIndex()
  return index.filter((s) => ids.includes(s.id))
}

/**
 * CURATED-ONLY skill ids (origin:'curated' — the bundled `library/*.md`).
 *
 * The generated repo-tracked artifacts (src/lib/skills/library/index.md) and the
 * plan-phase catalog must be derived from CURATED skills ONLY: distilled
 * styles live in a machine-local writable dir, so baking their hash ids into a
 * committed file would flap the CI stale-gate on any dev who distilled a style.
 * `getAllSkillIds()` dual-scans (includes distilled); this is the curated view.
 */
export function getCuratedSkillIds(): string[] {
  return buildIndex()
    .filter((s) => s.origin === 'curated')
    .map((s) => s.id)
}

/**
 * Get the total number of registered skills.
 */
export function getSkillCount(): number {
  return buildIndex().length
}

// ── Scoring (token-based, inspired by Claude Code) ──────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1)
}

function scoreSkill(queryTokens: string[], skill: SkillMetadata): number {
  if (queryTokens.length === 0) return 0.5 // empty query matches everything weakly

  // Build searchable haystack from skill fields
  const haystacks = [
    skill.name.toLowerCase(),
    skill.description.toLowerCase(),
    skill.tags.join(' ').toLowerCase(),
    skill.category.toLowerCase(),
    skill.sceneType.toLowerCase(),
  ]
  const fullHaystack = haystacks.join(' ')

  let matched = 0
  let totalWeight = 0

  for (const token of queryTokens) {
    // Weight: name match > tag match > description match
    if (skill.name.toLowerCase().includes(token)) {
      matched += 3
    } else if (skill.tags.some((t) => t.toLowerCase().includes(token))) {
      matched += 2
    } else if (fullHaystack.includes(token)) {
      matched += 1
    }
    totalWeight += 3 // max possible per token
  }

  return totalWeight > 0 ? matched / totalWeight : 0
}
