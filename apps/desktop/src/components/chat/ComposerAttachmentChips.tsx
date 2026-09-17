'use client'

import type { Dispatch, SetStateAction } from 'react'
import { FileText, X } from 'lucide-react'
import type { ImageAttachment, ReferenceMedia } from '@/lib/agents/types'
import type { PreviewImage } from './ImageLightbox'

type PendingAssetRef = { id: string; name: string; type: string; publicUrl: string }

/** A large pasted block kept as an editable chip instead of flooding the composer. */
export type PastedText = { id: string; text: string }

interface ComposerAttachmentChipsProps {
  pendingImages: ImageAttachment[]
  setPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>
  pendingAssetRefs: PendingAssetRef[]
  setPendingAssetRefs: Dispatch<SetStateAction<PendingAssetRef[]>>
  pendingReferenceMedia: ReferenceMedia[]
  setPendingReferenceMedia: Dispatch<SetStateAction<ReferenceMedia[]>>
  pendingPastedTexts: PastedText[]
  setPendingPastedTexts: Dispatch<SetStateAction<PastedText[]>>
  /** Open the preview/edit modal for a pasted-text chip. */
  onEditPastedText: (id: string) => void
  uploadingAssets: Record<string, { name: string; pct: number }>
  setPreviewImage: Dispatch<SetStateAction<PreviewImage | null>>
}

/**
 * The composer's pending-attachment chip row (S2 slice 5b): pending images,
 * project-asset refs, reference media, and in-flight uploads, each removable.
 * Extracted verbatim from AgentChat — no visual or behavior change. Renders
 * nothing when there is nothing pending.
 */
export function ComposerAttachmentChips({
  pendingImages,
  setPendingImages,
  pendingAssetRefs,
  setPendingAssetRefs,
  pendingReferenceMedia,
  setPendingReferenceMedia,
  pendingPastedTexts,
  setPendingPastedTexts,
  onEditPastedText,
  uploadingAssets,
  setPreviewImage,
}: ComposerAttachmentChipsProps) {
  if (
    !(
      pendingImages.length > 0 ||
      pendingAssetRefs.length > 0 ||
      pendingReferenceMedia.length > 0 ||
      pendingPastedTexts.length > 0 ||
      Object.keys(uploadingAssets).length > 0
    )
  ) {
    return null
  }
  // Real extension from the filename (HTM / MD / TXT …), so the chip shows the
  // file type instead of the internal 'doc' kind. Falls back to the kind label
  // when there's no extension.
  const extOf = (name: string | undefined, fallback: string): string => {
    const m = /\.([a-z0-9]+)$/i.exec(name ?? '')
    return m ? m[1].toUpperCase() : fallback.toUpperCase()
  }
  // Display name without its extension — the type badge already carries it, so
  // showing "myfile" beside the HTM badge reads cleaner than "myfile.htm".
  const baseName = (name: string | undefined, fallback: string): string =>
    (name ?? fallback).replace(/\.[a-z0-9]+$/i, '')
  return (
    <div className="flex gap-1.5 px-3 pt-2 pb-1 overflow-x-auto scrollbar-hide">
                  {pendingImages.map((img, i) => (
                    <div
                      key={`img-${i}`}
                      className="flex items-center gap-1.5 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md pl-1 pr-2 py-1 shrink-0 group hover:border-[var(--hairline-strong)] transition-colors"
                    >
                      <img
                        src={img.dataUri}
                        onClick={() =>
                          setPreviewImage({ src: img.dataUri, alt: img.fileName, width: img.width, height: img.height })
                        }
                        className="h-7 w-7 object-cover rounded cursor-pointer"
                        alt={img.fileName ?? 'Attached'}
                      />
                      <span className="text-[11px] text-[var(--color-text-primary)] truncate max-w-[80px]">
                        {img.fileName ?? 'Image'}
                      </span>
                      <span
                        onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                        className="cursor-pointer text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </span>
                    </div>
                  ))}
                  {pendingAssetRefs.map((a, i) => (
                    <div
                      key={`asset-${a.id}`}
                      className="flex items-center gap-1.5 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md pl-2 pr-2 py-1 shrink-0 group hover:border-[var(--hairline-strong)] transition-colors"
                    >
                      <span className="text-[11px] leading-none uppercase tracking-wide text-[var(--color-text-muted)]">
                        {extOf(a.name, a.type)}
                      </span>
                      <span className="text-[11px] leading-none text-[var(--color-text-primary)] truncate max-w-[120px]">
                        {baseName(a.name, a.type)}
                      </span>
                      <span
                        onClick={() => setPendingAssetRefs((prev) => prev.filter((_, j) => j !== i))}
                        className="cursor-pointer text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </span>
                    </div>
                  ))}
                  {pendingReferenceMedia.map((m, i) => (
                    <div
                      key={`ref-${m.id}`}
                      title="Reference media — analyzed into an understanding brief before the build"
                      className="flex items-center gap-1.5 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md pl-2 pr-2 py-1 shrink-0 group hover:border-[var(--hairline-strong)] transition-colors"
                    >
                      <span className="text-[11px] leading-none uppercase tracking-wide text-[var(--color-text-muted)]">
                        {extOf(m.fileName, m.kind)}
                      </span>
                      <span className="text-[11px] leading-none text-[var(--color-text-primary)] truncate max-w-[120px]">
                        {baseName(m.fileName, m.kind)}
                      </span>
                      <span
                        onClick={() => setPendingReferenceMedia((prev) => prev.filter((_, j) => j !== i))}
                        className="cursor-pointer text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </span>
                    </div>
                  ))}
                  {pendingPastedTexts.map((p) => (
                    <div
                      key={`pasted-${p.id}`}
                      title="Pasted text — click to preview / edit"
                      className="flex items-center gap-1.5 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md pl-2 pr-2 py-1 shrink-0 group hover:border-[var(--hairline-strong)] transition-colors"
                    >
                      <FileText size={11} className="text-[var(--color-text-muted)] shrink-0" />
                      <span
                        onClick={() => onEditPastedText(p.id)}
                        className="text-[11px] text-[var(--color-text-primary)] truncate max-w-[140px] cursor-pointer"
                      >
                        Pasted text
                        <span className="text-[var(--color-text-muted)]"> · {p.text.length.toLocaleString()} chars</span>
                      </span>
                      <span
                        onClick={() => setPendingPastedTexts((prev) => prev.filter((x) => x.id !== p.id))}
                        className="cursor-pointer text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
                      >
                        <X size={10} />
                      </span>
                    </div>
                  ))}
                  {Object.entries(uploadingAssets).map(([id, u]) => (
                    <div
                      key={id}
                      className="flex items-center gap-1.5 bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-md pl-2 pr-2 py-1 shrink-0 opacity-70"
                    >
                      <span className="text-[11px] leading-none text-[var(--color-text-primary)] truncate max-w-[120px]">
                        {u.name}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">{u.pct}%</span>
                    </div>
                  ))}
    </div>
  )
}
