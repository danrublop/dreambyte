/**
 * Shared registry of live preview iframes, keyed by scene id.
 *
 * Why: scene-error beacons are bound to their POSTING frame before being
 * accepted (`isErrorReportBoundToFrame`) — PreviewPlayer binds against its
 * own per-scene iframe map, so beacons from OTHER preview surfaces
 * (BranchPreviewPlayer's read-only branch preview) were silently dropped,
 * and branch-preview playback errors never reached the scene-error buffer.
 *
 * Any preview surface can register its iframe here; the message listener in
 * PreviewPlayer consults this registry as a second binding source. A scene
 * id can have MULTIPLE live frames (the editor scene and a branch copy can
 * share an id when both previews are open) — binding passes when the posting
 * window matches ANY registered frame for that id. Attribution stays honest:
 * it is that scene's code either way, just possibly the branch copy.
 *
 * NOTE: reporting still happens in PreviewPlayer's window listener — this
 * registry only widens the binding. A branch preview open WITHOUT the editor
 * preview mounted has no listener; acceptable for the read-only branch
 * surface (documented coupling, not a hidden one).
 */

type FrameLike = { contentWindow: unknown } | null | undefined

const frames = new Map<string, Set<FrameLike>>()

/**
 * Register a preview iframe for a scene id. Returns the unregister function
 * (call it in the effect cleanup). Null/undefined frames are ignored but
 * still return a no-op unregister so callers don't branch.
 */
export function registerPreviewFrame(sceneId: string, frame: FrameLike): () => void {
  if (!sceneId || !frame) return () => {}
  let set = frames.get(sceneId)
  if (!set) {
    set = new Set()
    frames.set(sceneId, set)
  }
  set.add(frame)
  return () => {
    const s = frames.get(sceneId)
    if (!s) return
    s.delete(frame)
    if (s.size === 0) frames.delete(sceneId)
  }
}

/**
 * True when `source` is the contentWindow of a frame registered for the
 * claimed scene id. Mirrors `isErrorReportBoundToFrame`'s semantics over a
 * many-frames-per-id registry.
 */
export function isRegisteredPreviewFrame(claimedSceneId: unknown, source: unknown): boolean {
  if (typeof claimedSceneId !== 'string' || claimedSceneId.length === 0) return false
  const set = frames.get(claimedSceneId)
  if (!set) return false
  for (const frame of set) {
    if (frame?.contentWindow && source === frame.contentWindow) return true
  }
  return false
}

export function __clearPreviewFrameRegistryForTesting(): void {
  frames.clear()
}
