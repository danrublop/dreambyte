/**
 * Loads OKF craft rule-pack markdown for injection into the agent's context.
 * Reads `.claude/skills/dreambyte/rules/<id>.md`.
 *
 * Path resolution mirrors `loadDreambyteSkill()` in `runner.ts`: in the PACKAGED app
 * electron-builder maps `.claude/skills/dreambyte` → `Resources/skill-data/dreambyte`,
 * so a bare `process.cwd()` read would silently return nothing in production. We
 * try resourcesPath + __dirname-relative + cwd and use the first that exists.
 *
 * Results are cached (the bundle is read-only at runtime; the app restarts to pick
 * up edits). Best-effort by contract: a
 * missing/unreadable pack is SKIPPED, never thrown — a routing miss must never
 * break prompt assembly.
 */
import fs from 'fs'
import path from 'path'
import { parseFrontmatter } from './frontmatter'

/** Resolve the rules dir across dev + packaged. First existing wins. */
function resolveRulesDir(): string {
  const candidates = [
    process.env.DREAMBYTE_RULES_DIR,
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'skill-data', 'dreambyte', 'rules')
      : undefined,
    // Bundled main.js lives in dist-electron/; project root is one up.
    path.join(__dirname, '..', '.claude', 'skills', 'dreambyte', 'rules'),
    path.join(process.cwd(), '.claude', 'skills', 'dreambyte', 'rules'),
  ].filter((d): d is string => typeof d === 'string')
  for (const d of candidates) {
    try {
      if (fs.statSync(d).isDirectory()) return d
    } catch {
      // next candidate
    }
  }
  return candidates[candidates.length - 1]
}

const RULES_DIR = resolveRulesDir()

/** Safe rule-pack id: lowercase, digits, hyphens. Defense-in-depth against path
 *  traversal even though ids originate from routeOKF's fixed table. */
const SAFE_ID = /^[a-z0-9-]+$/

const RESERVED = new Set(['index.md', 'log.md', 'README.md'])

// ── Caches (bundle is read-only at runtime; restart to refresh) ──────────────
const _bodyCache = new Map<string, string>()
let _indexCache: RulePackIndexEntry[] | null = null

/** Read + strip one pack body, cached. '' when missing/unreadable. */
function readPackBody(id: string): string {
  const hit = _bodyCache.get(id)
  if (hit !== undefined) return hit
  let body = ''
  try {
    const raw = fs.readFileSync(path.join(RULES_DIR, `${id}.md`), 'utf8')
    // Strip OKF frontmatter so the YAML never leaks into the prompt — only the
    // markdown body is craft guidance the model should read.
    body = parseFrontmatter(raw).body
  } catch {
    body = ''
  }
  _bodyCache.set(id, body)
  return body
}

/**
 * Load the given rule-pack ids (in order) and join them with `---` separators.
 * Returns '' when none could be loaded (caller skips the block).
 */
export function loadRulePacks(ids: string[]): string {
  const blocks: string[] = []
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue
    const body = readPackBody(id)
    if (body) blocks.push(body)
  }
  return blocks.join('\n\n---\n\n')
}

/**
 * Every loadable pack id, sorted — the enum on `get_routed_craft({ pack })`.
 *
 * WHY THIS IS GENERATED, NOT WRITTEN DOWN: the advertised pack list used to be typed by
 * hand in two places — get_routed_craft's `pack` description and ROUTER.md — and both had
 * drifted from the packs actually on disk. A pack that isn't advertised is a pack that
 * doesn't exist. Ids that don't resolve to a body are dropped — the enum never names an
 * id the loader would return empty for.
 *
 * There is no exclusion list: delete a pack's file to unadvertise it.
 */
export function loadRulePackIds(): string[] {
  return loadRulePackIndex()
    .map((e) => e.id)
    .filter((id) => SAFE_ID.test(id) && !!readPackBody(id))
    .sort()
}

/** One rule file's routing-relevant metadata. */
export interface RulePackIndexEntry {
  /** filename minus .md — the concept id / loadRulePacks key */
  id: string
  /** frontmatter `tags` (the routing surface); [] when absent */
  tags: string[]
  /** frontmatter `description` (the menu "read when" trigger); '' when absent */
  description: string
}

/**
 * Read every rule file's frontmatter tags from the canonical bundle. This is the
 * data-driven routing surface: the intent-router selects packs by tag intersection
 * over THIS index, so adding a rule file (tagged `core` / `lane:*` / `format:*`)
 * makes it route with NO code change. Reserved files (index.md/log.md/README.md)
 * are skipped. Cached after first read. Best-effort: unreadable dir → []. Impure
 * (I/O); pass the result into the pure routeOKF.
 */
export function loadRulePackIndex(): RulePackIndexEntry[] {
  if (_indexCache !== null) return _indexCache
  let names: string[]
  try {
    names = fs.readdirSync(RULES_DIR)
  } catch {
    _indexCache = []
    return _indexCache
  }
  const out: RulePackIndexEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.md') || RESERVED.has(name)) continue
    const id = name.slice(0, -3)
    if (!SAFE_ID.test(id)) continue
    try {
      const meta = parseFrontmatter(fs.readFileSync(path.join(RULES_DIR, name), 'utf8')).meta
      const tags = Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : []
      const description = typeof meta.description === 'string' ? meta.description.trim() : ''
      out.push({ id, tags, description })
    } catch {
      // unreadable file — skip
    }
  }
  _indexCache = out
  return out
}
