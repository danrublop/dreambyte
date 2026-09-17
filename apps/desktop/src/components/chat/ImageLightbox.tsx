'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

export interface PreviewImage {
  src: string
  alt?: string
  width?: number
  height?: number
}

export function ImageLightbox({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={image.src}
          alt={image.alt ?? 'Preview'}
          className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl"
        />
        <div className="flex items-center gap-3 text-white/60 text-sm">
          {image.alt && <span>{image.alt}</span>}
          {image.width && image.height && (
            <span>
              {image.width} x {image.height}
            </span>
          )}
        </div>
        <span
          onClick={onClose}
          className="absolute -top-2 -right-2 bg-white/10 hover:bg-white/20 rounded-full p-1.5 cursor-pointer transition-colors"
        >
          <X size={16} className="text-white" />
        </span>
      </div>
    </div>
  )
}
