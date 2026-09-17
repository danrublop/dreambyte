// Motion DSL — public API of `@dreambyte/motion-dsl` (packages/motion-dsl
// copies src/lib/motion-dsl via its scripts/sync-from-source.mjs).
// Keep the surface small and stable; the React compiler lives in
// `./compiler/react.ts` and is imported separately.

export * from './types'
export * from './springs'
export { MOTION_PRESETS, MOTION_PRESET_IDS, getMotionPreset, listMotionPresets } from './presets.generated'
export { suggestPresetId, validateMotionRef } from './validate'
