/**
 * Design-brief tool handler.
 *
 * `pick_design_system` / `list_design_systems` used to live here. They wrote
 * `globalStyle.designSystemId`, whose only reader (formatDesignSystemForPrompt)
 * had zero callers and whose advertised `%%DESIGN_SYSTEM%%` prompt placeholder
 * never existed — so the tool's headline effect was a phantom and its side
 * effects (palette / font / motionPersonality overrides) duplicate `set_style`.
 * Deleted with `src/lib/design-systems/`.
 */
import type { AgentLogger } from '@/lib/agents/logger'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import { FONT_CATALOG, LEGACY_FONTS } from '@/lib/fonts/catalog'
import { okGlobal, err, type ToolResult } from './_shared'

// Derived from live catalog — stays in sync automatically
const VALID_FONT_FAMILIES = new Set(FONT_CATALOG.map((f) => f.family))
const BANNED_FONT_FAMILIES = LEGACY_FONTS.map((f) => f.family)

export const DESIGN_SYSTEM_TOOL_NAMES = ['design_brief'] as const

export function createDesignToolHandler() {
  return async function handleDesignTools(
    toolName: string,
    args: Record<string, unknown>,
    world: WorldStateMutable,
    _logger?: AgentLogger,
  ): Promise<ToolResult> {
    // Merged tools route to an internal op via a discriminator arg; the rich
    // per-op case bodies below are unchanged. design_brief{action:'read'|'write'}.
    let op = toolName
    if (toolName === 'design_brief') {
      op = (args as { action?: string }).action === 'read' ? 'read_design_brief' : 'create_design_brief'
    }
    switch (op) {
      case 'create_design_brief': {
        const { content } = args as { content: string }
        if (!content || content.trim().length < 100) {
          return err(
            'content must be a complete DESIGN.md (YAML frontmatter + 8 markdown sections). Minimum 100 characters.',
          )
        }

        // Lightweight structural lint — catches the most common agent omissions
        // before the brief gets saved and propagated to every scene turn.
        const REQUIRED_SECTIONS = [
          'Overview',
          'Colors',
          'Typography',
          'Layout',
          'Elevation',
          'Shapes',
          'Components',
          "Do's and Don'ts",
        ]
        const REQUIRED_TOKENS = ['colors:', 'typography:', 'spacing:', 'rounded:']

        const issues: string[] = []
        const trimmed = content.trim()

        for (const section of REQUIRED_SECTIONS) {
          if (!trimmed.includes(`## ${section}`)) {
            issues.push(`Missing section: ## ${section}`)
          }
        }
        for (const token of REQUIRED_TOKENS) {
          if (!trimmed.includes(token)) {
            issues.push(`Missing token category: ${token}`)
          }
        }
        // Flag banned (legacy) fonts used as fontFamily token values
        for (const font of BANNED_FONT_FAMILIES) {
          if (new RegExp(`fontFamily:\\s*["']?${font}["']?`).test(trimmed)) {
            issues.push(
              `Banned font in typography tokens: "${font}" — this font is legacy-only. Choose from the curated catalog.`,
            )
          }
        }
        // Flag font names that aren't in the catalog at all (hallucinated).
        //
        // Two legitimate values must NOT be flagged as "unknown font" — both
        // were false-positives that made every token-driven brief fail on the
        // first try:
        //   1. Design-token REFERENCES — `{typography.label.fontFamily}`. These
        //      point back into the typography token block (whose literal font
        //      names ARE validated by this same loop), so the reference itself
        //      is not a font name. Resolved downstream by the token system.
        //   2. CSS font STACKS — `"Inter, sans-serif"`. Validate the PRIMARY
        //      family only; the fallback ("sans-serif"/"monospace") is a generic
        //      CSS keyword, not a catalog entry.
        const isTokenRef = (v: string) => /^\{[\w.-]+\}$/.test(v)
        const fontFamilyMatches = trimmed.matchAll(/fontFamily:\s*["']?([^"'\n]+)["']?/g)
        for (const match of fontFamilyMatches) {
          const raw = match[1].trim()
          if (isTokenRef(raw)) continue
          const family = raw.split(',')[0].trim().replace(/["']/g, '')
          if (!family) continue
          if (!VALID_FONT_FAMILIES.has(family) && !BANNED_FONT_FAMILIES.includes(family)) {
            issues.push(
              `Unknown font "${family}" — not in the curated catalog. Check spelling or choose a different font.`,
            )
          }
        }
        if (trimmed.includes('#00e5ff') || trimmed.includes('#a855f7')) {
          issues.push('Forbidden color in tokens: neon cyan (#00e5ff) or neon purple (#a855f7) detected')
        }
        if (!trimmed.includes('---')) {
          issues.push('Missing YAML frontmatter delimiters (---)')
        }

        if (issues.length > 0) {
          return err(
            `Design brief has ${issues.length} structural issue(s) — fix and resubmit:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
          )
        }

        // Seed/augment the brief from a just-analyzed reference and
        // persist its salient style tokens as PROJECT-SCOPED memory so future
        // generations match it via the single prompt-injection path.
        //
        // Precedence: the brief content the agent/user wrote is authoritative.
        // We only APPEND a "Reference Match" appendix listing reference tokens
        // the brief doesn't already declare — never overwriting an explicit
        // choice. Memory is written at MODEST confidence so it acts as a
        // silent-user default that an explicit request still wins over.
        // args.referenceTokens is untrusted model output — coerce its shape (a string
        // where an array is expected would otherwise throw in tokensToMemoryRows.join).
        // world.referenceStyleTokens is always well-shaped (from extractStyleTokens).
        const { coerceStyleTokens } = await import('@/lib/agents/services/style-tokens')
        const refTokens =
          coerceStyleTokens((args as { referenceTokens?: unknown }).referenceTokens) ?? world.referenceStyleTokens
        // B1 lifecycle — CONSUME-ONCE: a reference analyzed by analyze_reference_media
        // is stashed on `world.referenceStyleTokens` for the brief/generation that
        // immediately follows. Clear it now that a brief has run so a stale reference
        // can't silently bleed into a LATER unrelated create_design_brief /
        // generate_image_from_reference (the world blob persists across MCP calls, so
        // without this it would leak indefinitely). Cleared unconditionally — once a
        // brief is created, the analyzed reference is spent.
        world.referenceStyleTokens = undefined
        let finalBrief = trimmed
        let referenceApplied = false
        let memoryKeysWritten: string[] = []

        if (refTokens) {
          const { hasStyleSignal, tokensToMemoryRows } = await import('@/lib/agents/services/style-tokens')
          if (hasStyleSignal(refTokens)) {
            // Append only the tokens not already present in the brief text — the
            // brief's explicit values win (no override of a user/agent choice).
            const { hexPresentIn, isHex, phraseMatches } = await import('@/lib/agents/services/style-tokens')
            const lowerBrief = trimmed.toLowerCase()
            const appendixLines: string[] = []
            // A fragment counts as "present" only on a precise match: hex colors
            // compare canonically (`#fff` == `#ffffff`, no false substring hit),
            // and descriptor phrases match on a word boundary (`soft light` is NOT
            // satisfied by `soft lightbox`).
            const fragmentPresent = (f: string): boolean =>
              isHex(f) ? hexPresentIn(lowerBrief, f) : phraseMatches(lowerBrief, f)
            const noteIfAbsent = (label: string, value?: string | string[]) => {
              if (!value) return
              const str = Array.isArray(value) ? value.join(', ') : value
              if (!str.trim()) return
              // Skip when every fragment is already in the brief.
              const fragments = Array.isArray(value) ? value : [value]
              const allPresent = fragments.every(fragmentPresent)
              if (allPresent) return
              appendixLines.push(`- ${label}: ${str}`)
            }
            noteIfAbsent('Palette', refTokens.palette)
            noteIfAbsent('Typography', refTokens.fonts)
            noteIfAbsent('Mood', refTokens.mood)
            noteIfAbsent('Lighting', refTokens.lighting)
            noteIfAbsent('Composition', refTokens.composition)

            if (appendixLines.length > 0) {
              finalBrief =
                `${trimmed}\n\n## Reference Match\n` +
                `Derived from the user's attached reference media. Use these as defaults where this brief above does not already specify a value; the brief's explicit tokens take precedence.\n` +
                appendixLines.join('\n')
              referenceApplied = true
            }

            // Persist salient reference tokens as project-scoped memory (modest
            // confidence). Best-effort: a DB failure must not fail the brief.
            const userId = world.authUserId
            const projectId = world.projectId
            if (userId && projectId) {
              try {
                const { upsertMemory } = await import('@/lib/db/queries/user-memory')
                const rows = tokensToMemoryRows(refTokens)
                for (const r of rows) {
                  await upsertMemory(
                    userId,
                    r.category,
                    r.key,
                    r.value,
                    0.45, // modest — a silent-user default, below explicit signal
                    world.currentRunId ?? undefined,
                    projectId,
                  )
                }
                memoryKeysWritten = rows.map((r) => r.key)
              } catch (e) {
                _logger?.warn?.('tool', `create_design_brief: reference-token memory persist failed: ${String(e)}`)
              }
            }
          }
        }

        world.globalStyle.designBrief = finalBrief
        return okGlobal('Design brief saved. All subsequent scene generation will use these exact tokens.', {
          length: finalBrief.length,
          preview: finalBrief.slice(0, 300) + (finalBrief.length > 300 ? '...' : ''),
          referenceApplied,
          memoryKeysWritten,
        })
      }

      case 'read_design_brief': {
        const brief = world.globalStyle.designBrief
        if (!brief) {
          return err('No design brief set for this project. Call create_design_brief first.')
        }
        return okGlobal('Design brief retrieved', { content: brief, length: brief.length })
      }

      default:
        return err(`Unknown design tool: ${toolName}`)
    }
  }
}
