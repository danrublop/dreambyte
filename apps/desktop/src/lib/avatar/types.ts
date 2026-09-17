export interface AvatarGenerateInput {
  text: string // narration text
  audioUrl: string // pre-generated TTS audio file URL
  sourceImageUrl?: string // for fal.ai providers — face image
  durationSeconds: number // expected output duration
  projectId: string
}

export interface AvatarGenerateResult {
  videoUrl: string
  durationSeconds: number
  costUsd: number
  provider: string
}

export interface AvatarProvider {
  id: string
  name: string
  generate(input: AvatarGenerateInput, config: Record<string, any>): Promise<AvatarGenerateResult>
  estimateCost(durationSeconds: number): number
  requiresImage: boolean
  isFree: boolean
}

export type AvatarProviderId = 'musetalk' | 'fabric' | 'aurora' | 'heygen'

export type AvatarPlacement = 'pip_bottom_right' | 'pip_bottom_left' | 'pip_top_right' | 'fullscreen'
