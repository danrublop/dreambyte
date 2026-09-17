'use client'

import { useState, useRef, useCallback } from 'react'
import type { RecordingSessionManifest } from '@/types/electron'

// ── Constants (aligned with OpenScreen) ─────────────────────────────
const MIC_GAIN_BOOST = 1.4
const RECORDER_TIMESLICE_MS = 1000
const AUDIO_BITRATE_SYSTEM = 192_000 // 192 kbps for system audio
const AUDIO_BITRATE_VOICE = 128_000 // 128 kbps for mic-only
const BLOB_TIMEOUT_MS = 30_000 // Max wait for MediaRecorder to produce blob

// Bitrate tiers by resolution (matches OpenScreen)
function videoBitrate(width: number, height: number, fps: number): number {
  const pixels = width * height
  let bps: number
  if (pixels >= 3840 * 2160) bps = 45_000_000
  else if (pixels >= 2560 * 1440) bps = 28_000_000
  else bps = 18_000_000
  // High frame rate boost
  if (fps >= 60) bps = Math.round(bps * 1.7)
  return bps
}

// Codec negotiation: AV1 > H.264 > VP9 > VP8 > WebM (matches OpenScreen)
function pickMimeType(): string {
  const preferred = [
    'video/webm;codecs=av01,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return preferred.find((m) => MediaRecorder.isTypeSupported(m)) || ''
}

// Ensure even dimensions for codec compatibility
function align2(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

function createRecorder(
  stream: MediaStream,
  chunksRef: React.MutableRefObject<Blob[]>,
  videoBps: number,
  audioBps?: number,
): { recorder: MediaRecorder; blobPromise: Promise<Blob> } {
  const mime = pickMimeType()
  const opts: MediaRecorderOptions = {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: videoBps,
  }
  if (audioBps) opts.audioBitsPerSecond = audioBps
  const recorder = new MediaRecorder(stream, opts)
  chunksRef.current = []

  // Promise that resolves on stop OR rejects on error/timeout
  const blobPromise = new Promise<Blob>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Recording timed out — MediaRecorder did not produce data'))
    }, BLOB_TIMEOUT_MS)

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data)
    }
    recorder.onerror = (ev: Event) => {
      clearTimeout(timeout)
      reject(new Error(`MediaRecorder error: ${(ev as any).error?.message || 'unknown'}`))
    }
    recorder.onstop = () => {
      clearTimeout(timeout)
      resolve(new Blob(chunksRef.current, { type: mime || 'video/webm' }))
    }
  })

  return { recorder, blobPromise }
}

export type RecordingState = 'idle' | 'recording' | 'paused' | 'saving'

interface UseScreenRecorderOptions {
  micEnabled: boolean
  micDeviceId: string | null
  systemAudioEnabled: boolean
  webcamEnabled: boolean
  webcamDeviceId: string | null
  /** Pre-acquired getDisplayMedia stream (studio mode). Skips native picker when provided. */
  preAcquiredStream?: MediaStream | null
}

export interface UseScreenRecorderReturn {
  state: RecordingState
  elapsed: number
  start: () => Promise<void>
  stop: () => Promise<RecordingSessionManifest | null>
  restart: () => Promise<void>
  pause: () => void
  resume: () => void
  cancel: () => void
  error: string | null
  warnings: string[]
  micStream: MediaStream | null
  screenStream: MediaStream | null
  sourceName: string | null
}

