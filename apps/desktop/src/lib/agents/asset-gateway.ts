import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import type { WorldStateMutable } from './world-state'
import { persistGeneratedAsset } from '@/lib/media/provenance'
import { getGeneratedDir } from '@/lib/media-paths'

/**
 * Sandbox asset gateway.
 *
 * In Sandbox run mode the agent must still produce a REAL, usable asset so the
 * timeline / scene HTML / export pipeline keeps working — but WITHOUT calling
 * any paid provider. `resolveAsset` is the single switch: in Sandbox it runs the
 * local/placeholder producer; otherwise it runs the real provider call. The
 * `real` thunk holds the exact pre-existing logic, so the non-Sandbox path is
 * behaviour-preserving.
 *
 * Two substitution shapes:
 *  - Narration/TTS has a genuine free-local provider (`native-tts`), so Sandbox
 *    swaps the provider rather than faking audio — see the audio tool handler.
 *  - Image/video/avatar have no reliable free-local generator, so Sandbox emits
 *    a labelled placeholder, tagged with SANDBOX_ASSET_TAG so it can never be
 *    mistaken for (or shipped as) a real generation.
 *
 * Fail-closed pairing: `checkApiPermission` (tool-executor) errors any paid API
 * reached while `world.sandboxMode` is set. So a handler that forgets to route a
 * paid call through this gateway breaks loudly instead of spending. resolveAsset
 * is what keeps the call off that error path in the happy case.
 */
export async function resolveAsset<T>(
  world: Pick<WorldStateMutable, 'sandboxMode'>,
  producers: { real: () => Promise<T>; sandbox: () => Promise<T> },
): Promise<T> {
  return world.sandboxMode ? producers.sandbox() : producers.real()
}

/** Tag stamped on every Sandbox-produced asset. Lets the library/UX flag a
 *  placeholder and prevents it from being treated as a real, paid generation. */
export const SANDBOX_ASSET_TAG = 'sandbox-placeholder'

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
}

/**
 * Placeholder image card (prompt text + dimensions) written to a Sandbox-only
 * public path. Returns the SAME shape as `generateImage` so the handler's
 * persist + layer-insertion runs unchanged. Deliberately NOT written through
 * `saveToCache` — that media cache is keyed by prompt params, so a placeholder
 * there would be returned as a cache hit for a later REAL generate_image with
 * the same prompt (cache poisoning).
 */
