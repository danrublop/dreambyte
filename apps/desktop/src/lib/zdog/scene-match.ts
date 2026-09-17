/**
 * Shared Zdog scene parameters so the character builder preview matches
 * composed scenes (`composeDeterministicZdogScene`) and exported HTML (`generateZdogHTML`).
 */
export const ZDOG_SCENE = {
  width: 1920,
  height: 1080,
  /**
   * Canvas zoom (reference demo uses ~6 on a 400px-wide canvas). Prefer this over huge
   * `Anchor.scale` on the person root — scale stretches path points more than stroke width
   * (see Zdog Shape.transform), which reads as “twig” limbs.
   */
  illustrationZoom: 9,
  /**
   * Default rig placement for person roots (character builder + composed scenes).
   * Keep person root scale at 1 when possible; use `illustrationZoom` for framing.
   */
  matchPlacement: { y: 44, scale: 1 },
} as const
