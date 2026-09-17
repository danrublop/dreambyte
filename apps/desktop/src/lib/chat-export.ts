/**
 * Conversation → Markdown export.
 *
 * Pure, framework-free serializer so it is trivially unit-testable and shared
 * by both the in-memory chat path (ChatMessage) and the DB-loaded path
 * (StoredMessage, whose `content` is always a string and whose tool calls
 * arrive as opaque JSON). The component wires the download; this module only
 * turns a (title, messages) pair into a Markdown string.
 *
 * Format:
 *   - `# <title>` header.
 *   - One `## <Role>` section per message (User / Assistant).
 *   - Text content verbatim. Image blocks render as `![attachment]` placeholders.
 *   - Tool calls collapse to one line each: `- 🔧 toolName(arg summary)`.
 *   - A per-message footer (`_model · $cost_`) when either is present.
 *   - A total-cost line at the end when any message carried a cost.
 */

/** A text/image block — structurally compatible with agents/types `ContentBlock`. */
export type ExportContentBlock = { type: 'text'; text: string } | { type: 'image'; [k: string]: unknown }

/** Message content: a plain string, or an array of blocks (text + images). */
export type ExportMessageContent = string | ExportContentBlock[]

/** A single tool call — only the fields we render. Tolerant of DB JSON shape. */
export interface ExportToolCall {
  toolName?: string
  /** ChatMessage shape uses `input`; be liberal in what we accept. */
  input?: Record<string, unknown> | null
  [k: string]: unknown
}

/** The minimal message shape this serializer needs. Both ChatMessage and the
 *  DB StoredMessage row satisfy it (after the caller normalizes field names). */
export interface ExportMessage {
  role: 'user' | 'assistant'
  content: ExportMessageContent
  toolCalls?: ExportToolCall[] | null
  modelId?: string | null
  costUsd?: number | null
}

export interface ExportConversation {
  title?: string | null
  messages: ExportMessage[]
}

/** Max characters of an args summary rendered inline for a tool call. */
const ARG_SUMMARY_MAX = 80

/** Render the `content` of one message: text verbatim, images as placeholders. */
function renderContent(content: ExportMessageContent): string {
  if (typeof content === 'string') return content.trim()
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      const t = (block.text ?? '').trim()
      if (t) parts.push(t)
    } else if (block.type === 'image') {
      parts.push('![attachment]')
    }
  }
  return parts.join('\n\n')
}

/** Summarize a tool call's args to a single compact line. */
function summarizeArgs(input: Record<string, unknown> | null | undefined): string {
  if (!input || typeof input !== 'object') return ''
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const pairs = keys.map((k) => {
    const v = (input as Record<string, unknown>)[k]
    let s: string
    if (typeof v === 'string') s = v
    else if (v === null || v === undefined) s = String(v)
    else if (typeof v === 'object') {
      try {
        s = JSON.stringify(v)
      } catch {
        s = '[unserializable]'
      }
    } else s = String(v)
    // Collapse whitespace so the summary stays on one line.
    s = s.replace(/\s+/g, ' ').trim()
    return `${k}: ${s}`
  })
  let summary = pairs.join(', ')
  if (summary.length > ARG_SUMMARY_MAX) {
    summary = summary.slice(0, ARG_SUMMARY_MAX - 1).trimEnd() + '…'
  }
  return summary
}

/** Render one tool call as a single collapsed line. */
function renderToolCall(call: ExportToolCall): string {
  const name = (call.toolName ?? 'tool').trim() || 'tool'
  const args = summarizeArgs(call.input)
  return `- 🔧 ${name}(${args})`
}

const ROLE_LABEL: Record<ExportMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
}

/**
 * Serialize a conversation to Markdown. Deterministic; never throws on a
 * well-formed message array (best-effort on odd JSON via the summarizer).
 */
export function serializeConversationToMarkdown(conversation: ExportConversation): string {
  const title = (conversation.title ?? '').trim() || 'Conversation'
  const lines: string[] = [`# ${title}`, '']

  let totalCost = 0
  let sawCost = false

  for (const msg of conversation.messages) {
    lines.push(`## ${ROLE_LABEL[msg.role] ?? msg.role}`, '')

    const body = renderContent(msg.content)
    if (body) {
      lines.push(body, '')
    }

    const calls = msg.toolCalls ?? []
    if (calls.length > 0) {
      for (const call of calls) lines.push(renderToolCall(call))
      lines.push('')
    }

    const footerParts: string[] = []
    if (msg.modelId) footerParts.push(String(msg.modelId))
    if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
      footerParts.push(`$${msg.costUsd.toFixed(4)}`)
    }
    if (typeof msg.costUsd === 'number') {
      totalCost += msg.costUsd
      if (msg.costUsd > 0) sawCost = true
    }
    if (footerParts.length > 0) {
      lines.push(`_${footerParts.join(' · ')}_`, '')
    }
  }

  if (sawCost) {
    lines.push('---', '', `**Total cost:** $${totalCost.toFixed(4)}`, '')
  }

  // Single trailing newline.
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/** Build a filesystem-safe slug from a conversation title. */
export function slugifyTitle(title: string | null | undefined): string {
  const base = (title ?? '').trim().toLowerCase()
  const slug = base
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'conversation'
}

/** `<slug>-YYYY-MM-DD.md` filename for the exported transcript. */
export function exportFilename(title: string | null | undefined, date: Date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${slugifyTitle(title)}-${yyyy}-${mm}-${dd}.md`
}