export async function sandboxImageAsset(opts: {
  prompt: string
  width?: number
  height?: number
}): Promise<{ imageUrl: string; width: number; height: number; cost: number }> {
  // Clamp dims to a sane finite range — they flow into the SVG and later into
  // sharp() for thumbnailing, so NaN/negative/huge values would be a local
  // CPU/memory failure path (Codex review). Non-finite falls back to 1024.
  const clampDim = (v: number | undefined): number =>
    Number.isFinite(v) ? Math.min(8192, Math.max(16, Math.round(v as number))) : 1024
  const width = clampDim(opts.width)
  const height = clampDim(opts.height)
  const label = escapeXml((opts.prompt ?? 'placeholder').slice(0, 80))
  const titleSize = Math.round(Math.min(width, height) / 14)
  const labelSize = Math.round(Math.min(width, height) / 26)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#1f2430"/>
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#fbbf24" stroke-width="4" stroke-dasharray="16 12"/>
  <text x="50%" y="46%" fill="#fbbf24" font-family="sans-serif" font-size="${titleSize}" font-weight="700" text-anchor="middle">Sandbox placeholder</text>
  <text x="50%" y="56%" fill="#cbd5e1" font-family="sans-serif" font-size="${labelSize}" text-anchor="middle">${label}</text>
</svg>`
  // Env-aware generated mount: the
  // old cwd()/public join EROFS'd in packaged builds whenever Sandbox mode ran.
  const dir = path.join(getGeneratedDir(), 'sandbox')
  await fs.mkdir(dir, { recursive: true })
  const filename = `${randomUUID()}.svg`
  await fs.writeFile(path.join(dir, filename), svg, 'utf8')
  return { imageUrl: `/generated/sandbox/${filename}`, width, height, cost: 0 }
}

/** Diffusion-style modifiers that are noise for a keyword stock search. */
const DIFFUSION_NOISE =
  /\b(photo-?realistic|photoreal|hyper-?realistic|cinematic|hyper-?detailed|highly detailed|ultra-?detailed|8k|4k|hdr|ultra-?wide|bokeh|dramatic lighting|studio lighting|volumetric|depth of field|render(?:ing|ed)?|octane|unreal engine|concept art|masterpiece|trending on artstation|award-?winning|professional photography|shot on|film grain|golden hour|wide angle|close-?up|portrait of|an image of|a photo of)\b/gi

/** Reduce a rich diffusion prompt to a few concrete keywords for stock search. */
export function stockQueryFromPrompt(prompt: string): string {
  const cleaned = (prompt ?? '')
    .replace(DIFFUSION_NOISE, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.split(' ').slice(0, 6).join(' ') || 'abstract background'
}

/**
 * Sandbox image via FREE stock (Wikimedia Commons — no key, no auth, $0) instead
 * of a placeholder card, so the sandbox preview looks like a real video (assets
 * present, just not perfectly matched). The generation PROMPT is still captured
 * separately (sandbox-capture → transcript.md), so prompt-review is unaffected.
 * Any failure (no result, network, bad bytes) falls back to the labelled
 * placeholder card — the preview never breaks. Same return shape as
 * sandboxImageAsset so the handler's persist + layer insertion runs unchanged.
 */
export async function sandboxStockImageAsset(opts: {
  prompt: string
  width?: number
  height?: number
}): Promise<{ imageUrl: string; width: number; height: number; cost: number }> {
  try {
    const query = stockQueryFromPrompt(opts.prompt)
    const { wikimediaCommonsSearch } = await import('@/lib/research/providers/wikimedia-commons')
    const res = await wikimediaCommonsSearch({ query, mediaType: 'image', count: 6 })
    const hit = res.results.find((r) => r.mediaType === 'image' && (r.thumbnailUrl || r.mediaUrl))
    const src = hit?.thumbnailUrl || hit?.mediaUrl
    if (!src) return sandboxImageAsset(opts)

    const resp = await fetch(src, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'DreambyteBot/1.0 (+https://github.com/danrublop/dreambyte)' },
    })
    if (!resp.ok) return sandboxImageAsset(opts)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) return sandboxImageAsset(opts)

    const ext = (src.match(/\.(jpe?g|png|gif|webp)(?:$|\?)/i)?.[1] ?? 'jpg').toLowerCase()
    const dir = path.join(getGeneratedDir(), 'sandbox')
    await fs.mkdir(dir, { recursive: true })
    const filename = `${randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`
    await fs.writeFile(path.join(dir, filename), buf)
    return {
      imageUrl: `/generated/sandbox/${filename}`,
      width: hit?.width ?? opts.width ?? 1024,
      height: hit?.height ?? opts.height ?? 1024,
      cost: 0,
    }
  } catch {
    // Any failure → placeholder card. Sandbox preview must never break.
    return sandboxImageAsset(opts)
  }
}

/**
 * Persist a sandbox placeholder into the project's media library so it gets a
 * `/uploads/...` URL. CRITICAL for visibility: the MP4 export render only serves
 * `/uploads/` + `/audio/` (per sceneTemplate's <base>), NOT `/generated/sandbox/`,
 * so a layer pointing at the raw sandbox path 404s (net::ERR_FILE_NOT_FOUND) and
 * the placeholder never appears in the exported video. Image/video paths already
 * persist; this gives the avatar path the same. persistGeneratedAsset also
 * deletes the /generated/sandbox source after copying (no orphan). Falls back to
 * the raw URL if there's no projectId or persistence fails (best-effort).
 */
export async function persistSandboxImage(
  projectId: string | undefined,
  ph: { imageUrl: string; width: number; height: number },
  label: string,
): Promise<string> {
  if (!projectId) return ph.imageUrl
  try {
    const persisted = await persistGeneratedAsset({
      projectId,
      sourceUrl: ph.imageUrl,
      type: 'image',
      width: ph.width,
      height: ph.height,
      tags: [SANDBOX_ASSET_TAG],
      metadata: {
        prompt: label,
        provider: 'sandbox',
        model: 'sandbox',
        costCents: 0,
        parentAssetId: null,
        referenceAssetIds: null,
        enhanceTags: [SANDBOX_ASSET_TAG],
      },
    })
    return persisted.publicUrl
  } catch {
    return ph.imageUrl
  }
}
