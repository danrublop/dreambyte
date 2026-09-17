import * as fal from '@fal-ai/serverless-client'
import type { AvatarProvider, AvatarGenerateInput, AvatarGenerateResult } from '../types'

function configureFal() {
  const key = process.env.FAL_KEY
  if (key) fal.config({ credentials: key })
}

export const auroraProvider: AvatarProvider = {
  id: 'aurora',
  name: 'Aurora (Studio Quality)',
  isFree: false,
  requiresImage: true,
  estimateCost: (duration: number) => duration * 0.05,

  async generate(input: AvatarGenerateInput, config: Record<string, any>): Promise<AvatarGenerateResult> {
    configureFal()

    // fal/Creatify publish this endpoint as `fal-ai/creatify/aurora` (the older
    // un-prefixed `creatify/aurora` 404s). See Slice 0 catalog check for verification.
    const result = (await fal.subscribe('fal-ai/creatify/aurora', {
      input: {
        image_url: input.sourceImageUrl,
        audio_url: input.audioUrl,
      },
    })) as any

    return {
      videoUrl: result.video.url,
      durationSeconds: input.durationSeconds,
      costUsd: input.durationSeconds * 0.05,
      provider: 'aurora',
    }
  },
}
