// Max pixels-per-second the user can zoom to. At MAX_PPS the TimeRuler picks
// frame-level intervals (~1 frame per 30-50px at 30fps) and `findSnap`'s
// frame grid kicks in. 100 was too low for serious frame-level editing
// (1 frame ≈ 3.3px at 30fps); 1500 lets a frame span ~50px so individual
// frames are clickable. The drag/snap/virtualization paths already scale.
export const MAX_PPS = 1500
export const RULER_HEIGHT = 32
export const SNAP_THRESHOLD = 5 // px for playhead snap
export const TOOLBAR_WIDTH = 32
export const TRACK_HEADER_WIDTH = 148
export const TRACK_ROW_HEIGHT = 48
export const CLIP_TRIM_HANDLE_WIDTH = 10
// Single source of truth lives in src/lib/ so the reducer (which must not import
// from src/components/) and the UI share one minimum-clip-duration value.
export { MIN_CLIP_DURATION } from '@/lib/timeline/clip-edits'
export const DRAG_DEAD_ZONE = 4 // px before drag starts
