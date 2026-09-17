import * as fal from '@fal-ai/serverless-client'
import type { AvatarProvider, AvatarGenerateInput, AvatarGenerateResult } from '../types'

function configureFal() {
  const key = process.env.FAL_KEY
  if (key) fal.config({ credentials: key })
}

export const museTalkProvider: AvatarProvider = {
  id: 'musetalk',
  name: 'MuseTalk (Realistic)',
  isFree: false,
  requiresImage: true,
  estimateCost: () => 0.04,

  async generate(input: AvatarGenerateInput, config: Record<string, any>): Promise<AvatarGenerateResult> {
    configureFal()

    const result = (await fal.subscribe('fal-ai/musetalk', {
      input: {
        source_video_url: input.sourceImageUrl,
        audio_url: input.audioUrl,
      },
    })) as any

    return {
      videoUrl: result.video.url,
      durationSeconds: input.durationSeconds,
      costUsd: 0.04,
      provider: 'musetalk',
    }
  },
}
