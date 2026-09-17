// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tier 3 Cast — Slice 1. resolveGuardedFace resolves an avatar's face source
// (explicit URL → Cast character's reference → config) and runs it through the shared
// trust guard before any provider sees it. avatar.ts does `import` (static) of
// reference-upload + characters; vi.mock intercepts them.

const resolveRef = vi.fn(async (r: string) => `https://fetchable/${r}`)
vi.mock('@/lib/media/reference-upload', () => ({
  resolveReferenceToFetchableUrl: (r: string) => resolveRef(r),
}))

const resolveCharacter = vi.fn()
vi.mock('@/lib/db/queries/characters', () => ({
  resolveCharacter: (...a: unknown[]) => resolveCharacter(...a),
}))

const primaryReferenceUrl = vi.fn()
vi.mock('@/lib/services/characters', () => ({
  primaryReferenceUrl: (...a: unknown[]) => primaryReferenceUrl(...a),
}))

const getClonedVoice = vi.fn()
vi.mock('@/lib/db/queries/cloned-voices', () => ({
  getClonedVoice: (...a: unknown[]) => getClonedVoice(...a),
}))

// musetalk/fabric/aurora require an image; heygen does not.
vi.mock('@/lib/avatar', () => ({
  AvatarService: {
    getProvider: (id: string) => {
      if (id === 'nope') throw new Error('Unknown avatar provider: nope')
      const requiresImage = id === 'musetalk' || id === 'fabric' || id === 'aurora'
      return { id, requiresImage }
    },
    generate: (...a: unknown[]) => avatarServiceGenerate(...(a as [])),
  },
}))

// Chainable db mock. `selectRows` is the queue `resolveAvatarConfig` reads from (one
// dequeue per select); `inserted`/`updated` capture writes for the async-path assertions.
// resolveGuardedFace tests never touch these (queue stays empty → [] is harmless).
const selectRows: any[][] = []
const inserted: any[] = []
const updated: any[] = []
vi.mock('@/lib/db', () => {
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(selectRows.shift() ?? []) }) }),
    insert: () => ({
      values: (v: any) => ({
        returning: () => {
          const row = { id: `vid-${inserted.length + 1}`, ...v }
          inserted.push(row)
          return Promise.resolve([row])
        },
      }),
    }),
    update: () => ({
      set: (s: any) => ({
        where: () => ({
          returning: () => {
            const row = { id: inserted[inserted.length - 1]?.id ?? 'vid-1', ...inserted[inserted.length - 1], ...s }
            updated.push(s)
            return Promise.resolve([row])
          },
        }),
      }),
    }),
  }
  return { db, logSpend: (...a: unknown[]) => logSpend(...(a as [])) }
})
// P1: generateAvatar commits FAL-avatar spend to the apiSpend ledger via logSpend.
const logSpend = vi.fn(async () => {})
vi.mock('@/lib/db/schema', () => ({ avatarConfigs: {}, avatarVideos: {}, scenes: {} }))
const getTTSProviderImpl = vi.fn(async () => ({}) as { requiresKey?: string | null })
vi.mock('@/lib/audio/router', () => ({
  getBestTTSProvider: () => 'elevenlabs',
  getTTSProvider: (...a: unknown[]) => getTTSProviderImpl(...(a as [])),
}))

// Async heygen submit path. startAvatarGeneration dynamically imports this.
const startHeygenAvatar = vi.fn(async () => ({ videoId: 'hg-123', estimatedSeconds: 42, estimatedCost: 0.42 }))
vi.mock('./generation', () => ({
  startHeygenAvatar: (...a: unknown[]) => startHeygenAvatar(...(a as [])),
}))

// TTS spend gate — no-op (the sync fal path runs TTS, which gates paid voices).
vi.mock('./media-gate', () => ({ gateMediaSpend: vi.fn(async () => null) }))

// AvatarService.generate (sync fal path delegates through generateAvatar → here).
const avatarServiceGenerate = vi.fn(async () => ({
  videoUrl: '/uploads/avatar.mp4',
  durationSeconds: 5,
  costUsd: 0,
  provider: 'musetalk',
}))

import {
  resolveGuardedFace,
  resolveAvatarVoice,
  AvatarValidationError,
  startAvatarGeneration,
  generateAvatar,
} from './avatar'
import { REMOVED_LOCAL_AVATAR_PROVIDER } from '@/lib/avatar/removed-local-avatar'

