import type { AvatarProvider, AvatarGenerateInput, AvatarGenerateResult } from '../types'
import { generateAvatarVideo, getVideoStatus, downloadVideo } from '../../apis/heygen'

/**
 * HeyGen avatar provider — wraps the existing HeyGen integration.
 *
 * HeyGen handles its own TTS, so this provider passes the text directly
 * rather than using the pre-generated audio URL. The voiceId and avatarId
 * come from the avatar config.
 */
export const heygenProvider: AvatarProvider = {
  id: 'heygen',
  name: 'HeyGen (Premium)',
  isFree: false,
  requiresImage: false,
  estimateCost: (duration: number) => duration * 0.1,

  async generate(input: AvatarGenerateInput, config: Record<string, any>): Promise<AvatarGenerateResult> {
    const avatarId = config.avatarId
    const voiceId = config.voiceId
    if (!avatarId || !voiceId) {
      throw new Error('HeyGen provider requires avatarId and voiceId in config')
    }

    // Start generation
    const { videoId, estimatedSeconds } = await generateAvatarVideo({
      avatarId,
      voiceId,
      script: input.text,
      bgColor: config.bgColor ?? '#00FF00',
      width: config.width ?? 512,
      height: config.height ?? 512,
    })

    // Poll for completion (max ~5 minutes)
    const maxAttempts = 60
    const pollInterval = 5000
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      const status = await getVideoStatus(videoId)

      if (status.status === 'completed' && status.videoUrl) {
        return {
          videoUrl: status.videoUrl,
          durationSeconds: estimatedSeconds,
          costUsd: estimatedSeconds * 0.1,
          provider: 'heygen',
        }
      }

      if (status.status === 'failed') {
        throw new Error(`HeyGen generation failed: ${status.error ?? 'unknown error'}`)
      }
    }

    throw new Error('HeyGen generation timed out after 5 minutes')
  },
}
