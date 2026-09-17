/**
 * Document intake engine.
 *   - `local:pdfjs` → pdf.js text extraction for PDFs (Apache-2.0, pure JS).
 *     Plain `.txt`/`.md` are read directly. Structured layout (Docling) is the
 *     premium tier, not wired.
 *
 * pdf.js is imported dynamically so the bundle/tests work even before
 * `pdfjs-dist` is installed; a missing dep degrades to `{ error }`.
 */

import type { MediaAnalysis, ReferenceMedia } from '../../types'
import { resolveMedia } from './media-source'

/** Hard cap on extracted text fed downstream — briefs don't need whole books. */
const MAX_DOC_CHARS = 12_000

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Legacy build runs under Node without a DOM worker.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfDoc> }
  }
  interface PdfDoc {
    numPages: number
    getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>
  }
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const out: string[] = []
  let total = 0
  // Cap pages scanned so a giant/malicious PDF can't blow memory or time, and
  // track length with a running counter (not a re-join per page → no O(n^2)).
  const maxPages = Math.min(doc.numPages, 200)
  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const pageText = content.items.map((it) => it.str ?? '').join(' ')
    out.push(pageText)
    total += pageText.length + 1
    if (total > MAX_DOC_CHARS) break
  }
  return out.join('\n').slice(0, MAX_DOC_CHARS).trim()
}

export async function analyzeDoc(media: ReferenceMedia, engineId: string): Promise<MediaAnalysis> {
  try {
    const { bytes, mimeType, localPath } = await resolveMedia(media.uri, media.mimeType)
    const isPdf = mimeType === 'application/pdf' || localPath.toLowerCase().endsWith('.pdf')

    let docText: string
    if (isPdf) {
      docText = await extractPdfText(bytes)
    } else {
      docText = Buffer.from(bytes).toString('utf8').slice(0, MAX_DOC_CHARS).trim()
    }

    if (!docText) {
      return { mediaId: media.id, kind: 'doc', backend: engineId, error: 'no extractable text' }
    }
    return { mediaId: media.id, kind: 'doc', backend: engineId, ocrText: docText }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = /Cannot find module|pdfjs-dist/.test(msg) ? ' (install pdfjs-dist to enable PDF intake)' : ''
    return { mediaId: media.id, kind: 'doc', backend: engineId, error: msg + hint }
  }
}