export function useScreenRecorder(opts: UseScreenRecorderOptions): UseScreenRecorderReturn {
  // Keep opts in a ref so start() always reads the latest values
  // (avoids stale closure when config is updated right before start)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const [state, setState] = useState<RecordingState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [sourceName, setSourceName] = useState<string | null>(null)
  const ownsStreamRef = useRef(true) // false when using preAcquiredStream

  const screenRecorderRef = useRef<MediaRecorder | null>(null)
  const webcamRecorderRef = useRef<MediaRecorder | null>(null)
  const screenChunksRef = useRef<Blob[]>([])
  const webcamChunksRef = useRef<Blob[]>([])
  const screenBlobPromiseRef = useRef<Promise<Blob> | null>(null)
  const webcamBlobPromiseRef = useRef<Promise<Blob> | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const webcamStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const pausedElapsedRef = useRef(0)
  const recordingIdRef = useRef(0) // Prevents race conditions on rapid restart

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    // Only stop screen stream tracks if we own them (not pre-acquired)
    if (ownsStreamRef.current) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
    webcamStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    screenStreamRef.current = null
    webcamStreamRef.current = null
    micStreamRef.current = null
    audioCtxRef.current = null
    screenRecorderRef.current = null
    webcamRecorderRef.current = null
    setMicStream(null)
    setScreenStream(null)
  }, [])

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsed(pausedElapsedRef.current + (Date.now() - startTimeRef.current))
    }, 200)
  }, [])

  const start = useCallback(async () => {
    const currentOpts = optsRef.current

    const thisRecordingId = ++recordingIdRef.current
    setError(null)
    setWarnings([])
    setElapsed(0)
    pausedElapsedRef.current = 0

    const warn: string[] = []

    try {
      // Use pre-acquired stream (studio mode) or show native OS picker
      let capturedStream: MediaStream
      if (currentOpts.preAcquiredStream) {
        capturedStream = currentOpts.preAcquiredStream
        ownsStreamRef.current = false
      } else {
        ownsStreamRef.current = true
        try {
          try {
            capturedStream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: currentOpts.systemAudioEnabled,
            })
          } catch (audioErr: any) {
            if (currentOpts.systemAudioEnabled) {
              // audio constraint not supported (Electron macOS) — retry video-only
              capturedStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
            } else {
              throw audioErr
            }
          }
          // Apply frame rate after acquisition (getDisplayMedia rejects inline frameRate constraints)
          const ft = capturedStream.getVideoTracks()[0]
          if (ft) {
            try { await ft.applyConstraints({ frameRate: { ideal: 60, max: 60 } }) } catch {}
          }
        } catch (displayErr: any) {
          if (displayErr.name === 'NotAllowedError' || displayErr.name === 'AbortError') {
            return
          }
          throw displayErr
        }
      }
      screenStreamRef.current = capturedStream
      setScreenStream(capturedStream)

      // Resolve source name from track label
      const videoTrack = capturedStream.getVideoTracks()[0]
      setSourceName(videoTrack?.label ?? null)

      // Determine bitrate from actual stream resolution
      const settings = videoTrack?.getSettings()
      const streamWidth = align2(settings?.width ?? 1920)
      const streamHeight = align2(settings?.height ?? 1080)
      const streamFps = settings?.frameRate ?? 30
      const vBitrate = videoBitrate(streamWidth, streamHeight, streamFps)

      // Mic stream — independent try/catch (continues without if fails)
      let micAudioStream: MediaStream | null = null
      if (currentOpts.micEnabled && currentOpts.micDeviceId) {
        try {
          micAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: currentOpts.micDeviceId },
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          })
          micStreamRef.current = micAudioStream
          setMicStream(micAudioStream)
        } catch {
          warn.push('Microphone access denied — recording without mic')
          micAudioStream = null
        }
      }

      // Bail if this recording was superseded (clean up streams we opened)
      if (recordingIdRef.current !== thisRecordingId) {
        if (ownsStreamRef.current) capturedStream.getTracks().forEach((t) => t.stop())
        micAudioStream?.getTracks().forEach((t) => t.stop())
        return
      }

      // Mix audio sources
      const systemAudioTrack = capturedStream.getAudioTracks()[0] ?? null
      const micAudioTrack = micAudioStream?.getAudioTracks()[0] ?? null
      const compositeStream = new MediaStream(capturedStream.getVideoTracks())

      let audioBitrate: number | undefined
      if (systemAudioTrack && micAudioTrack) {
        // Mix both via AudioContext
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const dest = ctx.createMediaStreamDestination()

        const sysSource = ctx.createMediaStreamSource(new MediaStream([systemAudioTrack]))
        sysSource.connect(dest)

        const micSource = ctx.createMediaStreamSource(new MediaStream([micAudioTrack]))
        const gainNode = ctx.createGain()
        gainNode.gain.value = MIC_GAIN_BOOST
        micSource.connect(gainNode)
        gainNode.connect(dest)

        dest.stream.getAudioTracks().forEach((t) => compositeStream.addTrack(t))
        audioBitrate = AUDIO_BITRATE_SYSTEM
      } else if (systemAudioTrack) {
        compositeStream.addTrack(systemAudioTrack)
        audioBitrate = AUDIO_BITRATE_SYSTEM
      } else if (micAudioTrack) {
        compositeStream.addTrack(micAudioTrack)
        audioBitrate = AUDIO_BITRATE_VOICE
      }

      // Handle audio track ending mid-recording (e.g. user disables system audio)
      if (systemAudioTrack) {
        systemAudioTrack.addEventListener('ended', () => {
          setWarnings((prev) => [...prev, 'System audio track ended'])
        })
      }
      if (micAudioTrack) {
        micAudioTrack.addEventListener('ended', () => {
          setWarnings((prev) => [...prev, 'Microphone disconnected'])
        })
      }

      // Screen recorder with resolution-aware bitrate
      const { recorder: screenRec, blobPromise: screenBlob } = createRecorder(
        compositeStream,
        screenChunksRef,
        vBitrate,
        audioBitrate,
      )
      screenRecorderRef.current = screenRec
      screenBlobPromiseRef.current = screenBlob

      // Webcam recorder — independent try/catch (continues without if fails)
      if (currentOpts.webcamEnabled && currentOpts.webcamDeviceId) {
        try {
          const webcamStream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: currentOpts.webcamDeviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
            audio: false,
          })
          webcamStreamRef.current = webcamStream
          const { recorder: webcamRec, blobPromise: webcamBlob } = createRecorder(
            webcamStream,
            webcamChunksRef,
            8_000_000, // 8 Mbps for webcam
          )
          webcamRecorderRef.current = webcamRec
          webcamBlobPromiseRef.current = webcamBlob
          webcamRec.start(RECORDER_TIMESLICE_MS)
        } catch {
          warn.push('Camera access denied — recording without webcam')
          webcamStreamRef.current = null
          webcamRecorderRef.current = null
          webcamBlobPromiseRef.current = null
        }
      }

      // Bail if this recording was superseded
      if (recordingIdRef.current !== thisRecordingId) {
        cleanup()
        return
      }

      setWarnings(warn)

      // Start cursor telemetry
      window.electronAPI?.startCursorTelemetry().catch(() => {})

      // Handle screen share ending (user clicks browser "Stop sharing")
      capturedStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (screenRecorderRef.current?.state === 'recording') {
          screenRecorderRef.current.stop()
          if (webcamRecorderRef.current?.state === 'recording') {
            webcamRecorderRef.current.stop()
          }
        }
      })

      screenRec.start(RECORDER_TIMESLICE_MS)
      setState('recording')
      startTimer()
    } catch (err: any) {
      cleanup()
      setState('idle')
      setError(err.message || 'Failed to start recording')
    }
  }, [cleanup, startTimer])

  const stop = useCallback(async (): Promise<RecordingSessionManifest | null> => {
    if (!screenRecorderRef.current) return null
    const thisRecordingId = recordingIdRef.current
    setState('saving')
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    try {
      if (screenRecorderRef.current.state !== 'inactive') {
        screenRecorderRef.current.stop()
      }
      if (webcamRecorderRef.current && webcamRecorderRef.current.state !== 'inactive') {
        webcamRecorderRef.current.stop()
      }

      const screenBlob = await screenBlobPromiseRef.current!

      // Validate blob (zero-byte = corrupt)
      if (screenBlob.size === 0) {
        cleanup()
        setState('idle')
        setError('Recording produced an empty file — try again')
        return null
      }

      // Fix WebM duration
      let fixedScreenBlob = screenBlob
      try {
        const fixWebmDuration = (await import('fix-webm-duration')).default
        fixedScreenBlob = await fixWebmDuration(screenBlob, elapsed || Date.now() - startTimeRef.current)
      } catch {
        // Fall through with unfixed blob
      }

      // Bail if superseded
      if (recordingIdRef.current !== thisRecordingId) {
        cleanup()
        setState('idle')
        return null
      }

      const screenBytes = await fixedScreenBlob.arrayBuffer()
      let webcamBytes: ArrayBuffer | undefined
      if (webcamBlobPromiseRef.current) {
        const webcamBlob = await webcamBlobPromiseRef.current
        if (webcamBlob.size > 0) {
          webcamBytes = await webcamBlob.arrayBuffer()
        }
      }

      // Stop cursor telemetry
      const telemetry = await window.electronAPI?.stopCursorTelemetry().catch(() => ({ samples: [] })) ?? { samples: [] }

      // Save session
      let manifest: RecordingSessionManifest
      if (window.electronAPI) {
        manifest = await window.electronAPI.saveRecordingSession({
          screenBytes,
          webcamBytes,
          nameHint: 'screen-recording',
        })
      } else {
        // Browser fallback: blob URLs for immediate playback
        const screenUrl = URL.createObjectURL(fixedScreenBlob)
        let webcamVideoUrl: string | undefined
        if (webcamBytes) {
          webcamVideoUrl = URL.createObjectURL(new Blob([webcamBytes], { type: 'video/webm' }))
        }
        manifest = {
          screenVideoPath: '',
          screenVideoUrl: screenUrl,
          webcamVideoUrl,
          createdAt: Date.now(),
        }
      }
      manifest.cursorTelemetry = telemetry.samples

      cleanup()
      setState('idle')
      return manifest
    } catch (err: any) {
      cleanup()
      setState('idle')
      setError(err.message || 'Failed to save recording')
      return null
    }
  }, [elapsed, cleanup])

  const restart = useCallback(async () => {
    // Cancel current recording without saving, then start fresh
    try {
      if (screenRecorderRef.current?.state !== 'inactive') {
        screenRecorderRef.current?.stop()
      }
    } catch {}
    try {
      if (webcamRecorderRef.current?.state !== 'inactive') {
        webcamRecorderRef.current?.stop()
      }
    } catch {}
    window.electronAPI?.stopCursorTelemetry().catch(() => {})
    cleanup()
    setState('idle')
    setElapsed(0)
    pausedElapsedRef.current = 0
    // Start fresh
    await start()
  }, [cleanup, start])

  const pause = useCallback(() => {
    if (screenRecorderRef.current?.state === 'recording') {
      screenRecorderRef.current.pause()
      // Only pause webcam if it's actively recording (avoids InvalidStateError)
      if (webcamRecorderRef.current?.state === 'recording') {
        webcamRecorderRef.current.pause()
      }
      pausedElapsedRef.current += Date.now() - startTimeRef.current
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      setState('paused')
    }
  }, [])

  const resume = useCallback(() => {
    if (screenRecorderRef.current?.state === 'paused') {
      screenRecorderRef.current.resume()
      if (webcamRecorderRef.current?.state === 'paused') {
        webcamRecorderRef.current.resume()
      }
      setState('recording')
      startTimer()
    }
  }, [startTimer])

  const cancel = useCallback(() => {
    try {
      if (screenRecorderRef.current?.state !== 'inactive') {
        screenRecorderRef.current?.stop()
      }
    } catch {}
    try {
      if (webcamRecorderRef.current?.state !== 'inactive') {
        webcamRecorderRef.current?.stop()
      }
    } catch {}
    window.electronAPI?.stopCursorTelemetry().catch(() => {})
    cleanup()
    setState('idle')
    setElapsed(0)
    pausedElapsedRef.current = 0
  }, [cleanup])

  return { state, elapsed, start, stop, restart, pause, resume, cancel, error, warnings, micStream, screenStream, sourceName }
}
