/**
 * Validate a user-configured local-model endpoint (Ollama / LM Studio / etc.)
 * before it is interpolated into fetch(). Without this, a malformed or
 * non-http(s) baseUrl flows straight into fetch and the parsed response is
 * auto-added as model config. We only enforce scheme +
 * well-formedness — not a host allowlist — because users legitimately point at
 * a LAN host, not just localhost.
 */
export function safeLocalEndpoint(baseUrl: string | undefined | null, fallback = 'http://localhost:11434'): string {
  const candidate = (baseUrl ?? '').trim() || fallback
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback
    return candidate.replace(/\/+$/, '') // normalize trailing slash
  } catch {
    return fallback
  }
}
