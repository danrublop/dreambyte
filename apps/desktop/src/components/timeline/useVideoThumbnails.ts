import { useEffect, useState, useRef } from 'react'
import { LruMap } from '@/lib/utils/lru-map'

const THUMB_HEIGHT = 64
const THUMB_QUALITY = 0.6

/** Thumbnails are JPEG data URLs — typically a few KB each, with ~12 per
 *  unique (url, count, trim) tuple. Cap at 150 tuples so a long session
 *  doesn't accumulate hundreds of MB of base64 strings in renderer memory. */
const thumbnailCache = new LruMap<string, string[]>(150)
const inflightExtracts = new Map<string, Promise<string[]>>()

async function extractThumbnails(
  url: string,
  count: number,
  startTime: number,
  endTime: number | null,
): Promise<string[]> {
  const cacheKey = `${url}#${count}#${startTime}#${endTime ?? 'end'}`
  const cached = thumbnailCache.get(cacheKey)
  if (cached) return cached

  const inflight = inflightExtracts.get(cacheKey)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.preload = 'auto'
      video.src = url

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('video load failed'))
        setTimeout(() => reject(new Error('video load timeout')), 15000)
      })

      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) return []

      const sampleStart = Math.max(0, Math.min(duration, startTime))
      const sampleEnd = endTime == null ? duration : Math.max(sampleStart, Math.min(duration, endTime))
      const span = Math.max(0.001, sampleEnd - sampleStart)

      const aspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9
      const w = Math.round(THUMB_HEIGHT * aspect)
      const h = THUMB_HEIGHT
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return []

      const thumbs: string[] = []
      for (let i = 0; i < count; i++) {
        const t = sampleStart + ((i + 0.5) / count) * span
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          video.addEventListener('seeked', onSeeked)
          try {
            video.currentTime = Math.min(t, Math.max(0, duration - 0.05))
          } catch {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          setTimeout(() => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }, 3000)
        })
        try {
          ctx.drawImage(video, 0, 0, w, h)
          thumbs.push(canvas.toDataURL('image/jpeg', THUMB_QUALITY))
        } catch {
          break
        }
      }

      thumbnailCache.set(cacheKey, thumbs)
      return thumbs
    } catch {
      return []
    } finally {
      inflightExtracts.delete(cacheKey)
    }
  })()

  inflightExtracts.set(cacheKey, promise)
  return promise
}

/**
 * Hook that returns a strip of thumbnails (data URLs) sampled across the video.
 * `count` is how many evenly-spaced frames to extract. Optional `startTime` /
 * `endTime` restrict sampling to a sub-range (e.g. respecting clip trim).
 * Returns [] while loading.
 */
export function useVideoThumbnails(
  videoUrl: string | null | undefined,
  count: number,
  startTime: number = 0,
  endTime: number | null = null,
): string[] {
  const [thumbs, setThumbs] = useState<string[]>([])
  const urlRef = useRef(videoUrl)
  const countRef = useRef(count)
  const startRef = useRef(startTime)
  const endRef = useRef(endTime)

  useEffect(() => {
    urlRef.current = videoUrl
    countRef.current = count
    startRef.current = startTime
    endRef.current = endTime
    if (!videoUrl || count <= 0) {
      setThumbs([])
      return
    }
    const cacheKey = `${videoUrl}#${count}#${startTime}#${endTime ?? 'end'}`
    const cached = thumbnailCache.get(cacheKey)
    if (cached) {
      setThumbs(cached)
      return
    }
    extractThumbnails(videoUrl, count, startTime, endTime).then((t) => {
      if (
        urlRef.current === videoUrl &&
        countRef.current === count &&
        startRef.current === startTime &&
        endRef.current === endTime
      )
        setThumbs(t)
    })
  }, [videoUrl, count, startTime, endTime])

  return thumbs
}
