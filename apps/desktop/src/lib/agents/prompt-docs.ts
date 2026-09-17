import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'

export type AgentPromptDocId = 'router' | 'system'

export interface AgentPromptDocMeta {
  id: AgentPromptDocId
  title: string
  relativePath: string
  hash: string | null
  chars: number
  loaded: boolean
  truncated: boolean
  error?: string
}

export interface LoadedAgentPromptDocs {
  block: string
  docs: AgentPromptDocMeta[]
}

interface PromptDocSpec {
  id: AgentPromptDocId
  title: string
  relativePath: string
}

export interface LoadAgentPromptDocsOptions {
  rootDir?: string
  maxCharsPerDoc?: number
  /**
   * Restrict to these doc ids (default: all). Sub-agents pass `['system']` so the
   * parent-facing ROUTER (which routes requests + describes delegation) doesn't
   * reach scene-builders that can't route or delegate.
   */
  includeIds?: AgentPromptDocId[]
}

export const DEFAULT_PROMPT_DOC_MAX_CHARS = 8000

// NOTE: design knowledge is intentionally NOT injected here — the docs are
// strictly technical and the model owns aesthetic decisions (see getAgentPrompt
// in prompts.ts).
const PROMPT_DOCS: PromptDocSpec[] = [
  // Router FIRST — the Tier-0 "read this, route the request, spend effort in
  // proportion" layer. It routes; SYSTEM.md is the
  // operating contract. Both are in the CACHED static prompt.
  {
    id: 'router',
    title: 'Agent Router',
    relativePath: 'docs/agent/ROUTER.md',
  },
  {
    id: 'system',
    title: 'Agent Operating Contract',
    relativePath: 'docs/agent/SYSTEM.md',
  },
]

/**
 * Resolve a prompt-doc's absolute path across dev + packaged, mirroring
 * load-rule-packs' resolveRulesDir. In the packaged app electron-builder maps
 * `docs/agent` → `Resources/docs-agent` (extraResources), so a bare cwd read
 * would silently miss in production and the agent would run without its router /
 * operating contract. First existing wins. An explicit rootDir (tests) skips the
 * resourcesPath candidate so fixtures resolve exactly against the temp tree.
 */
function resolveDocPath(relativePath: string, rootDir: string, isDefault: boolean): string {
  const cwdPath = path.join(rootDir, relativePath)
  if (!isDefault) return cwdPath
  const base = path.basename(relativePath) // e.g. SYSTEM.md
  const candidates = [
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'docs-agent', base) : undefined,
    cwdPath,
  ].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return cwdPath
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false }
  return {
    content: `${content.slice(0, Math.max(0, maxChars - 64)).trimEnd()}\n\n[Prompt doc truncated by loader]`,
    truncated: true,
  }
}

let _defaultCache: LoadedAgentPromptDocs | null = null

export function loadAgentPromptDocs(options: LoadAgentPromptDocsOptions = {}): LoadedAgentPromptDocs {
  const isDefaultOptions = !options.rootDir && !options.maxCharsPerDoc && !options.includeIds
  if (isDefaultOptions && _defaultCache) return _defaultCache

  const rootDir = options.rootDir ?? process.cwd()
  const maxCharsPerDoc = options.maxCharsPerDoc ?? DEFAULT_PROMPT_DOC_MAX_CHARS
  const specs = options.includeIds ? PROMPT_DOCS.filter((s) => options.includeIds!.includes(s.id)) : PROMPT_DOCS
  const blocks: string[] = []
  const docs: AgentPromptDocMeta[] = []

  for (const spec of specs) {
    const absolutePath = resolveDocPath(spec.relativePath, rootDir, isDefaultOptions)

    if (!existsSync(absolutePath)) {
      docs.push({
        id: spec.id,
        title: spec.title,
        relativePath: spec.relativePath,
        hash: null,
        chars: 0,
        loaded: false,
        truncated: false,
        error: 'missing',
      })
      continue
    }

    try {
      const raw = readFileSync(absolutePath, 'utf8').trim()
      const truncated = truncateContent(raw, maxCharsPerDoc)
      const hash = hashContent(raw)
      docs.push({
        id: spec.id,
        title: spec.title,
        relativePath: spec.relativePath,
        hash,
        chars: raw.length,
        loaded: true,
        truncated: truncated.truncated,
      })
      blocks.push(
        `## ${spec.title}\nSource: ${spec.relativePath} | hash: ${hash}${truncated.truncated ? ' | truncated' : ''}\n\n${truncated.content}`,
      )
    } catch (err) {
      docs.push({
        id: spec.id,
        title: spec.title,
        relativePath: spec.relativePath,
        hash: null,
        chars: 0,
        loaded: false,
        truncated: false,
        error: err instanceof Error ? err.message : 'read_failed',
      })
    }
  }

  const result: LoadedAgentPromptDocs = {
    block: blocks.length > 0 ? `# Dreambyte Agent Contracts\n\n${blocks.join('\n\n')}` : '',
    docs,
  }
  if (isDefaultOptions) _defaultCache = result
  return result
}
