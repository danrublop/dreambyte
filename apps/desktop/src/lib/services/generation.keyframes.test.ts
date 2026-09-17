import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startVideo } from './generation'

// Tier 2 (#5): startVideo is the single choke point that ENFORCES keyframe/extend capability for
// every caller (in-app, agent, MCP, raw IPC). The provider adapters fail loud too, but the gate
// here runs FIRST (before the permission/cost gate and before any provider call) so a direct caller
// can't reach a provider that silently ignores the input. These cases assert the gate rejects an
// incapable request BEFORE touching the network or the db — the throw short-circuits in the
// capability block, which is why no projectId / no real provider call is needed.
describe('startVideo keyframe/extend capability enforcement', () => {
  const ORIG = { ...process.env }
  beforeEach(() => {
    // Provider resolution only checks the env var is present; no real key is used (we never reach
    // a provider call — the capability gate throws first).
    process.env.GOOGLE_AI_KEY = 'test'
    process.env.FAL_KEY = 'test'
    process.env.RUNWAY_API_KEY = 'test'
  })
  afterEach(() => {
    process.env = { ...ORIG }
  })

  it('rejects an end-frame (keyframe) request to Veo (keyframes:false) before any provider call', async () => {
    await expect(
      startVideo({
        provider: 'veo3',
        prompt: 'morph',
        endImageUrl: 'data:image/png;base64,E',
        imageUrl: 'data:image/png;base64,S',
      }),
    ).rejects.toThrow(/does not support start\/end keyframes/)
  })

  it('rejects an extend request to Veo (extend:false)', async () => {
    await expect(
      startVideo({ provider: 'veo3', prompt: 'continue', extendVideoUrl: 'https://cdn/clip.mp4' }),
    ).rejects.toThrow(/does not support extending/)
  })

  it('rejects a keyframe request with no start frame even on a keyframe-capable model (Kling)', async () => {
    await expect(
      startVideo({ provider: 'kling', prompt: 'x', endImageUrl: 'data:image/png;base64,E' }),
    ).rejects.toThrow(/requires a start frame/)
  })

  it('rejects an in-video edit (v2v) request to a non-v2v model (Veo)', async () => {
    await expect(
      startVideo({
        provider: 'veo3',
        prompt: 'restyle',
        editVideoUrl: 'https://cdn/clip.mp4',
        edit: { operation: 'restyle' },
      }),
    ).rejects.toThrow(/does not support in-video editing/)
  })

  it('rejects an edit with no valid operation (fail loud, not a silent un-framed v2v call)', async () => {
    // runway is v2v-capable, so this passes the capability gate and hits the operation requirement.
    await expect(
      startVideo({ provider: 'runway', prompt: 'restyle', editVideoUrl: 'https://cdn/clip.mp4' }),
    ).rejects.toThrow(/requires a valid edit operation/)
    await expect(
      startVideo({
        provider: 'runway',
        prompt: 'x',
        editVideoUrl: 'https://cdn/clip.mp4',
        edit: { operation: 'zoom' as never },
      }),
    ).rejects.toThrow(/requires a valid edit operation/)
  })

  it('rejects performance capture (Act-Two) on a model without it (Veo)', async () => {
    await expect(
      startVideo({
        provider: 'veo3',
        prompt: 'x',
        imageUrl: 'data:image/png;base64,C',
        drivingVideoUrl: 'https://cdn/drive.mp4',
      }),
    ).rejects.toThrow(/does not support performance capture/)
  })

  it('performance capture requires a character image (imageUrl)', async () => {
    await expect(
      startVideo({ provider: 'runway', prompt: 'x', drivingVideoUrl: 'https://cdn/drive.mp4' }),
    ).rejects.toThrow(/requires a character image/)
  })

  it('rejects combining performance capture with another advanced mode', async () => {
    await expect(
      startVideo({
        provider: 'runway',
        prompt: 'x',
        imageUrl: 'data:image/png;base64,C',
        drivingVideoUrl: 'https://cdn/drive.mp4',
        extendVideoUrl: 'https://cdn/a.mp4',
      }),
    ).rejects.toThrow(/only one of keyframe \/ extend \/ edit \/ performance-capture/)
  })

  it('rejects combining two advanced modes (extend + edit) in one request', async () => {
    await expect(
      startVideo({
        provider: 'runway',
        prompt: 'x',
        extendVideoUrl: 'https://cdn/a.mp4',
        editVideoUrl: 'https://cdn/b.mp4',
        edit: { operation: 'restyle' },
      }),
    ).rejects.toThrow(/only one of keyframe \/ extend \/ edit/)
  })

  // Tier 3 (breadth): video upscale capability enforcement.
  it('rejects a video upscale request to a model without it (Veo, videoUpscale:false)', async () => {
    await expect(startVideo({ provider: 'veo3', prompt: '', upscaleVideoUrl: 'https://cdn/clip.mp4' })).rejects.toThrow(
      /does not support video upscale/,
    )
  })

  it('rejects combining upscale with another advanced mode (extend + upscale)', async () => {
    await expect(
      startVideo({
        provider: 'kling',
        prompt: 'x',
        extendVideoUrl: 'https://cdn/a.mp4',
        upscaleVideoUrl: 'https://cdn/b.mp4',
      }),
    ).rejects.toThrow(/only one of keyframe \/ extend \/ edit \/ performance-capture \/ upscale/)
  })
})
