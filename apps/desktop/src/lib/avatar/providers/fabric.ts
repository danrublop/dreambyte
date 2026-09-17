import * as fal from '@fal-ai/serverless-client'
import type { AvatarProvider, AvatarGenerateInput, AvatarGenerateResult } from '../types'

function configureFal() {
  const key = process.env.FAL_KEY
  if (key) fal.config({ credentials: key })
}

export const fabricProvider: AvatarProvider = {
  id: 'fabric',
  name: 'Fabric 1.0 (Any Image Style)',
  isFree: false,
  requiresImage: true,
  estimateCost: (duration: number) => duration * 0.08,

  async generate(input: AvatarGenerateInput, config: Record<string, any>): Promise<AvatarGenerateResult> {
    configureFal()

    const resolution = config.resolution || '480p'
    const costPerSec = resolution === '720p' ? 0.15 : 0.08

    const result = (await fal.subscribe('veed/fabric-1.0', {
      input: {
        image_url: input.sourceImageUrl,
        audio_url: input.audioUrl,
        resolution,
      },
    })) as any

    return {
      videoUrl: result.video.url,
      durationSeconds: input.durationSeconds,
      costUsd: input.durationSeconds * costPerSec,
      provider: 'fabric',
    }
  },
}
