/**
 * Gated lip-sync generation (Cinema Studio / Tier 1 C — the "Lipsync studio").
 *
 * Turns a face image + narration text into a presenter video clip, reusing the fal avatar
 * providers (MuseTalk / Fabric / Aurora) that already do image+audio→video. The flow is two paid
 * steps, each gated + ledgered: (1) text → server TTS audio, (2) face + audio → fal avatar video.
 *
 * Distinct from the agent's `generateAvatar` (src/lib/services/avatar.ts), which is coupled to the
 * `avatarConfigs`/`avatarVideos` tables + placement; the studio just wants a clip to composite as a
 * video layer, so it calls the providers directly with a chosen provider id.
 *
 * fal needs a FETCHABLE audio_url, but TTS writes a local /audio file — so both the face image and
 * the TTS audio are run through `resolveReferenceToFetchableUrl` (uploads to fal storage) first.
 */

import type { APIName } from '@/lib/types/permissions'
import type { MediaPermissionNeeded } from './media-gate'

export interface LipsyncGenInput {
  projectId?: string
  /** 'musetalk' | 'fabric' | 'aurora' — a fal avatar provider. */
  provider: string
  /** Face reference (data URL / app URL / http) — the still or video to animate. */
  sourceImageUrl: string
  /** Narration text → synthesized to speech (server TTS), unless audioUrl is supplied. */
  text: string
  /** Optional pre-made audio (skip TTS). A reference resolvable to a fetchable URL. */
  audioUrl?: string
  /** Optional TTS voice id for the narration (server TTS providers). Default voice when omitted. */
  voiceId?: string
  /** Optional explicit server TTS provider; falls back to getBestTTSProvider() when omitted. */
  ttsProvider?: string
  /** Re-dispatch flag set after the user approves the always-ask modal — proceed past the prompt
   *  on BOTH the avatar and TTS gates (never past a 'deny'). */
  approvedAsk?: boolean
}

export interface LipsyncGenResult {
  videoUrl: string
  durationSeconds: number
  /** The LOCAL narration audio URL (the TTS output, or the supplied audio). The fal avatar bakes
   *  this into the clip's lip motion, but the avatar `<video>` renders muted (+ export muxes audio
   *  TRACKS, not video-baked audio) — so the caller attaches THIS as a paired scene audio track,
   *  synced at the same start, so the speech is actually heard in preview + export. */
  audioUrl: string
}

const FAL_AVATAR: APIName = 'falAvatar'
// Only the fal avatar providers are reachable via the lipsync studio. The renderer-supplied id must
// not reach heygen (different transport + spend model than the falAvatar gate assumes).
const LIPSYNC_PROVIDERS = new Set(['musetalk', 'fabric', 'aurora'])

const TTS_TIMEOUT_MS = 90_000
const AVATAR_TIMEOUT_MS = 240_000

// The fal avatar call is synchronous-by-result (fal.subscribe), with no client-side timeout — a
// network stall would otherwise pin the layer on 'generating' forever (no poller to recover it).
// Race a timeout so a stall surfaces as an error and the layer recovers. The underlying call may
// keep running orphaned on the provider; that's acceptable (the user is unblocked).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout])
}

