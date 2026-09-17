// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tier 3 Cast — Slice 2 (T5). The star invariant: NO provider call (and no audio read) happens
// before consent. voice-clone.ts statically imports reference-upload + router + the cloned-voices
// queries, and dynamically imports ./media-gate; vi.mock intercepts all of them.

type AnyFn = (...a: any[]) => any
const resolveBytes = vi.fn<AnyFn>()
vi.mock('@/lib/media/reference-upload', () => ({
  resolveReferenceToBytes: (...a: any[]) => resolveBytes(...a),
}))

const cloneVoice = vi.fn<AnyFn>()
const deleteVoice = vi.fn<AnyFn>()
vi.mock('@/lib/audio/router', () => ({
  getTTSProvider: async () => ({ id: 'elevenlabs', cloneVoice, deleteVoice }),
}))

const getProjectVoiceConsent = vi.fn<AnyFn>()
const recordProjectVoiceConsent = vi.fn<AnyFn>()
const createClonedVoice = vi.fn<AnyFn>()
const getClonedVoice = vi.fn<AnyFn>()
const resolveClonedVoice = vi.fn<AnyFn>()
const deleteClonedVoiceRow = vi.fn<AnyFn>()
vi.mock('@/lib/db/queries/cloned-voices', () => ({
  getProjectVoiceConsent: (...a: any[]) => getProjectVoiceConsent(...a),
  recordProjectVoiceConsent: (...a: any[]) => recordProjectVoiceConsent(...a),
  createClonedVoice: (...a: any[]) => createClonedVoice(...a),
  getClonedVoice: (...a: any[]) => getClonedVoice(...a),
  resolveClonedVoice: (...a: any[]) => resolveClonedVoice(...a),
  deleteClonedVoiceRow: (...a: any[]) => deleteClonedVoiceRow(...a),
}))

const gateMediaSpend = vi.fn<AnyFn>()
vi.mock('./media-gate', () => ({ gateMediaSpend: (...a: any[]) => gateMediaSpend(...a) }))

import { cloneVoiceGated, deleteClonedVoice, VoiceCloneError, type VoiceConsentNeeded } from './voice-clone'

const base = { projectId: 'p1', name: 'My Voice', sampleRef: 'data:audio/mpeg;base64,AAAA', now: new Date(1) }

beforeEach(() => {
  resolveBytes.mockClear().mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/mpeg' })
  cloneVoice.mockClear().mockResolvedValue({ voiceId: 'el_new', name: 'X' })
  deleteVoice.mockClear().mockResolvedValue(undefined)
  getProjectVoiceConsent.mockReset()
  recordProjectVoiceConsent.mockClear().mockResolvedValue(undefined)
  createClonedVoice.mockClear().mockImplementation(async (v: Record<string, unknown>) => ({ id: 'row1', ...v }))
  getClonedVoice.mockReset()
  resolveClonedVoice.mockReset().mockResolvedValue(null) // no name collision by default
  deleteClonedVoiceRow.mockClear().mockResolvedValue({ id: 'row1' })
  gateMediaSpend.mockClear().mockResolvedValue(null)
})

