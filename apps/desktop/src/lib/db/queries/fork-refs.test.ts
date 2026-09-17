// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { rewriteAssetRefs, type ForkRefRewrite } from './fork-refs'

const SRC = '11111111-1111-1111-1111-111111111111'
const DST = '22222222-2222-2222-2222-222222222222'
const OLD_ASSET = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const NEW_ASSET = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function rewrite(): ForkRefRewrite {
  return {
    srcProjectId: SRC,
    dstProjectId: DST,
    assetIdMap: new Map([[OLD_ASSET, NEW_ASSET]]),
    urlMap: new Map([
      [`/uploads/projects/${SRC}/${OLD_ASSET}_clip.mp4`, `/uploads/projects/${DST}/${NEW_ASSET}_clip.mp4`],
    ]),
  }
}

describe('rewriteAssetRefs', () => {
  it('rewrites a full publicUrl embedded in a video layer', () => {
    const scene = { videoLayer: { src: `/uploads/projects/${SRC}/${OLD_ASSET}_clip.mp4`, opacity: 1 } }
    const out = rewriteAssetRefs(scene, rewrite())
    expect(out.videoLayer.src).toBe(`/uploads/projects/${DST}/${NEW_ASSET}_clip.mp4`)
  })

  it('rewrites a bare assetId reference (AssetPlacement / watermark)', () => {
    const blob = { watermark: { assetId: OLD_ASSET }, placements: [{ assetId: OLD_ASSET, x: 0 }] }
    const out = rewriteAssetRefs(blob, rewrite())
    expect(out.watermark.assetId).toBe(NEW_ASSET)
    expect(out.placements[0].assetId).toBe(NEW_ASSET)
  })

  it('rewrites a thumbnail path not in the url map via the project-dir swap', () => {
    const blob = { thumb: `/uploads/projects/${SRC}/${OLD_ASSET}_thumb.jpg` }
    const out = rewriteAssetRefs(blob, rewrite())
    // project dir swapped, then the asset-id portion of the filename fixed up
    expect(out.thumb).toBe(`/uploads/projects/${DST}/${NEW_ASSET}_thumb.jpg`)
  })

  it('rewrites cench:// packaged URLs too', () => {
    const blob = { src: `cench://uploads/projects/${SRC}/${OLD_ASSET}_clip.mp4` }
    const out = rewriteAssetRefs(blob, rewrite())
    expect(out.src).toBe(`cench://uploads/projects/${DST}/${NEW_ASSET}_clip.mp4`)
  })

  it('leaves unrelated content untouched', () => {
    const blob = { title: 'hello', reactCode: 'export default () => null', n: 42 }
    const out = rewriteAssetRefs(blob, rewrite())
    expect(out).toEqual(blob)
  })

  it('handles brandKit logoAssetIds arrays', () => {
    const blob = { brandKit: { logoAssetIds: [OLD_ASSET, 'cccccccc-cccc-cccc-cccc-cccccccccccc'] } }
    const out = rewriteAssetRefs(blob, rewrite())
    expect(out.brandKit.logoAssetIds[0]).toBe(NEW_ASSET)
    // an asset not in the map is left as-is
    expect(out.brandKit.logoAssetIds[1]).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')
  })
})
