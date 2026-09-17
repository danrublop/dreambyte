import React from 'react'

// ── Lightweight inline markdown renderer ────────────────────────────────────
// Shared by the agent transcript (completed messages) and the live
// StreamingMessage leaf. Handles **bold**, *italic*, and `code` inline spans
// plus hard line breaks. Intentionally tiny — no block-level parsing.

export function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const result: React.ReactNode[] = []

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) result.push(<br key={`br-${i}`} />)
    const parts = parseInline(lines[i], i)
    result.push(...parts)
  }
  return result
}

function parseInline(text: string, lineIdx: number): React.ReactNode[] {
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g
  const nodes: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let k = 0

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }
    if (match[2] != null) {
      nodes.push(<strong key={`${lineIdx}-b-${k++}`}>{match[2]}</strong>)
    } else if (match[3] != null) {
      nodes.push(<em key={`${lineIdx}-i-${k++}`}>{match[3]}</em>)
    } else if (match[4] != null) {
      nodes.push(
        <code key={`${lineIdx}-c-${k++}`} className="px-1 py-0.5 rounded text-[12px] bg-[var(--color-panel)] font-mono">
          {match[4]}
        </code>,
      )
    }
    last = match.index + match[0].length
  }

  if (last < text.length) {
    nodes.push(text.slice(last))
  }
  return nodes
}
