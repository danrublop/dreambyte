/**
 * Video-edit (video→video / Runway Aleph-class) vocabulary + compiler (Tier 2 #4).
 *
 * One agent- and UI-facing vocabulary for IN-VIDEO editing: take an existing clip and transform it
 * (restyle, relight, add/remove an object, render a new camera angle, replace the background). Like
 * the camera compiler, models accept it differently (capability flag `videoToVideo` on the catalog
 * row): a v2v-capable model gets the edit framed into its prompt and the source clip on its
 * video→video endpoint; a model without the capability is rejected at the startVideo choke point.
 *
 * This module is the prompt compiler: pure + deterministic so it's unit-testable and the cache hash
 * is stable. It mirrors src/lib/media/camera.ts — the operation is a fixed frame, the user's prompt is
 * the instruction slotted into it.
 */

import { modelsForProvider } from './model-catalog'

export type VideoEditOperation =
  | 'restyle' // change the visual style, preserving motion + composition
  | 'relight' // change lighting / time-of-day, keeping subjects + motion
  | 'add-object' // add an element into the scene
  | 'remove-object' // remove an element, filling the space naturally
  | 'new-angle' // re-render the same scene from a different camera angle
  | 'replace-bg' // swap the background / environment, keeping the foreground

export interface VideoEditSpec {
  operation: VideoEditOperation
}

export const VIDEO_EDIT_OPERATIONS: VideoEditOperation[] = [
  'restyle',
  'relight',
  'add-object',
  'remove-object',
  'new-angle',
  'replace-bg',
]

// Each operation frames the user's instruction. `{i}` is the instruction slot; the trailing clause
// pins what must stay constant so the edit reads as an in-place transform, not a fresh generation.
const FRAME: Record<VideoEditOperation, (instruction: string) => string> = {
  restyle: (i) => `Restyle this video as ${i}, preserving the original motion, composition, and timing.`,
  relight: (i) => `Relight this video: ${i}. Keep the subjects, motion, and framing unchanged.`,
  'add-object': (i) => `Add to this video: ${i}, matching the existing lighting, perspective, and motion.`,
  'remove-object': (i) =>
    `Remove from this video: ${i}, filling the revealed space naturally and keeping everything else unchanged.`,
  'new-angle': (i) => `Re-render the same scene and action from a new camera angle: ${i}.`,
  'replace-bg': (i) =>
    `Replace the background/environment of this video with ${i}, keeping the foreground subject and its motion intact.`,
}

// A short default instruction so an operation chosen with an empty prompt still produces a coherent
// edit (the composer's main prompt is normally the instruction, but the agent/MCP can omit it).
const DEFAULT_INSTRUCTION: Record<VideoEditOperation, string> = {
  restyle: 'a bold new visual style',
  relight: 'dramatic cinematic lighting',
  'add-object': 'a fitting new element',
  'remove-object': 'distracting elements',
  'new-angle': 'a different cinematic vantage',
  'replace-bg': 'a new fitting environment',
}

export function isVideoEditOperation(value: unknown): value is VideoEditOperation {
  return typeof value === 'string' && (VIDEO_EDIT_OPERATIONS as string[]).includes(value)
}

/**
 * Compile an edit operation + the user's instruction into the prompt sent to a v2v model. Unlike the
 * camera compiler (which APPENDS a clause), the edit IS the prompt — the operation reframes the whole
 * instruction so Aleph/v2v treats it as an in-place edit. Returns '' for an unknown operation.
 */
export function compileVideoEdit(operation: VideoEditOperation, instruction: string | null | undefined): string {
  if (!isVideoEditOperation(operation)) return ''
  const i = (instruction ?? '').trim() || DEFAULT_INSTRUCTION[operation]
  return FRAME[operation](i)
}

/**
 * Capability-aware edit prompt for a video provider. Returns '' when the provider's catalog row has
 * `videoToVideo: false` (so callers fall back to the plain prompt), otherwise the compiled edit
 * prompt. Shared by startVideo + the agent tool handler so both paths frame the edit identically.
 */
export function editPromptForProvider(
  providerId: string,
  spec: VideoEditSpec | null | undefined,
  instruction: string | null | undefined,
): string {
  if (!spec) return ''
  const capable = modelsForProvider(providerId).find((r) => r.modality === 'video')?.capabilities.videoToVideo ?? false
  return capable ? compileVideoEdit(spec.operation, instruction) : ''
}

/**
 * Resolve the prompt actually sent to a video model. An in-video edit's compiled prompt REPLACES the
 * base (camera direction doesn't apply to footage you're editing in place); otherwise the camera
 * clause is appended to the base. Pure so startVideo's load-bearing prompt choice is unit-testable
 * (a regression that appended instead of replaced, or leaked a camera clause into an edit, is caught).
 */
export function effectiveVideoPrompt(opts: {
  basePrompt: string
  editPrompt?: string
  cameraClause?: string
  /** Cinematic lens/optics clause (focal length, aperture/DoF, lens, film stock). See src/lib/media/optics.ts. */
  opticsClause?: string
  effectClause?: string
}): string {
  // An in-video edit reframes the WHOLE prompt — camera/optics/effect don't apply to footage edited
  // in place — so the edit prompt replaces everything. Otherwise weave base + camera + optics + VFX.
  if (opts.editPrompt) return opts.editPrompt
  return [opts.basePrompt, opts.cameraClause, opts.opticsClause, opts.effectClause].filter(Boolean).join(' ')
}
