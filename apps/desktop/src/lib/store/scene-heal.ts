/**
 * Scene HTML self-heal decision.
 *
 * Scene HTML on disk is authoritative for the preview iframe, but it can drift:
 * the file is missing (fresh clone, cleared cache, external delete) or stale
 * (the on-disk HTML differs from what the current template + scene row would
 * produce — e.g. after a sceneTemplate.ts change). On project load we compare
 * each scene's freshly-generated HTML against the file and regenerate ONLY when
 * they differ, so healthy scenes are never rewritten.
 *
 * This module holds the PURE decision (no IPC, no React) so it is exhaustively
 * unit-testable. The store action wires generateSceneHTML + the readHtml IPC +
 * saveSceneHTML around it.
 */

export type SceneHealReason = 'missing' | 'stale'

export interface SceneHealDecision {
  needsHeal: boolean
  reason: SceneHealReason | null
}

/**
 * generateSceneHTML embeds a per-call `?v=<Date.now()>` cache-buster in its SDK
 * <script> URLs (sceneTemplate.ts), so two generations of the SAME scene row
 * are never byte-identical. The staleness comparison must ignore that buster —
 * otherwise self-heal would rewrite EVERY scene on EVERY load (violating
 * "healthy scenes untouched"). Normalize `?v=<digits>` to a constant so the
 * compare reflects real template/content drift, not the timestamp. The regen
 * itself still writes the full HTML with a fresh buster — only the comparison
 * is normalized.
 */
export function normalizeForHealCompare(html: string): string {
  return html.replace(/\?v=\d+/g, '?v=0')
}

/**
 * Decide whether a scene needs healing given the freshly-generated HTML and the
 * on-disk state. Missing file → heal ('missing'). Present but
 * different-after-normalizing-the-cache-buster → heal ('stale'). Otherwise
 * healthy (no write). An empty expected HTML (scene has no renderable content
 * yet) is never healed — there's nothing to write and we must not clobber a
 * real file with a blank.
 */
export function decideSceneHeal(
  expectedHtml: string,
  onDisk: { exists: boolean; html: string | null },
): SceneHealDecision {
  if (!expectedHtml) return { needsHeal: false, reason: null }
  if (!onDisk.exists || onDisk.html == null) return { needsHeal: true, reason: 'missing' }
  if (normalizeForHealCompare(onDisk.html) !== normalizeForHealCompare(expectedHtml)) {
    return { needsHeal: true, reason: 'stale' }
  }
  return { needsHeal: false, reason: null }
}
