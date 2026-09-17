// Single source of truth for which TTS providers support voice cloning (Tier 3 Cast), and which
// of those are paid (so the clone must pass a spend gate). Imported by the agent tool definition
// (the provider enum), the gated clone service (spend gate + delete-erasure check), so the lists
// can't drift apart — a provider that implements cloneVoice must appear here exactly once.
//
// Leaf module: no heavy imports, safe to pull into both src/lib/agents/tools.ts (definitions) and
// src/lib/services/voice-clone.ts without dragging service deps into the tool-definitions bundle.

/** Providers with a working cloneVoice() impl. Keep in sync with src/lib/audio/providers/*. */
export const CLONE_CAPABLE_PROVIDERS = ['elevenlabs', 'voxcpm', 'pocket-tts'] as const
export type CloneCapableProvider = (typeof CLONE_CAPABLE_PROVIDERS)[number]

/** Clone-capable providers that bill for the clone → MUST be spend-gated before the call. */
export const PAID_CLONE_PROVIDERS = new Set<string>(['elevenlabs'])

/** Clone-capable providers whose voiceprint lives on the user's own machine — no offsite copy, so a
 *  missing deleteVoice is acceptable on delete (everything else must erase the remote voiceprint). */
export const LOCAL_VOICE_PROVIDERS = new Set<string>(
  CLONE_CAPABLE_PROVIDERS.filter((p) => !PAID_CLONE_PROVIDERS.has(p)),
)
