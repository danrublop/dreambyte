// Re-export entry so the parity pixel smoke can require the REAL composite
// logic (bundled via esbuild --tsconfig so the @/ alias resolves). Dev-only; not
// imported by the app. See scripts/run-parity-pixel-smoke.sh.
export { planCompositeFrame } from '../../src/lib/timeline/composite-frame'
export { buildCompositeHostHtml, planToInstructions } from '../../src/electron/ipc/composite-host'
