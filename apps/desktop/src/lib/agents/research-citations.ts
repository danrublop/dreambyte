/**
 * Native-search citation adapters. Each provider (Anthropic web_search_tool_result,
 * OpenAI url_citation annotations, Gemini groundingMetadata) returns citations in
 * a different shape — these helpers normalise them to the shared `ResearchSource`
 * interface so the SSE stream and UI handle a single shape.
 */

import type { ResearchSource } from './types'

/** Anthropic `web_search_tool_result` content entries → ResearchSource[]. */
export function adaptAnthropicCitations(
  content: Array<{ type?: string; title?: string; url?: string; encrypted_content?: string }> | undefined,
  toolUseId?: string,
): ResearchSource[] {
  if (!Array.isArray(content)) return []
  const out: ResearchSource[] = []
  for (const c of content) {
    if (!c?.url) continue
    out.push({ url: c.url, title: c.title, provider: 'anthropic', toolUseId })
  }
  return out
}

/** OpenAI `url_citation` annotations (Responses API or Chat Completions) → ResearchSource[]. */
export function adaptOpenAICitations(
  annotations:
    | Array<{
        type?: string
        url?: string
        title?: string
        quote?: string
        url_citation?: { url?: string; title?: string; quote?: string }
      }>
    | undefined,
): ResearchSource[] {
  if (!Array.isArray(annotations)) return []
  const out: ResearchSource[] = []
  for (const a of annotations) {
    if (a?.type !== 'url_citation') continue
    const url = a.url ?? a.url_citation?.url
    if (!url) continue
    const title = a.title ?? a.url_citation?.title
    const snippet = a.quote ?? a.url_citation?.quote
    out.push({ url, title, snippet, provider: 'openai' })
  }
  return out
}

/** Gemini `groundingMetadata.groundingChunks` → ResearchSource[]. */
export function adaptGeminiCitations(
  metadata:
    | {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
      }
    | undefined,
): ResearchSource[] {
  const chunks = metadata?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const out: ResearchSource[] = []
  for (const c of chunks) {
    const url = c?.web?.uri
    if (!url) continue
    out.push({ url, title: c.web?.title, provider: 'google' })
  }
  return out
}

/** Dedupe by URL, preserving order of first occurrence. */
export function dedupeSources(items: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>()
  const out: ResearchSource[] = []
  for (const s of items) {
    if (!s?.url || seen.has(s.url)) continue
    seen.add(s.url)
    out.push(s)
  }
  return out
}
