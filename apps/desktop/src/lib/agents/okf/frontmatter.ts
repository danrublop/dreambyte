/**
 * Minimal OKF frontmatter parser, shared across the OKF knowledge loaders +
 * the conformance gate. Splits a markdown document into its YAML frontmatter
 * (meta) and the markdown body. Best-effort: malformed YAML yields empty meta
 * but still returns the body — a knowledge file must never be unreadable.
 */
import { parse as parseYaml } from 'yaml'

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export interface ParsedDoc {
  /** Parsed YAML frontmatter (empty object when absent/malformed). */
  meta: Record<string, unknown>
  /** Markdown body with the frontmatter block removed, trimmed. */
  body: string
  /** Whether a `---`-delimited frontmatter block was present at all. */
  hasFrontmatter: boolean
}

export function parseFrontmatter(raw: string): ParsedDoc {
  // Normalize a leading BOM + CRLF line endings BEFORE matching — the fence
  // regex needs literal `\n`, so a Windows-saved (CRLF) or BOM-prefixed file
  // would otherwise read as "no frontmatter" and leak its raw YAML into the
  // prompt (or get dropped by parsePlaybook). Active Windows-parity work makes
  // CRLF a real input.
  raw = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { meta: {}, body: raw.trim(), hasFrontmatter: false }
  let meta: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
  } catch {
    // malformed YAML — keep the body, surface no meta
  }
  return { meta, body: m[2].trim(), hasFrontmatter: true }
}

/** Convenience: the `type` field as a non-empty string, or null. */
export function frontmatterType(raw: string): string | null {
  const t = parseFrontmatter(raw).meta.type
  return typeof t === 'string' && t.trim() ? t.trim() : null
}
