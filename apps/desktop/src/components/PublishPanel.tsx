'use client'

import { useState } from 'react'
import { X, Copy, ExternalLink, Check } from 'lucide-react'
import { copyText } from '@/lib/utils/copy-text'

interface PublishPanelProps {
  url: string
  onClose: () => void
}

/**
 * Script embed for the @dreambyte/player runtime. The publish bundle is served
 * from /published/<projectId>/ (scene htmlUrls in manifest.json are rooted
 * there) and includes player.js, the built IIFE from packages/player.
 */
export function buildScriptEmbedSnippet(url: string): string {
  const base = `/published/${url.split('/').filter(Boolean).pop()}`
  return `<script src="${base}/player.js"></script>
<div id="dreambyte-player" style="width:100%;aspect-ratio:16/9"></div>
<script>
  new DreambyteStudioPlayer(document.getElementById('dreambyte-player'), { autoplay: true })
    .load('${base}/manifest.json');
</script>`
}

export default function PublishPanel({ url, onClose }: PublishPanelProps) {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (text: string, key: string) => {
    // copyText covers navigator.clipboard + the native Electron bridge; the
    // execCommand path stays as a last resort for a pure-browser context.
    const ok = await copyText(text)
    if (!ok) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const iframeSnippet = `<iframe src="${url}" width="1280" height="720" frameborder="0" allowfullscreen></iframe>`

  const responsiveSnippet = `<div style="position:relative;padding-bottom:56.25%;height:0">
  <iframe src="${url}" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen></iframe>
</div>`

  const scriptSnippet = buildScriptEmbedSnippet(url)

  const CopyButton = ({ value, copyKey }: { value: string; copyKey: string }) => (
    <button
      onClick={() => copy(value, copyKey)}
      className="kbd h-7 px-2 flex items-center gap-1 text-[12px] font-bold shrink-0"
    >
      {copied === copyKey ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
      {copied === copyKey ? 'Copied!' : 'Copy'}
    </button>
  )

  return (
    <div className="fixed inset-0 z-[500] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <span className="text-green-400 text-lg">✅</span>
            <h2 className="text-sm font-bold text-[var(--color-text-primary)]">
              Published! Share or embed your interactive explainer.
            </h2>
          </div>
          <button onClick={onClose} className="kbd w-7 h-7 p-0 flex items-center justify-center">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Direct link */}
          <div>
            <p className="text-[12px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Direct link
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm text-[var(--color-text-primary)] font-mono truncate">
                {url}
              </div>
              <CopyButton value={url} copyKey="link" />
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="kbd h-7 w-7 p-0 flex items-center justify-center"
              >
                <ExternalLink size={12} />
              </a>
            </div>
          </div>

          {/* Iframe embed */}
          <div>
            <p className="text-[12px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Embed on your website
            </p>
            <div className="flex gap-2">
              <div className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[11px] text-[var(--color-text-muted)] font-mono break-all leading-relaxed">
                {iframeSnippet}
              </div>
              <CopyButton value={iframeSnippet} copyKey="iframe" />
            </div>
          </div>

          {/* Responsive embed */}
          <div>
            <p className="text-[12px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Responsive embed
            </p>
            <div className="flex gap-2">
              <div className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[11px] text-[var(--color-text-muted)] font-mono whitespace-pre leading-relaxed overflow-x-auto">
                {responsiveSnippet}
              </div>
              <CopyButton value={responsiveSnippet} copyKey="responsive" />
            </div>
          </div>

          {/* Script embed */}
          <div>
            <p className="text-[12px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">
              Script embed (React/Vue/etc)
            </p>
            <div className="flex gap-2">
              <div className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[11px] text-[var(--color-text-muted)] font-mono whitespace-pre leading-relaxed overflow-x-auto">
                {scriptSnippet}
              </div>
              <CopyButton value={scriptSnippet} copyKey="script" />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button onClick={onClose} className="kbd h-8 px-4 text-sm font-bold text-[var(--color-text-muted)]">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
