import { downloadVeo3Video, generateVeo3Video, getVeo3Status, VEO3_COST_ESTIMATE } from '../veo3'
import { enhance } from '@/lib/media/enhance'
import type { VideoProviderClient } from './types'

/** Veo 3 wrapped as a VideoProviderClient so the new multi-provider video
 *  route can dispatch uniformly. The underlying functions live in veo3.ts
 *  (kept for backwards compatibility with direct callers). */
export const veo3Provider: VideoProviderClient = {
  id: 'veo3',
  name: 'Google Veo 3',
  envKey: 'GOOGLE_AI_KEY',
  costPerCallUsd: VEO3_COST_ESTIMATE,

  async generate(opts) {
    const finalPrompt = await enhance({ modality: 'video', rawPrompt: opts.prompt })
    // Veo 3 only supports 5 or 8 second clips today.
    const duration: 5 | 8 = opts.durationSeconds >= 8 ? 8 : 5
    // i2v: Veo takes the conditioning image inline as base64 bytes (same endpoint as t2v, image in
    // the body). Resolve the reference to bytes; throws (no silent t2v fallback) if unreadable.
    let image: { imageBytes: string; mimeType: string } | undefined
    if (opts.imageUrl) {
      const { resolveReferenceToBytes } = await import('@/lib/media/reference-upload')
      const { bytes, mimeType } = await resolveReferenceToBytes(opts.imageUrl)
      image = { imageBytes: bytes.toString('base64'), mimeType }
    }
    const { operationName } = await generateVeo3Video({
      prompt: finalPrompt,
      negativePrompt: opts.negativePrompt,
      aspectRatio: opts.aspectRatio,
      durationSeconds: duration,
      image,
    })
    return { operationId: operationName, enhancedPrompt: finalPrompt }
  },

  async pollStatus(operationId) {
    return getVeo3Status(operationId)
  },

  async download(uri) {
    return downloadVeo3Video(uri)
  },
}
