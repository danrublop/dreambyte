// Throwaway browser-side entry for the real-pixel parity harness
// (scripts/smoke/composite-parity-pixel-smoke.mjs). Bundled by esbuild as an IIFE so the
// REAL preview media executor runs inside the preview BrowserWindow — the harness
// compares the export host's pixels against THIS, the production preview path, so
// the comparison catches executor drift instead of testing a reimplementation.
//
//   esbuild scripts/smoke/_parity-preview-deps.ts --bundle --format=iife \
//     --platform=browser --tsconfig=tsconfig.json --outfile=/tmp/parity-preview.js
//
// Dev-only; not imported by the app.
import { PreviewMediaPool } from '../../src/lib/compositor/preview-media-pool'
import { compositeLayerToElementStyle } from '../../src/lib/timeline/composite-frame'

;(globalThis as any).__parityDeps = { PreviewMediaPool, compositeLayerToElementStyle }