const cfg = (provider: string, sourceImageUrl?: string) =>
  ({ id: 'cfg1', provider, config: sourceImageUrl ? { sourceImageUrl } : {} }) as any

beforeEach(() => {
  resolveRef.mockClear().mockImplementation(async (r: string) => `https://fetchable/${r}`)
  resolveCharacter.mockReset()
  primaryReferenceUrl.mockReset()
  getClonedVoice.mockReset()
  getTTSProviderImpl.mockReset().mockResolvedValue({}) // provider has no required key by default
  selectRows.length = 0
  inserted.length = 0
  updated.length = 0
  logSpend.mockClear()
  startHeygenAvatar.mockClear().mockResolvedValue({ videoId: 'hg-123', estimatedSeconds: 42, estimatedCost: 0.42 })
  avatarServiceGenerate.mockClear().mockResolvedValue({
    videoUrl: '/uploads/avatar.mp4',
    durationSeconds: 5,
    costUsd: 0,
    provider: 'musetalk',
  })
})

describe('resolveGuardedFace', () => {
  it('guards an explicit sourceImageUrl for an image provider', async () => {
    const out = await resolveGuardedFace(
      'p1',
      { text: 'hi', sourceImageUrl: 'data:image/png;base64,AAAA' },
      cfg('musetalk'),
    )
    expect(resolveRef).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(out).toBe('https://fetchable/data:image/png;base64,AAAA')
  })

  it('surfaces a rejected image (SSRF / oversized / non-image) as AvatarValidationError', async () => {
    resolveRef.mockRejectedValueOnce(new Error('Reference image too large'))
    await expect(
      resolveGuardedFace('p1', { text: 'hi', sourceImageUrl: 'https://evil/internal' }, cfg('fabric')),
    ).rejects.toBeInstanceOf(AvatarValidationError)
  })

  it('resolves a Cast character to its primary reference, then guards it', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', referenceAssetIds: ['asset-1'] })
    primaryReferenceUrl.mockResolvedValue('dreambyte://asset/aria.png')
    const out = await resolveGuardedFace('p1', { text: 'hi', characterId: 'Aria' }, cfg('aurora'))
    expect(resolveCharacter).toHaveBeenCalledWith('p1', 'Aria')
    expect(resolveRef).toHaveBeenCalledWith('dreambyte://asset/aria.png')
    expect(out).toBe('https://fetchable/dreambyte://asset/aria.png')
  })

  it('throws when a Cast character is not found', async () => {
    resolveCharacter.mockResolvedValue(null)
    await expect(resolveGuardedFace('p1', { text: 'hi', characterId: 'Ghost' }, cfg('musetalk'))).rejects.toThrow(
      /not found/i,
    )
  })

  it('throws (no silent unconditioned face) when a character ref no longer resolves', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', referenceAssetIds: ['deleted'] })
    primaryReferenceUrl.mockResolvedValue(null)
    await expect(resolveGuardedFace('p1', { text: 'hi', characterId: 'Aria' }, cfg('musetalk'))).rejects.toThrow(
      /no longer exists/i,
    )
  })

  it('explicit sourceImageUrl wins over a character', async () => {
    const out = await resolveGuardedFace(
      'p1',
      { text: 'hi', sourceImageUrl: 'https://cdn/face.png', characterId: 'Aria' },
      cfg('fabric'),
    )
    expect(resolveCharacter).not.toHaveBeenCalled()
    expect(out).toBe('https://fetchable/https://cdn/face.png')
  })

  it('falls back to the config.sourceImageUrl and guards it', async () => {
    const out = await resolveGuardedFace('p1', { text: 'hi' }, cfg('musetalk', 'https://cdn/default.png'))
    expect(out).toBe('https://fetchable/https://cdn/default.png')
  })

  it('does NOT guard for a provider that takes no face image (heygen)', async () => {
    const out = await resolveGuardedFace('p1', { text: 'hi', sourceImageUrl: 'whatever://x' }, cfg('heygen'))
    expect(resolveRef).not.toHaveBeenCalled()
    expect(out).toBe('whatever://x')
  })

  it('returns null when there is no source anywhere', async () => {
    const out = await resolveGuardedFace('p1', { text: 'hi' }, cfg('musetalk'))
    expect(resolveRef).not.toHaveBeenCalled()
    expect(out).toBeNull()
  })
})

