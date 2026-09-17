// Tier 3 Cast (Slice 2) — the consent-gated voice-clone service. The ONE path the agent tool and
// the Electron IPC both call, so consent + trust guard + spend gate are enforced in exactly one
// place (mirrors Slice 1's single guarded resolveGuardedFace chokepoint).
//
// Consent granularity: ONCE PER PROJECT, then remembered. The first clone in a project requires an
// explicit acknowledgement; later clones reuse the stored project consent. Consent is checked
// FAIL-CLOSED, before the audio is read or any provider is touched — see cloneVoiceGated step 1.

import { resolveReferenceToBytes } from '@/lib/media/reference-upload'
import { getTTSProvider } from '@/lib/audio/router'
import type { TTSProvider } from '@/lib/types'
import {
  createClonedVoice,
  getClonedVoice,
  resolveClonedVoice,
  deleteClonedVoiceRow,
  getProjectVoiceConsent,
  recordProjectVoiceConsent,
  type ClonedVoiceRow,
} from '@/lib/db/queries/cloned-voices'
import type { MediaPermissionNeeded } from './media-gate'
import { PAID_CLONE_PROVIDERS, LOCAL_VOICE_PROVIDERS } from '@/lib/audio/voice-clone-providers'

export class ConsentError extends Error {
  readonly code = 'CONSENT' as const
}
export class VoiceCloneError extends Error {}

/** Version of the consent text the user accepts. Bump when the wording/scope changes. */
export const VOICE_CLONE_CONSENT_VERSION = 'v1'

export const VOICE_CLONE_CONSENT_TEXT =
  'Cloning a voice uploads your audio sample to a third-party provider to create a reusable ' +
  'voiceprint. Only upload a voice you have the right to clone. You can delete the voice later, ' +
  'which also removes it from the provider.'

/** The named third-party destination recorded with consent + each clone (audit + UI display). */
export function consentDestinationFor(provider: TTSProvider | string): string {
  switch (provider) {
    case 'elevenlabs':
      return 'ElevenLabs (US)'
    case 'voxcpm':
      return 'VoxCPM (local)'
    default:
      return String(provider)
  }
}

export interface CloneVoiceInput {
  projectId: string
  name: string
  /** A reference to the audio sample: data: URL, http(s) URL, or /uploads path. */
  sampleRef: string
  /** Defaults to 'elevenlabs' (the primary paid path). 'voxcpm' is the local fallback. */
  provider?: TTSProvider
  /** Present only when the user just acknowledged consent (first clone per project, or a new
   *  destination). Omitted on later clones once the project consent is remembered. */
  consent?: { acknowledged: boolean; version?: string }
  /** Skip the spend gate — the agent tool pre-gates (checkApiPermission). The renderer IPC NEVER
   *  sets it, so in-app cloning is gated by project policy + caps. Mirrors reuseCharacter. */
  skipPermissionGate?: boolean
  /** Re-dispatch flag after the user approves the always-ask modal (satisfies 'ask', never 'deny'). */
  approvedAsk?: boolean
  /** Stamped on consent + the row. Injectable for deterministic tests (the app passes new Date()). */
  now?: Date
}

/** Surfaced as an in-chat consent card (mirrors permissionNeeded) when biometric consent for the
 *  destination hasn't been given. Fail-closed: returned BEFORE any audio read or provider call, so
 *  no sample leaves the machine until the user acknowledges. Approving the card records consent for
 *  (project, destination) and resumes the run, which then proceeds past this gate. */
export interface VoiceConsentNeeded {
  consentNeeded: {
    destination: string
    version: string
    consentText: string
    voiceName: string
  }
}

export type CloneVoiceResult = ClonedVoiceRow | { permissionNeeded: MediaPermissionNeeded } | VoiceConsentNeeded

/**
 * Clone a voice with consent + trust guard + spend gate enforced in order:
 *   1. CONSENT (fail-closed, before any audio/provider work)
 *   2. trust-guard the sample bytes ({ kind: 'audio' })
 *   3. spend gate (elevenLabs bucket) unless the caller pre-gated
 *   4. provider clone
 *   5. persist the clonedVoices row with the consent audit
 */
