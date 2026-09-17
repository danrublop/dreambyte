/**
 * Compat for projects saved before the local 3D avatar provider was removed.
 *
 * Older avatar configs used provider id `talkinghead`, and their avatar layers carry a
 * `talkingHeadUrl` (`talkinghead://render?...`) instead of a video. The runtime and its
 * sample models are gone, so these load as a visible placeholder instead of crashing.
 * This is the only place that should know those legacy names.
 */
export const REMOVED_LOCAL_AVATAR_PROVIDER = 'talkinghead'
export const REMOVED_LOCAL_AVATAR_MESSAGE = 'This avatar used a removed local avatar model'

export function usesRemovedLocalAvatar(layer: unknown): boolean {
  const l = (layer ?? {}) as { talkingHeadUrl?: unknown; avatarProvider?: unknown }
  return (
    (typeof l.talkingHeadUrl === 'string' && l.talkingHeadUrl.length > 0) ||
    l.avatarProvider === REMOVED_LOCAL_AVATAR_PROVIDER
  )
}