// Slice 3: a Cast member speaks in its bound cloned voice. resolveAvatarVoice maps
// characterId → characters.voiceId → cloned_voices row → { provider, providerVoiceId }.
describe('resolveAvatarVoice', () => {
  it('returns null when no characterId is given', async () => {
    expect(await resolveAvatarVoice('p1', { text: 'hi' })).toBeNull()
    expect(resolveCharacter).not.toHaveBeenCalled()
  })

  it('returns null when the character has no bound voice (face-only)', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', voiceId: null, referenceAssetIds: [] })
    expect(await resolveAvatarVoice('p1', { text: 'hi', characterId: 'Aria' })).toBeNull()
    expect(getClonedVoice).not.toHaveBeenCalled()
  })

  it('resolves the bound voice to its provider + providerVoiceId', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', voiceId: 'cv1', referenceAssetIds: ['a'] })
    getClonedVoice.mockResolvedValue({ id: 'cv1', provider: 'elevenlabs', providerVoiceId: 'el_voice' })
    const out = await resolveAvatarVoice('p1', { text: 'hi', characterId: 'Aria' })
    expect(getClonedVoice).toHaveBeenCalledWith('p1', 'cv1')
    expect(out).toEqual({ provider: 'elevenlabs', voiceId: 'el_voice' })
  })

  it('degrades gracefully (null) when the bound voice row no longer exists (dangling)', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', voiceId: 'gone', referenceAssetIds: ['a'] })
    getClonedVoice.mockResolvedValue(null)
    // Null, not a throw — the avatar still generates with the default voice; the face is the hard requirement.
    expect(await resolveAvatarVoice('p1', { text: 'hi', characterId: 'Aria' })).toBeNull()
  })

  it('degrades (null) when the bound voice provider is no longer configured (missing API key)', async () => {
    resolveCharacter.mockResolvedValue({ name: 'Aria', voiceId: 'cv1', referenceAssetIds: ['a'] })
    getClonedVoice.mockResolvedValue({ id: 'cv1', provider: 'elevenlabs', providerVoiceId: 'el_voice' })
    getTTSProviderImpl.mockResolvedValue({ requiresKey: 'ELEVENLABS_API_KEY' })
    const prev = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    try {
      // No opaque auth error mid-generation — fall back to the default voice.
      expect(await resolveAvatarVoice('p1', { text: 'hi', characterId: 'Aria' })).toBeNull()
    } finally {
      if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev
    }
  })
})

