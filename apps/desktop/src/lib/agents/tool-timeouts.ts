/**
 * Tool timeout tiers — the SINGLE definition shared by the in-app runner
 * (tool-executor.ts) and the MCP bridge (mcp-adapter.ts).
 *
 * Why a leaf module: importing tool-executor would run its tool-registration
 * side effects, so the MCP bridge can't pull the values from there. Keeping the
 * raw numbers here lets both sides derive from one source — closing the
 * "in-app says 180s, MCP fetch aborts at 130s → orphaned, double-billed asset"
 * divergence. Pure constants, no imports.
 */

/** Default per-tool failure ceiling. */
export const TOOL_TIMEOUT_MS = 60_000
/** LLM-backed generation tools (write_scene_code, add_layer, …). */
export const GENERATION_TOOL_TIMEOUT_MS = 120_000
/**
 * Paid MEDIA generation (image / TTS / music / avatar / dub / voice-clone). A
 * real provider round-trip — download + encode + multi-second synthesis — that
 * regularly exceeds the generation tier. Timing one out throws → rollback,
 * orphaning a paid asset the provider already billed. This is a failure
 * ceiling, not an expected duration.
 */
export const MEDIA_GEN_TOOL_TIMEOUT_MS = 180_000

/**
 * Transport headroom for the MCP bridge fetch: the client fetch must outlast
 * the server's own tool deadline so the SERVER's result (success or honest
 * timeout) comes back, rather than the CLIENT aborting first and retrying a
 * call that may have already billed.
 */
export const MCP_BRIDGE_MARGIN_MS = 15_000
