// ── Project Assets / Watermark ──────────────────────────────────────────────

// 'doc' = a non-media reference file (md/txt/pdf/…) attached in chat for the
// agent to read. Stored for its URI but never shown in the media gallery or
// added to the timeline — see GalleryPanel filter + addAssetToTimeline guard.
export type AssetType = 'image' | 'video' | 'svg' | 'avatar' | 'audio' | 'doc'

export type AssetSource = 'upload' | 'generated'

export type MediaIntent = 't2i' | 'i2i' | 'sticker' | 'video' | 'avatar'

export interface AssetGenerationMetadata {
  prompt: string | null
  provider: string | null
  model: string | null
  costCents: number | null
  parentAssetId: string | null
  referenceAssetIds: string[] | null
  enhanceTags: string[] | null
}

export interface ProjectAsset extends AssetGenerationMetadata {
  id: string
  projectId: string
  filename: string
  storagePath: string
  publicUrl: string
  type: AssetType
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationSeconds: number | null
  name: string
  tags: string[]
  thumbnailUrl: string | null
  extractedColors: string[]
  source: AssetSource
  createdAt: string
}

export interface WatermarkConfig {
  assetId: string
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  opacity: number
  sizePercent: number
}

export interface BrandKit {
  brandName: string | null
  logoAssetIds: string[]
  palette: string[]
  fontPrimary: string | null
  fontSecondary: string | null
  guidelines: string | null
}

export type ImageModel =
  | 'flux-1.1-pro'
  | 'flux-schnell'
  | 'ideogram-v3'
  | 'recraft-v3'
  | 'stable-diffusion-3'
  | 'dall-e-3'

export type ImageStyle = 'photorealistic' | 'illustration' | 'flat' | 'sketch' | '3d' | 'pixel' | 'watercolor'

// 'processing' is the HeyGen avatar in-flight state (the agent's avatar tools and
// get_avatar_status use it). It means the same as 'generating' — kept as a distinct
// member so the type matches the avatar code's runtime value instead of being masked
// by `as any` casts.
export type MediaLayerStatus = 'pending' | 'generating' | 'processing' | 'removing-bg' | 'ready' | 'error'

/**
 * Snapshot of how an AI layer's media was produced, copied from the
 * generating call (and mirrored from the persisted ProjectAsset's
 * AssetGenerationMetadata). Lets in-place regeneration reconstruct the
 * original request without a DB round-trip, and survives even if the source
 * asset is later deleted. `assetId` (on the layer) is the live link to the
 * ProjectAsset row; this block is the durable provenance copy.
 */
export interface LayerProvenance {
  prompt: string | null
  provider: string | null
  model: string | null
  /** Style preset / image style used, when known. */
  style?: string | null
  /** Asset ids used as i2i references, if any. */
  referenceAssetIds?: string[] | null
  /**
   * Raw reference URLs (e.g. an avatar source image) that are NOT backed by a
   * ProjectAsset row. Kept separate from `referenceAssetIds` so that field
   * stays honestly typed as asset ids only — never raw URLs.
   */
  referenceUrls?: string[] | null
  /** ISO timestamp of the generating call. */
  generatedAt?: string | null
}

export interface LayerAnimation {
  type:
    | 'fade-in'
    | 'fade-out'
    | 'slide-left'
    | 'slide-right'
    | 'slide-up'
    | 'slide-down'
    | 'scale-in'
    | 'scale-out'
    | 'spin-in'
    | 'none'
  duration: number // seconds
  delay: number // seconds from scene start
  easing?: string // CSS easing, e.g. 'ease-in-out'
}

export interface ImageLayer {
  id: string
  type: 'image'
  prompt: string
  model: ImageModel
  style: ImageStyle | null
  imageUrl: string | null
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  zIndex: number
  status: MediaLayerStatus
  label: string
  startAt?: number
  animation?: LayerAnimation
  filter?: string // CSS filter string, e.g. "blur(2px) brightness(1.2)"
  /** Advanced correction stack (exposure/contrast/temp/tint/curves) — see src/lib/edit-engines/layer-grade.ts. */
  colorGrade?: import('../edit-engines/layer-grade').LayerColorGrade
  /** Live link to the ProjectAsset this layer was placed from. */
  assetId?: string | null
  /** Durable provenance snapshot of the generating call. */
  provenance?: LayerProvenance | null
}

export interface StickerLayer {
  id: string
  type: 'sticker'
  prompt: string
  model: ImageModel
  style: ImageStyle | null
  imageUrl: string | null
  stickerUrl: string | null
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  zIndex: number
  status: MediaLayerStatus
  animateIn: boolean
  startAt: number
  label: string
  animation?: LayerAnimation
  filter?: string
  /** Live link to the ProjectAsset this layer was placed from. */
  assetId?: string | null
  /** Durable provenance snapshot of the generating call. */
  provenance?: LayerProvenance | null
}
