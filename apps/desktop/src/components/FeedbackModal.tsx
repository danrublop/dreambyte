'use client'

import { useEffect, useState } from 'react'
import { X, Loader2, CheckCircle2, Info } from 'lucide-react'

/**
 * In-app feedback widget. A themed modal with a message field, optional
 * email, an auto-captured (downscaled) screenshot toggle with thumbnail, and
 * app/OS version metadata appended to every submission.
 *
 * Delivery: POSTs to NEXT_PUBLIC_FEEDBACK_URL when configured; otherwise falls
 * back to opening a prefilled mailto: so feedback is never silently dropped —
 * the widget is honest about where the message goes.
 *
 * Screenshot capture + version come from the Electron bridge; both degrade
 * gracefully (no thumbnail / "unknown" version) in the web build.
 */

const FEEDBACK_URL = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_FEEDBACK_URL : undefined
const FEEDBACK_EMAIL = 'feedback@dreambyte.app'

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [includeScreenshot, setIncludeScreenshot] = useState(true)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [version, setVersion] = useState<string>('unknown')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const osLabel = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : 'unknown'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Capture BEFORE the user starts typing so the shot reflects the editor, and
  // read the app version. Both via the Electron bridge; no-ops on web.
  useEffect(() => {
    let cancelled = false
    const appApi = (
      window as unknown as {
        dreambyteApi?: {
          app?: {
            captureWindow?: () => Promise<{ dataUrl: string | null }>
            getVersion?: () => Promise<{ version: string }>
          }
        }
      }
    ).dreambyteApi?.app
    void (async () => {
      try {
        const [shot, ver] = await Promise.all([appApi?.captureWindow?.(), appApi?.getVersion?.()])
        if (cancelled) return
        if (shot?.dataUrl) setScreenshot(shot.dataUrl)
        if (ver?.version) setVersion(ver.version)
      } catch {
        // Capture / version are best-effort.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = message.trim()
  const canSubmit = !sending && trimmed.length > 0

  const submit = async () => {
    if (!canSubmit) return
    setError(null)
    setSending(true)
    const metadata = { appVersion: version, os: osLabel }
    try {
      if (FEEDBACK_URL) {
        const res = await fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: trimmed,
            email: email.trim() || null,
            screenshot: includeScreenshot ? screenshot : null,
            ...metadata,
          }),
        })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)
      } else {
        // No backend configured — fall back to a prefilled email so the message
        // is never lost. (Screenshots can't ride along a mailto:.)
        const body = `${trimmed}\n\n---\nApp version: ${version}\nOS: ${osLabel}${
          email.trim() ? `\nReply to: ${email.trim()}` : ''
        }`
        const href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
          'Dreambyte feedback',
        )}&body=${encodeURIComponent(body)}`
        window.open(href, '_blank')
      }
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send feedback.')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[9999] bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Send feedback"
        className="fixed top-1/2 left-1/2 z-[10000] flex max-h-[85vh] w-[min(480px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Send feedback</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--color-border)]/40"
          >
            <X size={15} className="text-[var(--color-text-muted)]" />
          </button>
        </div>

        {sent ? (
          <div className="flex flex-col gap-3 px-5 py-6">
            <div className="flex items-center gap-2 text-[var(--color-text-primary)]">
              <CheckCircle2 size={16} className="text-[var(--success)]" />
              <span className="text-[14px] font-medium">Thanks for the feedback.</span>
            </div>
            <p className="text-[12px] text-[var(--color-text-muted)]">We read every message.</p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="no-style rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="custom-scrollbar flex flex-col gap-4 overflow-y-auto px-5 py-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[var(--color-text-primary)]">
                Describe the issue or feedback
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                autoFocus
                maxLength={10000}
                placeholder="What happened, or what would you like to see?"
                className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[var(--color-text-primary)]">Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com — so we can reply"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            {screenshot && (
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-primary)]">
                  <input
                    type="checkbox"
                    checked={includeScreenshot}
                    onChange={(e) => setIncludeScreenshot(e.target.checked)}
                  />
                  Include screenshot
                </label>
                <img
                  src={screenshot}
                  alt="Screenshot preview"
                  className="h-12 w-20 rounded border border-[var(--color-border)] object-cover"
                  style={{ opacity: includeScreenshot ? 1 : 0.4 }}
                />
              </div>
            )}

            <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <Info size={12} className="mt-px shrink-0" />
              <span>
                App version {version} and your OS are included.
                {!FEEDBACK_URL && ' Opens your email client to send.'}
              </span>
            </div>

            {error && <p className="text-[12px] text-[var(--danger,#ef4444)]">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={sending}
                className="no-style rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-muted)] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="no-style flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {sending && <Loader2 size={12} className="animate-spin" />}
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
