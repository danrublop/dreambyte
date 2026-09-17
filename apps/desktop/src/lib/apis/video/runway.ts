// Runway Gen-4 Turbo text-to-video, direct API.
//
// Uses RUNWAY_API_KEY. API documented at https://docs.dev.runwayml.com/.
// Gen-4 currently requires an image prompt in most configurations; for pure
// text-to-video this adapter uses `gen4_aleph` when available, and falls
// back to Gen-3 Alpha Turbo for text-only prompts.

import type { VideoProviderClient, VideoStatus } from './types'

const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1'
const DEFAULT_MODEL = 'gen4_turbo'
// Tier 2 (#4): Runway's in-video edit model. Named next to DEFAULT_MODEL so both Runway model ids
// live in one place (not a buried literal in the edit branch). Env-overridable via RUNWAY_ALEPH_MODEL.
const DEFAULT_ALEPH_MODEL = 'gen4_aleph'

function getKey(): string {
  const key = process.env.RUNWAY_API_KEY
  if (!key) throw new Error('RUNWAY_API_KEY not configured — add it to use Runway')
  return key
}

function runwayRatio(aspect: '16:9' | '9:16' | '1:1'): string {
  // Runway uses exact pixel ratios instead of shorthand.
  switch (aspect) {
    case '16:9':
      return '1280:720'
    case '9:16':
      return '720:1280'
    case '1:1':
      return '960:960'
  }
}

export const runwayProvider: VideoProviderClient = {
  id: 'runway',
  name: 'Runway Gen-4',
  envKey: 'RUNWAY_API_KEY',
  costPerCallUsd: 0.9,

  async generate(opts) {
    const key = getKey()
    const model = process.env.RUNWAY_MODEL || DEFAULT_MODEL

    // Runway exposes distinct submit endpoints; the poll is task-id based for ALL of them (no
    // per-endpoint state at poll time), so only the submit branch differs. Routed most-specific
    // first: edit/Aleph (in-video transform) → extend (continue) → keyframe (first+last frame) →
    // i2v (single promptImage) → t2v. UNVERIFIED: the endpoint paths + body fields are best-effort
    // vs current Runway docs, not confirmed against the live API — fails loud (4xx) if wrong.
    const common = {
      model,
      promptText: opts.prompt,
      ratio: runwayRatio(opts.aspectRatio),
      duration: Math.max(5, Math.min(10, opts.durationSeconds)),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    }
    const { resolveReferenceToFetchableUrl } = await import('@/lib/media/reference-upload')
    let endpoint = `${RUNWAY_BASE}/text_to_video`
    let body: Record<string, unknown> = common
    if (opts.drivingVideoUrl) {
      // Tier 2 (#6) Runway Act-Two: drive the character image with a performance video. Endpoint +
      // model (act_two) + field names UNVERIFIED vs live Runway docs (fail loud 4xx if wrong).
      if (!opts.imageUrl) throw new Error('Runway Act-Two requires a character image (imageUrl)')
      const [character, driving] = await Promise.all([
        resolveReferenceToFetchableUrl(opts.imageUrl),
        resolveReferenceToFetchableUrl(opts.drivingVideoUrl, undefined, { kind: 'video' }),
      ])
      endpoint = `${RUNWAY_BASE}/character_performance`
      // Runway's character_performance schema: a positioned character ref + a video reference (NOT a
      // bare `character` string + `videoUri`), and no promptText/camera (Act-Two has no text prompt).
      // UNVERIFIED against a live key but matches the documented shape.
      body = {
        model: process.env.RUNWAY_ACT_TWO_MODEL || 'act_two',
        ratio: common.ratio,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        character: { type: 'image', uri: character },
        reference: { type: 'video', uri: driving },
      }
    } else if (opts.editVideoUrl) {
      // Tier 2 (#4) Runway Aleph: in-video edit (restyle/relight/etc). Same /video_to_video endpoint
      // as extend, but the Aleph model (gen4_aleph) + the edit prompt (already framed upstream). The
      // spread-then-override puts the Aleph model after `common`'s default model so Aleph wins.
      const alephModel = process.env.RUNWAY_ALEPH_MODEL || DEFAULT_ALEPH_MODEL
      endpoint = `${RUNWAY_BASE}/video_to_video`
      body = {
        ...common,
        model: alephModel,
        videoUri: await resolveReferenceToFetchableUrl(opts.editVideoUrl, undefined, { kind: 'video' }),
      }
    } else if (opts.extendVideoUrl) {
      // Continue an existing clip (Gen-4 video→video). videoUri is a fetchable, trust-guarded clip.
      endpoint = `${RUNWAY_BASE}/video_to_video`
      body = {
        ...common,
        videoUri: await resolveReferenceToFetchableUrl(opts.extendVideoUrl, undefined, { kind: 'video' }),
      }
    } else if (opts.endImageUrl) {
      // Start+end keyframe: Runway takes promptImage as positioned frames (first + last).
      if (!opts.imageUrl) throw new Error('Runway keyframe generation requires a start frame (imageUrl)')
      const [first, last] = await Promise.all([
        resolveReferenceToFetchableUrl(opts.imageUrl),
        resolveReferenceToFetchableUrl(opts.endImageUrl),
      ])
      endpoint = `${RUNWAY_BASE}/image_to_video`
      body = {
        ...common,
        promptImage: [
          { uri: first, position: 'first' },
          { uri: last, position: 'last' },
        ],
      }
    } else if (opts.imageUrl) {
      endpoint = `${RUNWAY_BASE}/image_to_video`
      body = { ...common, promptImage: await resolveReferenceToFetchableUrl(opts.imageUrl) }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!res.ok) throw new Error(data?.error ?? `Runway error: ${res.status}`)
    const operationId = data.id as string | undefined
    if (!operationId) throw new Error('Runway response missing task id')
    return { operationId }
  },

  async pollStatus(operationId): Promise<VideoStatus> {
    const key = getKey()
    const res = await fetch(`${RUNWAY_BASE}/tasks/${operationId}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        'X-Runway-Version': '2024-11-06',
      },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error ?? `Runway status error: ${res.status}`)
    if (data.status === 'SUCCEEDED') {
      const uri = data?.output?.[0]
      if (!uri) return { done: true, error: 'Runway completed without a video URL' }
      return { done: true, videoUri: uri }
    }
    if (data.status === 'FAILED') {
      return { done: true, error: data.failure_reason ?? 'Runway generation failed' }
    }
    return { done: false }
  },

  async download(uri) {
    const res = await fetch(uri)
    if (!res.ok) throw new Error(`Runway download failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  },
}
