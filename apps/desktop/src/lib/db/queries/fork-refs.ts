/**
 * Asset-reference rewriting for "fork branch to a separate project".
 *
 * A forked project gets its own copy of every asset (new asset ids, new files
 * under its own project dir). The scenes carried into the fork still point at
 * the SOURCE project's asset ids and URLs, in several shapes:
 *   - full publicUrls embedded in sceneBlob / video_layer / audio_layer
 *     (e.g. "/uploads/projects/<srcProjectId>/<oldAssetId>_clip.mp4")
 *   - bare asset ids (AssetPlacement.assetId, watermark.assetId, brandKit
 *     logoAssetIds)
 *   - any remaining "/projects/<srcProjectId>/..." path (thumbnails, dreambyte://)
 *
 * This rewrites all three over an arbitrary JSON value. It works on the
 * serialized form so it doesn't need to know every field name. Ordering matters: swap full URLs first
 * (they embed both the project id and the asset id), then the generic project
 * path, then bare asset ids last.
 */
export interface ForkRefRewrite {
  srcProjectId: string
  dstProjectId: string
  /** old assetId → new assetId */
  assetIdMap: Map<string, string>
  /** old publicUrl → new publicUrl */
  urlMap: Map<string, string>
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack
  return haystack.split(needle).join(replacement)
}

/**
 * Apply the fork's three-stage reference rewrite to an arbitrary string. Used on
 * both the JSON-serialized sceneBlob/layer columns and on raw scene HTML files
 * (which embed the same asset URLs / project paths / asset ids), so a forked
 * scene's HTML points at the fork's own assets — making the fork standalone even
 * after the source project is deleted. Ordering matters (see numbered steps).
 */
export function rewriteAssetRefsInString(input: string, r: ForkRefRewrite): string {
  let out = input

  // 1. Exact publicUrl swaps, longest-first so a short URL that is a prefix of a
  //    longer one can't partially clobber it.
  const urlPairs = [...r.urlMap.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [oldUrl, newUrl] of urlPairs) out = replaceAll(out, oldUrl, newUrl)

  // 2. Any remaining reference to the source project's asset dir (thumbnails,
  //    dreambyte:// URLs, paths not in urlMap). The asset-id portion of the filename
  //    is fixed up by step 3.
  out = replaceAll(out, `/projects/${r.srcProjectId}/`, `/projects/${r.dstProjectId}/`)

  // 3. Bare asset id references. UUIDs, so substring collisions across distinct
  //    ids don't happen in practice.
  for (const [oldId, newId] of r.assetIdMap) out = replaceAll(out, oldId, newId)

  return out
}

export function rewriteAssetRefs<T>(value: T, r: ForkRefRewrite): T {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return value
  }
  if (json === undefined) return value

  json = rewriteAssetRefsInString(json, r)

  try {
    return JSON.parse(json) as T
  } catch {
    return value
  }
}
