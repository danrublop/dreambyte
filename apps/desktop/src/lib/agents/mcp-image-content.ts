/**
 * MCP image content-block extraction.
 *
 * Visual-feedback tools render frames and return them under `result.data`:
 *   - capture_frame: a single frame at `data.image.dataUri`
 *   - review_video:  N frames at `data.images[i].dataUri` (one per scene)
 * as `data:<mime>;base64,...` URIs. An MCP image content block wants the RAW
 * base64 in `data` plus a separate `mimeType`, so each URI must be split.
 *
 * Without this hop the rendered pixels never reach the model: mcp-server would
 * forward only the text caption and the model would stay blind. Kept as a tiny
 * pure module (not inline in scripts/mcp/mcp-server.ts) so it's unit testable —
 * scripts/mcp/mcp-server.ts has top-level transport side effects.
 */

export interface McpImageContent {
  type: 'image'
  /** Raw base64 (no `data:` prefix). */
  data: string
  mimeType: string
}

/** Split one `{ dataUri, mimeType? }` image object into an MCP image block. */
function toImageContent(image: unknown): McpImageContent | null {
  if (!image || typeof image !== 'object') return null
  const { dataUri, mimeType } = image as { dataUri?: unknown; mimeType?: unknown }
  if (typeof dataUri !== 'string') return null
  // data:[<mime>][;base64],<payload> — base64 payload has no commas, so a greedy
  // tail capture is safe. The `s` flag is belt-and-suspenders (base64 is single-line).
  const m = dataUri.match(/^data:([^;,]+)(?:;base64)?,(.+)$/s)
  if (!m || !m[2]) return null
  return { type: 'image', data: m[2], mimeType: typeof mimeType === 'string' ? mimeType : m[1] }
}

/**
 * Pull a single MCP image block out of a tool result's `data.image`, or null.
 * (Kept for the single-frame capture_frame path and its tests.)
 */
export function imageContentFromResultData(data: unknown): McpImageContent | null {
  if (!data || typeof data !== 'object') return null
  return toImageContent((data as { image?: unknown }).image)
}

/**
 * Pull ALL MCP image blocks from a tool result: the single `data.image` and/or
 * the `data.images` array (review_video). Order is preserved (single first, then
 * the array in order). Empty array when there are no images.
 */
export function imageContentsFromResultData(data: unknown): McpImageContent[] {
  if (!data || typeof data !== 'object') return []
  const out: McpImageContent[] = []
  const single = toImageContent((data as { image?: unknown }).image)
  if (single) out.push(single)
  const images = (data as { images?: unknown }).images
  if (Array.isArray(images)) {
    for (const item of images) {
      const c = toImageContent(item)
      if (c) out.push(c)
    }
  }
  return out
}
