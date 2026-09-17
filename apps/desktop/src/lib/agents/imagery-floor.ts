import type { Scene } from '../types/scene'
import type { SceneSpec } from './types'

/**
 * Run-level imagery floor — the honest net for "the plan wanted pictures but the
 * video shipped as CSS only". DELIBERATELY narrow (plan L6 / D-arch-2): fires ONLY
 * on the deterministic keys-absent slice —
 *   the plan called for media (a scene's `mediaLayers` note is non-empty)
 *   AND no AI image-generation provider was configured (`hasImageGen` false)
 *   AND nothing imagery-like got placed (any source: gen, stock, or upload).
 * It does NOT try to catch the "provider available but the agent forgot" case —
 * that inference is noisy and is left to the eval + prompt.
 */

// Every AI layer kind is real placed imagery (avatar/veo3/image/sticker). If any is
// present the video isn't blank CSS, so the floor stays silent.
const IMAGERY_AI_LAYER_TYPES = new Set(['image', 'sticker', 'veo3', 'avatar'])

/** True if a built scene carries any placed image / video / avatar imagery (any source). */
export function sceneHasImagery(scene: Scene): boolean {
  if (scene.videoLayer?.enabled && scene.videoLayer.src) return true
  // Counts placed layers, not raw <img>/<video> URLs embedded directly in
  // reactCode. That gap only matters when hasImageGen is already false (this floor's
  // only trigger) AND the agent hand-embedded a stock URL without place_image — rare,
  // and the posture is warn-only, so a spurious warning there is a low-harm note.
  return (scene.aiLayers ?? []).some((l) => !!l && IMAGERY_AI_LAYER_TYPES.has((l as { type?: string }).type ?? ''))
}

export interface ImageryFloorInput {
  /** Planned scenes — a non-empty `mediaLayers` note is the "brief wanted imagery" signal. */
  plannedScenes: Pick<SceneSpec, 'name' | 'mediaLayers'>[]
  /** The scenes actually built this run, to scan for placed imagery. */
  builtScenes: Scene[]
  /** Whether an AI image-generation provider is enabled+configured (hasRunnableImageProvider). */
  hasImageGen: boolean
  /** Optional missing-key hint for the message, e.g. "FAL_KEY or OPENAI_API_KEY". */
  missingKeyHint?: string
  /**
   * The brief itself wanted imagery (mediaStrategy.stock/generate/research) for a
   * real-world subject. Second trigger so a plan that carried NO `mediaLayers`
   * note can't silently suppress the floor — the exact way a too-conservative
   * brief shipped a pure-CSS video about an image-rich subject.
   */
  briefWantsImagery?: boolean
}

/** Returns at most one honest warning string (empty array = nothing to warn about). */
export function imageryFloorWarnings(input: ImageryFloorInput): string[] {
  const wanted = input.plannedScenes.filter((s) => (s.mediaLayers ?? '').trim().length > 0)
  // Fire when EITHER the plan called for media OR the brief did — a bad plan that
  // dropped every mediaLayers note no longer escapes the backstop.
  if (wanted.length === 0 && !input.briefWantsImagery) return [] // no imagery wanted anywhere — false-positive guard
  if (input.hasImageGen) return [] // a provider IS available — not this floor's job (see D-arch-2)
  if (input.builtScenes.some(sceneHasImagery)) return [] // something got placed (stock/upload) — fine

  const keyHint = input.missingKeyHint ? ` — set ${input.missingKeyHint}` : ''
  const tail =
    `no AI image provider is configured${keyHint}, so the video was built with CSS/vector visuals only. ` +
    `Add an image provider key to generate real imagery, or place royalty-free stock (find_media).`
  if (wanted.length === 0) {
    // Brief-driven trigger (plan carried no per-scene media note).
    return [`This video's subject calls for real imagery, but ${tail}`]
  }
  const names = wanted
    .slice(0, 3)
    .map((s) => `"${s.name}"`)
    .join(', ')
  const more = wanted.length > 3 ? ', …' : ''
  return [`The plan called for imagery in ${wanted.length} scene(s) (${names}${more}), but ${tail}`]
}
