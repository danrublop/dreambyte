/**
 * Pure scene-sequencing helpers for the preview player.
 *
 * Kept out of the React component so the "skip unrenderable scenes" logic is
 * unit-testable without a DOM. A verify-errored scene never mounts its iframe,
 * so during playback we must walk past it to the next scene that can actually
 * render — otherwise one broken scene freezes the whole build.
 */

/**
 * Return the first scene id strictly after `fromSceneId` (in the given timeline
 * order) for which `isErrored` is false, or `null` if there is none. Returns
 * `null` when `fromSceneId` isn't in the list.
 */
export function nextRenderableSceneId(
  orderedSceneIds: readonly string[],
  isErrored: (id: string) => boolean,
  fromSceneId: string,
): string | null {
  const fromIdx = orderedSceneIds.indexOf(fromSceneId)
  if (fromIdx < 0) return null
  for (let i = fromIdx + 1; i < orderedSceneIds.length; i++) {
    if (!isErrored(orderedSceneIds[i])) return orderedSceneIds[i]
  }
  return null
}