export async function generateLipsyncAsset(
  input: LipsyncGenInput,
): Promise<LipsyncGenResult | { error: string } | { permissionNeeded: MediaPermissionNeeded }> {
  if (!input.sourceImageUrl) return { error: 'A face image is required for lipsync.' }
  if (!input.text && !input.audioUrl) return { error: 'Narration text (or an audio source) is required.' }
  if (!LIPSYNC_PROVIDERS.has(input.provider)) return { error: `Unsupported lipsync provider: ${input.provider}` }
  // Fail fast on a missing key BEFORE the paid TTS step (the fal avatar call needs FAL_KEY).
  if (!process.env.FAL_KEY) return { error: 'Lipsync needs FAL_KEY configured for the avatar provider.' }

  const { gateMediaSpend } = await import('./media-gate')
  const { resolveReferenceToFetchableUrl } = await import('@/lib/media/reference-upload')

  // Gate the avatar (dominant) cost up front — deny (cap/disabled) before any paid work; an 'ask'
  // surfaces permissionNeeded so the renderer pops the always-ask modal (approval re-dispatches
  // with approvedAsk:true, which clears BOTH the avatar and TTS prompts but never a 'deny').
  const avatarGate = await gateMediaSpend(
    input.projectId,
    FAL_AVATAR,
    { prompt: input.text, model: input.provider },
    { surfaceAsk: true, approvedAsk: input.approvedAsk },
  )
  if (avatarGate && 'denied' in avatarGate) return { error: avatarGate.reason }
  if (avatarGate && 'ask' in avatarGate) return { permissionNeeded: avatarGate.permissionNeeded }

  // ── 1. Resolve the FACE first (cheap, no $ charge) — a bad/unreadable face must NOT cost a TTS call.
  let sourceImageUrl: string
  try {
    sourceImageUrl = await resolveReferenceToFetchableUrl(input.sourceImageUrl)
  } catch (e) {
    return { error: `Could not prepare the face image: ${(e as Error).message}` }
  }

  // ── 2. Audio: use the supplied track, else synthesize from text via a SERVER TTS provider ──
  let audioRef = input.audioUrl
  if (!audioRef) {
    const { getBestTTSProvider, getTTSProvider } = await import('@/lib/audio/router')
    const ttsProvider = (input.ttsProvider as Parameters<typeof getTTSProvider>[0]) || getBestTTSProvider()
    if (ttsProvider === 'web-speech' || ttsProvider === 'puter') {
      return {
        error:
          'Lipsync needs a server TTS provider (ElevenLabs / OpenAI / Gemini / Google). Configure one in audio settings.',
      }
    }
    const { ttsApiNameFor } = await import('@/lib/audio/audio-models')
    const ttsApi = ttsApiNameFor(ttsProvider)
    if (ttsApi) {
      const ttsGate = await gateMediaSpend(
        input.projectId,
        ttsApi,
        { prompt: input.text, model: ttsProvider },
        { surfaceAsk: true, approvedAsk: input.approvedAsk },
      )
      if (ttsGate && 'denied' in ttsGate) return { error: ttsGate.reason }
      if (ttsGate && 'ask' in ttsGate) return { permissionNeeded: ttsGate.permissionNeeded }
    }
    try {
      const impl = await getTTSProvider(ttsProvider)
      const tts = await withTimeout(
        impl.generate({ text: input.text, sceneId: 'lipsync-gen', voiceId: input.voiceId || undefined }),
        TTS_TIMEOUT_MS,
        'Speech synthesis',
      )
      audioRef = tts.audioUrl
    } catch (e) {
      return { error: `Speech synthesis failed: ${(e as Error).message}` }
    }
    await commitSpend(input.projectId, ttsApi, input.text, `${ttsProvider}: ${input.text.slice(0, 60)}`)
  }

  // ── 3. Resolve the audio to a fetchable URL (fal fetches it server-side) ──
  // Resolve AS audio: a data:/local audio ref must pass the audio mime allowlist + cap, not be
  // rejected as a non-image (the default kind was 'image', which threw on an audio data: URL).
  let fetchableAudio: string
  try {
    fetchableAudio = await resolveReferenceToFetchableUrl(audioRef, undefined, { kind: 'audio' })
  } catch (e) {
    return { error: `Could not prepare the narration audio: ${(e as Error).message}` }
  }

  // ── 4. fal avatar provider: face + audio → talking video ──
  const { AvatarService } = await import('@/lib/avatar')
  const provider = AvatarService.getProvider(input.provider)
  const wordCount = input.text ? input.text.split(/\s+/).filter(Boolean).length : 0
  const estimatedDuration = Math.max(2, Math.ceil((wordCount / 150) * 60))

  try {
    const result = await withTimeout(
      provider.generate(
        {
          text: input.text,
          audioUrl: fetchableAudio,
          sourceImageUrl,
          durationSeconds: estimatedDuration,
          projectId: input.projectId ?? '',
        },
        {},
      ),
      AVATAR_TIMEOUT_MS,
      'Lipsync',
    )
    if (!result.videoUrl) return { error: 'Lipsync provider returned no video.' }
    // Commit the avatar spend (actual provider cost if it reported one, else the per-provider estimate).
    if (input.projectId) {
      const { logSpend } = await import('@/lib/db')
      const cost = result.costUsd && result.costUsd > 0 ? result.costUsd : provider.estimateCost(estimatedDuration)
      if (cost > 0) await logSpend(input.projectId, FAL_AVATAR, cost, `${input.provider}: ${input.text.slice(0, 60)}`)
    }
    // Return the LOCAL audio so the caller can attach it as a paired (audible) scene track.
    return {
      videoUrl: result.videoUrl,
      durationSeconds: result.durationSeconds || estimatedDuration,
      audioUrl: audioRef,
    }
  } catch (e) {
    return { error: `Lipsync generation failed: ${(e as Error).message}` }
  }
}

async function commitSpend(
  projectId: string | undefined,
  apiName: APIName | null,
  prompt: string,
  label: string,
): Promise<void> {
  if (!apiName || !projectId) return
  const { logSpend } = await import('@/lib/db')
  const { estimateApiCostUsd } = await import('@/lib/permissions')
  const cost = estimateApiCostUsd(apiName, { prompt })
  if (cost > 0 && Number.isFinite(cost)) await logSpend(projectId, apiName, cost, label)
}
