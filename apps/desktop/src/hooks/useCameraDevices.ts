'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

export interface CameraDevice {
  deviceId: string
  label: string
}

export function useCameraDevices() {
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    try {
      // Request permission first so we get real device labels
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
        tempStream.getTracks().forEach((t) => t.stop())
      } catch {
        // Permission denied — we'll still enumerate but labels may be blank
      }

      const all = await navigator.mediaDevices.enumerateDevices()
      if (!mountedRef.current) return
      const cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 6)}` }))
      setDevices(cams)
      setError(null)
      if (cams.length > 0) {
        setSelectedId((prev) => {
          if (prev && cams.find((c) => c.deviceId === prev)) return prev
          return cams[0].deviceId
        })
      }
    } catch (err: any) {
      if (!mountedRef.current) return
      setDevices([])
      setError(err.message || 'Failed to enumerate cameras')
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  return { devices, selectedId, setSelectedId, isLoading, error, refresh }
}