// Non-blocking avatar generation (agent path). HeyGen submits + returns a videoId so the
// 1-3 min render never freezes the chat; every other provider stays blocking via generateAvatar.
describe('startAvatarGeneration', () => {
  // resolveAvatarConfig issues up to 3 selects (explicit id → scene → project default).
  // Queue a single hit for the first select; the remaining ones dequeue [] harmlessly.
  const queueConfig = (provider: string, extra: Record<string, any> = {}) =>
    selectRows.push([{ id: 'cfg1', provider, config: { avatarId: 'a1', voiceId: 'v1', ...extra } }])

  it('heygen → submits, returns async + a videoId, and writes a `generating` row (no blocking poll)', async () => {
    queueConfig('heygen')
    const res = await startAvatarGeneration('p1', { text: 'Hello world', sceneId: 's1', avatarConfigId: 'cfg1' })

    expect(res.async).toBe(true)
    if (!res.async) throw new Error('expected async result')
    expect(res.provider).toBe('heygen')
    expect(res.heygenVideoId).toBe('hg-123')
    expect(res.estimatedSeconds).toBe(42)
    expect(res.avatarVideoId).toBeTruthy()

    // Submitted via the async heygen path with the resolved avatarId/voiceId/script — never the blocking poll.
    expect(startHeygenAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ avatarId: 'a1', voiceId: 'v1', script: 'Hello world', projectId: 'p1' }),
    )
    expect(avatarServiceGenerate).not.toHaveBeenCalled()

    // A row was written as `generating` (in-flight), not `ready`.
    expect(inserted).toHaveLength(1)
    expect(inserted[0].status).toBe('generating')
    expect(inserted[0].provider).toBe('heygen')
  })

  it('heygen async path still runs the resolveGuardedFace trust chokepoint (guarded face on the row)', async () => {
    // musetalk-style image guard isn't hit for heygen (requiresImage:false), but the guard
    // RUNS — an explicit source flows through resolveGuardedFace unchanged onto the row.
    queueConfig('heygen', { sourceImageUrl: 'https://cdn/face.png' })
    const res = await startAvatarGeneration('p1', {
      text: 'hi',
      sceneId: 's1',
      avatarConfigId: 'cfg1',
      sourceImageUrl: 'https://cdn/face.png',
    })
    expect(res.async).toBe(true)
    expect(inserted[0].sourceImageUrl).toBe('https://cdn/face.png')
  })

  it('throws when the heygen config is missing avatarId/voiceId', async () => {
    selectRows.push([{ id: 'cfg1', provider: 'heygen', config: {} }])
    await expect(startAvatarGeneration('p1', { text: 'hi', sceneId: 's1', avatarConfigId: 'cfg1' })).rejects.toThrow(
      /avatarId and voiceId/i,
    )
    expect(startHeygenAvatar).not.toHaveBeenCalled()
  })

  it('musetalk → delegates to the blocking generateAvatar, returns sync + the ready row', async () => {
    // musetalk is not heygen → generateAvatar runs TTS; give the impl a generate().
    getTTSProviderImpl.mockResolvedValue({
      generate: async () => ({ audioUrl: 'cache://tts.mp3' }),
    } as any)
    // resolveAvatarGeneration resolves the config once; the sync path then delegates to
    // generateAvatar, which resolves it a second time — queue it twice.
    queueConfig('musetalk')
    queueConfig('musetalk')
    const res = await startAvatarGeneration('p1', { text: 'hi there', sceneId: 's1', avatarConfigId: 'cfg1' })

    expect(res.async).toBe(false)
    if (res.async) throw new Error('expected sync result')
    expect(res.video.status).toBe('ready')
    expect(res.video.videoUrl).toBe('/uploads/avatar.mp4')
    // No heygen submit; it went through AvatarService.generate.
    expect(startHeygenAvatar).not.toHaveBeenCalled()
    expect(avatarServiceGenerate).toHaveBeenCalledTimes(1)
  })

  it('a saved config using the removed local provider fails clearly before TTS or any provider call', async () => {
    const tts = vi.fn()
    getTTSProviderImpl.mockResolvedValue({ generate: tts } as any)
    queueConfig(REMOVED_LOCAL_AVATAR_PROVIDER)
    await expect(startAvatarGeneration('p1', { text: 'hi', sceneId: 's1', avatarConfigId: 'cfg1' })).rejects.toThrow(
      /removed local avatar model/,
    )
    expect(tts).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
    expect(avatarServiceGenerate).not.toHaveBeenCalled()
  })
})

// P1: the FAL-avatar agent path (musetalk/fabric/aurora) bills the per-project apiSpend ledger via
// logSpend('falAvatar', costUsd) — caps read ONLY that ledger, so without this the cap stayed $0.
describe('generateAvatar — FAL-avatar spend commit (P1 cap-evasion fix)', () => {
  beforeEach(() => {
    getTTSProviderImpl.mockResolvedValue({ generate: async () => ({ audioUrl: 'cache://tts.mp3' }) } as any)
  })

  it('commits falAvatar spend with the provider-reported costUsd', async () => {
    // fabric requires an image → config carries one; AvatarService.generate reports a real cost.
    selectRows.push([{ id: 'cfg1', provider: 'fabric', config: { sourceImageUrl: 'https://cdn/face.png' } }])
    avatarServiceGenerate.mockResolvedValueOnce({
      videoUrl: 'fal://clip.mp4',
      durationSeconds: 6,
      costUsd: 0.12,
      provider: 'fabric',
    })
    const out = await generateAvatar('p1', { text: 'hello there', sceneId: 's1', avatarConfigId: 'cfg1' })
    expect(out.status).toBe('ready')
    // billed under the SAME apiName the agent gated on (falAvatar) with the actual cost — not heygen.
    expect(logSpend).toHaveBeenCalledTimes(1)
    expect(logSpend).toHaveBeenCalledWith('p1', 'falAvatar', 0.12, expect.stringContaining('fabric'))
  })

  it('does NOT bill when the provider reports $0 (free/sandbox-like clip)', async () => {
    selectRows.push([{ id: 'cfg1', provider: 'musetalk', config: { sourceImageUrl: 'https://cdn/face.png' } }])
    avatarServiceGenerate.mockResolvedValueOnce({
      videoUrl: 'fal://clip.mp4',
      durationSeconds: 4,
      costUsd: 0,
      provider: 'musetalk',
    })
    await generateAvatar('p1', { text: 'hi', sceneId: 's1', avatarConfigId: 'cfg1' })
    expect(logSpend).not.toHaveBeenCalled()
  })
})