describe('cloneVoiceGated — consent fail-closed (the star invariant)', () => {
  it('returns consentNeeded (in-chat card) and NEVER reads audio or calls the provider when no consent exists', async () => {
    getProjectVoiceConsent.mockResolvedValue(null)
    const out = await cloneVoiceGated({ ...base })
    expect(out).toHaveProperty('consentNeeded')
    expect((out as VoiceConsentNeeded).consentNeeded.destination).toBe('ElevenLabs (US)')
    expect(resolveBytes).not.toHaveBeenCalled() // audio never read (still fail-closed)
    expect(cloneVoice).not.toHaveBeenCalled() // provider never touched
    expect(recordProjectVoiceConsent).not.toHaveBeenCalled()
  })

  it('with a fresh acknowledgement: records consent, guards the sample, clones, persists', async () => {
    getProjectVoiceConsent
      .mockResolvedValueOnce(null) // no consent yet
      .mockResolvedValueOnce({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    const out = await cloneVoiceGated({ ...base, consent: { acknowledged: true } })
    expect(recordProjectVoiceConsent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', destination: 'ElevenLabs (US)' }),
    )
    expect(resolveBytes).toHaveBeenCalledWith('data:audio/mpeg;base64,AAAA', undefined, { kind: 'audio' })
    expect(cloneVoice).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Voice' }))
    expect((out as { providerVoiceId: string }).providerVoiceId).toBe('el_new')
  })

  it('with remembered project consent: clones without a fresh acknowledgement', async () => {
    getProjectVoiceConsent.mockResolvedValue({
      projectId: 'p1',
      version: 'v1',
      destination: 'ElevenLabs (US)',
      consentAt: new Date(1),
    })
    const out = await cloneVoiceGated({ ...base })
    expect(recordProjectVoiceConsent).not.toHaveBeenCalled() // reused, not re-recorded
    expect(cloneVoice).toHaveBeenCalled()
    expect((out as { consentVersion: string }).consentVersion).toBe('v1')
  })

  it('a denied spend gate blocks the clone (no provider call)', async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    gateMediaSpend.mockResolvedValue({ denied: true, reason: 'ElevenLabs disabled' })
    await expect(cloneVoiceGated({ ...base })).rejects.toThrow(/disabled/)
    expect(cloneVoice).not.toHaveBeenCalled()
  })

  it("an 'ask' spend gate returns permissionNeeded (renderer pops the modal)", async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    gateMediaSpend.mockResolvedValue({ ask: true, permissionNeeded: { api: 'elevenLabs' } })
    const out = await cloneVoiceGated({ ...base })
    expect(out).toEqual({ permissionNeeded: { api: 'elevenLabs' } })
    expect(cloneVoice).not.toHaveBeenCalled()
  })

  it('skipPermissionGate bypasses the spend gate (agent pre-gated)', async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    await cloneVoiceGated({ ...base, skipPermissionGate: true })
    expect(gateMediaSpend).not.toHaveBeenCalled()
    expect(cloneVoice).toHaveBeenCalled()
  })

  it('a rejected sample (SSRF/oversized/non-audio) surfaces as VoiceCloneError', async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    resolveBytes.mockRejectedValueOnce(new Error('Reference audio too large'))
    await expect(cloneVoiceGated({ ...base })).rejects.toBeInstanceOf(VoiceCloneError)
    expect(cloneVoice).not.toHaveBeenCalled()
  })

  it('re-prompts (consentNeeded) when stored consent is an OLDER version, even if destination matches', async () => {
    // Destination consented, but under a stale version → must re-acknowledge, never reuse stale consent.
    getProjectVoiceConsent.mockResolvedValue({
      projectId: 'p1',
      version: 'v0-old',
      destination: 'ElevenLabs (US)',
      consentAt: new Date(1),
    })
    const out = await cloneVoiceGated({ ...base })
    expect(out).toHaveProperty('consentNeeded')
    expect(cloneVoice).not.toHaveBeenCalled()
  })

  it('records consent at the SERVER version, ignoring a caller-supplied version', async () => {
    getProjectVoiceConsent.mockResolvedValueOnce(null).mockResolvedValueOnce({
      projectId: 'p1',
      version: 'v1',
      destination: 'ElevenLabs (US)',
      consentAt: new Date(1),
    })
    await cloneVoiceGated({ ...base, consent: { acknowledged: true, version: 'v999-forged' } })
    expect(recordProjectVoiceConsent).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1' }))
  })

  it('rejects a duplicate name BEFORE the paid provider clone (no orphaned voiceprint)', async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    resolveClonedVoice.mockResolvedValue({ id: 'existing', name: 'My Voice' })
    await expect(cloneVoiceGated({ ...base })).rejects.toThrow(/already exists/)
    expect(cloneVoice).not.toHaveBeenCalled() // never created a billable remote voiceprint
  })

  it('rolls back the remote voiceprint if the row INSERT fails (race lost the name)', async () => {
    getProjectVoiceConsent.mockResolvedValue({ projectId: 'p1', version: 'v1', destination: 'ElevenLabs (US)', consentAt: new Date(1) })
    createClonedVoice.mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
    await expect(cloneVoiceGated({ ...base })).rejects.toThrow(/rolled back/)
    expect(deleteVoice).toHaveBeenCalledWith('el_new') // remote voiceprint erased on persist failure
  })
})

describe('deleteClonedVoice — hard delete (remote first, then local)', () => {
  it('deletes the remote voiceprint BEFORE removing the local row', async () => {
    const order: string[] = []
    getClonedVoice.mockResolvedValue({ id: 'row1', provider: 'elevenlabs', providerVoiceId: 'el_del' })
    deleteVoice.mockImplementation(async () => {
      order.push('remote')
    })
    deleteClonedVoiceRow.mockImplementation(async () => {
      order.push('local')
      return { id: 'row1' }
    })
    await deleteClonedVoice('p1', 'row1')
    expect(deleteVoice).toHaveBeenCalledWith('el_del')
    expect(order).toEqual(['remote', 'local'])
  })

  it('keeps the local row if the remote delete fails (no false erasure)', async () => {
    getClonedVoice.mockResolvedValue({ id: 'row1', provider: 'elevenlabs', providerVoiceId: 'el_del' })
    deleteVoice.mockRejectedValueOnce(new Error('ElevenLabs voice delete error (500)'))
    await expect(deleteClonedVoice('p1', 'row1')).rejects.toThrow(/delete error/)
    expect(deleteClonedVoiceRow).not.toHaveBeenCalled() // row kept for retry
  })

  it('throws when the voice is not found', async () => {
    getClonedVoice.mockResolvedValue(null)
    await expect(deleteClonedVoice('p1', 'nope')).rejects.toBeInstanceOf(VoiceCloneError)
  })
})
