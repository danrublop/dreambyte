/**
 * Copy text to the clipboard, reliably.
 *
 * `navigator.clipboard` is the fast path, but in the Electron renderer under the
 * custom `dreambyte://` scheme it is frequently `undefined` or permission-gated
 * even though the scheme is registered as a secure context — so a bare
 * `navigator.clipboard.writeText(...)` throws (or rejects) silently and the copy
 * appears to "do nothing". We try it first, then fall back to Electron's native
 * main-process clipboard via the preload bridge, which always works.
 *
 * Returns true if the text was copied by either path.
 */
export async function copyText(text: string): Promise<boolean> {
  // Fast path: the async Clipboard API when it's actually available.
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the native bridge
  }

  // Native path: Electron main-process clipboard (desktop runtime only).
  try {
    const native = typeof window !== 'undefined' ? window.dreambyteApi?.app?.copyText : undefined
    if (native) {
      const res = await native(text)
      return !!res?.ok
    }
  } catch {
    // ignore — nothing else to try
  }

  return false
}
