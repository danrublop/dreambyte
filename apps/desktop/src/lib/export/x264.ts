/**
 * Shared x264 quality tuning for every final-pass export encode.
 *
 * Single source of truth for the param string used by:
 *   - src/electron/ipc/export-tier3.ts (per-scene crf14 deliverable encode)
 *   - src/electron/ipc/caption-burn.ts (caption burn-in re-encode)
 *   - packages/render-server/stitcher.js   (cuts re-encode + xfade passes — plain JS in
 *     a separate package, so it carries its own copy; x264.test.ts asserts the
 *     copies stay byte-identical so they can't silently drift)
 *
 * aq-mode=3 (auto-variance AQ w/ bias to dark scenes), psy-rd tuned for
 * synthetic/graphics content, light deblock, exhaustive subme/trellis/ref —
 * keeps text edges crisp, which matters double for burned-in captions.
 */
export const X264_QUALITY_PARAMS = 'aq-mode=3:psy-rd=1.0,0.15:deblock=-1,-1:subme=10:trellis=2:ref=5'