export async function cloneVoiceGated(input: CloneVoiceInput): Promise<CloneVoiceResult> {
  if (!input.projectId) throw new VoiceCloneError('projectId is required')
  const name = String(input.name ?? '').trim()
  if (!name) throw new VoiceCloneError('A voice name is required')
  const provider = (input.provider ?? 'elevenlabs') as TTSProvider
  const destination = consentDestinationFor(provider)
  const now = input.now ?? new Date()

  // 0. Reject a duplicate name BEFORE the paid provider clone. The cloned_voices unique index
  //    (project_id, lower(name)) would otherwise throw at INSERT in step 5 — AFTER step 4 already
  //    created a billable remote voiceprint, leaving it orphaned with no row to delete it through.
  if (await resolveClonedVoice(input.projectId, name)) {
    throw new VoiceCloneError(`A cloned voice named "${name}" already exists in this project`)
  }

  // 1. CONSENT — fail-closed. Checked BEFORE the audio is read or any provider/network is touched,
  //    so a missing acknowledgement can never leak a biometric sample to a third party.
  const existing = await getProjectVoiceConsent(input.projectId, destination)
  // Covered only if THIS destination is consented AND under the CURRENT consent version — a version
  // bump (wording/scope change) must force a fresh acknowledgement, otherwise the version field is
  // decorative and a scope change silently reuses stale consent.
  const consentCoversDestination = !!existing && existing.version === VOICE_CLONE_CONSENT_VERSION
  if (!consentCoversDestination) {
    if (!input.consent?.acknowledged) {
      // Surface an in-chat consent card (like the generation permission card) instead of throwing.
      // Still fail-closed — we return BEFORE reading the audio or calling any provider, so nothing
      // leaves the machine. Approving the card records consent + resumes the run past this gate.
      return {
        consentNeeded: {
          destination,
          version: VOICE_CLONE_CONSENT_VERSION,
          consentText: VOICE_CLONE_CONSENT_TEXT,
          voiceName: name,
        },
      }
    }
    // The server's current version is authoritative — never trust a caller-supplied version (a stale
    // or forged version must not let an old acknowledgement satisfy a newer consent scope).
    await recordProjectVoiceConsent({
      projectId: input.projectId,
      destination,
      version: VOICE_CLONE_CONSENT_VERSION,
      consentAt: now,
    })
  }
  // The consent record now in effect (just-recorded or remembered) for THIS destination stamps the
  // row's audit — accurate per-destination, never overwritten by a later consent to another provider.
  const consentRecord = await getProjectVoiceConsent(input.projectId, destination)
  if (!consentRecord) throw new ConsentError('Consent record could not be established') // defensive

  // 2. Trust-guard the sample bytes (SSRF/path/size + audio mime allowlist). Audio kind so an
  //    audio data:/local ref isn't rejected as a non-image.
  let bytes: Buffer
  let mimeType: string
  try {
    ;({ bytes, mimeType } = await resolveReferenceToBytes(input.sampleRef, undefined, { kind: 'audio' }))
  } catch (e) {
    throw new VoiceCloneError(`Voice sample rejected: ${(e as Error).message}`)
  }

  // 3. Spend gate (project policy + caps) under the existing elevenLabs bucket, unless pre-gated.
  // Gate every PAID clone provider (not just the literal 'elevenlabs'), so adding a future paid
  // provider to PAID_CLONE_PROVIDERS automatically gates it instead of silently bypassing the cap.
  if (!input.skipPermissionGate && PAID_CLONE_PROVIDERS.has(provider)) {
    const { gateMediaSpend } = await import('./media-gate')
    const g = await gateMediaSpend(
      input.projectId,
      'elevenLabs',
      { model: 'voice-clone', prompt: name },
      { surfaceAsk: true, approvedAsk: input.approvedAsk },
    )
    if (g && 'denied' in g) throw new VoiceCloneError(g.reason)
    if (g && 'ask' in g) return { permissionNeeded: g.permissionNeeded }
  }

  // 4. Provider clone (raw biometric bytes go here, never persisted at rest).
  const impl = await getTTSProvider(provider)
  if (!impl.cloneVoice) throw new VoiceCloneError(`Provider "${provider}" does not support voice cloning`)
  const cloned = await impl.cloneVoice({ name, audioBuffer: bytes, mode: 'controllable' })

  // 5. Persist the row with the consent audit. Sample metadata only — never the audio. If the INSERT
  //    fails (e.g. a concurrent clone won the same name despite the step-0 pre-check), roll back the
  //    remote voiceprint so we never leave a billable, un-erasable orphan at the provider.
  try {
    return await createClonedVoice({
      projectId: input.projectId,
      name,
      provider,
      providerVoiceId: cloned.voiceId,
      sampleMime: mimeType,
      sampleBytes: bytes.length,
      consentAt: consentRecord.consentAt,
      consentVersion: consentRecord.version,
      consentDestination: destination,
    })
  } catch (e) {
    if (impl.deleteVoice) {
      try {
        await impl.deleteVoice(cloned.voiceId)
      } catch {
        // Best-effort rollback; surface the original persist error regardless.
      }
    }
    throw new VoiceCloneError(`Failed to save cloned voice (remote voiceprint rolled back): ${(e as Error).message}`)
  }
}

/**
 * Hard-delete a cloned voice: erase the remote voiceprint FIRST (right-to-erasure), then remove the
 * local row. Provider delete is fail-loud — if it errors, the row is kept so the user can retry,
 * never reporting an erasure that didn't reach the third party.
 */
export async function deleteClonedVoice(projectId: string, id: string): Promise<void> {
  const row = await getClonedVoice(projectId, id)
  if (!row) throw new VoiceCloneError('Cloned voice not found')
  const impl = await getTTSProvider(row.provider as TTSProvider)
  if (impl.deleteVoice) {
    await impl.deleteVoice(row.providerVoiceId) // fail-loud: throws → row kept, retry possible
  } else if (!LOCAL_VOICE_PROVIDERS.has(row.provider)) {
    // An offsite provider with no delete capability must NOT be reported as erased — that would
    // claim a third-party biometric voiceprint was removed when it wasn't. Keep the row, fail loud.
    throw new VoiceCloneError(
      `Provider "${row.provider}" cannot delete its remote voiceprint — refusing to report erasure. Remove it manually at the provider.`,
    )
  }
  // Local providers (no offsite copy) fall through: just remove the row.
  await deleteClonedVoiceRow(projectId, id)
}
