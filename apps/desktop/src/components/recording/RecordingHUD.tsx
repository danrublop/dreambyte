'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Square,
  Pause,
  Play,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Camera,
  CameraOff,
  X,
  ChevronDown,
  GripHorizontal,
  RotateCcw,
} from 'lucide-react'
import { useScreenRecorder } from '@/hooks/useScreenRecorder'
import { useMicrophoneDevices } from '@/hooks/useMicrophoneDevices'
import { useCameraDevices } from '@/hooks/useCameraDevices'
import { useAudioLevelMeter } from '@/hooks/useAudioLevelMeter'
import type { RecordingSessionManifest } from '@/types/electron'

interface RecordingHUDProps {
  onFinish: (manifest: RecordingSessionManifest) => void
  onCancel: () => void
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

const LEVEL_BARS = 5

export default function RecordingHUD({ onFinish, onCancel }: RecordingHUDProps) {
  const [micEnabled, setMicEnabled] = useState(true)
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(true)
  const [webcamEnabled, setWebcamEnabled] = useState(false)
  const [showMicPicker, setShowMicPicker] = useState(false)
  const [showCamPicker, setShowCamPicker] = useState(false)

  const mic = useMicrophoneDevices()
  const cam = useCameraDevices()

  const recorder = useScreenRecorder({
    micEnabled,
    micDeviceId: mic.selectedId,
    systemAudioEnabled,
    webcamEnabled,
    webcamDeviceId: cam.selectedId,
  })

  const audioLevel = useAudioLevelMeter(recorder.micStream)

  // Webcam preview — use ref to avoid stale closure leak
  const webcamVideoRef = useRef<HTMLVideoElement>(null)
  const [webcamPreviewStream, setWebcamPreviewStream] = useState<MediaStream | null>(null)
  const webcamPreviewRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    // Stop previous stream before creating new one
    if (webcamPreviewRef.current) {
      webcamPreviewRef.current.getTracks().forEach((t) => t.stop())
      webcamPreviewRef.current = null
    }

    if (webcamEnabled && cam.selectedId) {
      navigator.mediaDevices
        .getUserMedia({
          video: { deviceId: { exact: cam.selectedId }, width: 160, height: 90 },
          audio: false,
        })
        .then((stream) => {
          webcamPreviewRef.current = stream
          setWebcamPreviewStream(stream)
        })
        .catch(() => setWebcamPreviewStream(null))
    } else {
      setWebcamPreviewStream(null)
    }

    return () => {
      if (webcamPreviewRef.current) {
        webcamPreviewRef.current.getTracks().forEach((t) => t.stop())
        webcamPreviewRef.current = null
      }
    }
  }, [webcamEnabled, cam.selectedId])

  useEffect(() => {
    if (webcamVideoRef.current && webcamPreviewStream) {
      webcamVideoRef.current.srcObject = webcamPreviewStream
    }
  }, [webcamPreviewStream])

  // Auto-start recording on mount (reset flag on failure so retry works)
  const startedRef = useRef(false)
  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true
      recorder.start().catch(() => {
        startedRef.current = false
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopPreview = useCallback(() => {
    if (webcamPreviewRef.current) {
      webcamPreviewRef.current.getTracks().forEach((t) => t.stop())
      webcamPreviewRef.current = null
    }
    setWebcamPreviewStream(null)
  }, [])

  const handleStop = useCallback(async () => {
    const manifest = await recorder.stop()
    stopPreview()
    if (manifest) {
      onFinish(manifest)
    } else {
      onCancel()
    }
  }, [recorder, onFinish, onCancel, stopPreview])

  const handleCancel = useCallback(() => {
    recorder.cancel()
    stopPreview()
    onCancel()
  }, [recorder, onCancel, stopPreview])

  const handleRestart = useCallback(() => {
    stopPreview()
    recorder.restart()
  }, [recorder, stopPreview])

  // Draggable — use ref for current pos to avoid recreating onMouseDown on every move
  const hudRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const posRef = useRef(pos)
  posRef.current = pos
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const initial = { x: window.innerWidth / 2 - 240, y: window.innerHeight - 130 }
    setPos(initial)
    posRef.current = initial
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    dragOffset.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const next = { x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y }
      setPos(next)
      posRef.current = next
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const isRecording = recorder.state === 'recording'
  const isPaused = recorder.state === 'paused'
  const isSaving = recorder.state === 'saving'

  return (
    <div
      ref={hudRef}
      className="fixed z-[9999] select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex flex-col rounded-xl shadow-2xl overflow-hidden"
        style={{
          background: 'rgba(18, 18, 22, 0.92)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {/* Source name bar */}
        {recorder.sourceName && (
          <div
            className="flex items-center gap-1.5 px-3 py-1"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
          >
            <span
              className="cursor-grab active:cursor-grabbing p-0.5"
              style={{ color: '#4a4a55' }}
              onMouseDown={onMouseDown}
            >
              <GripHorizontal size={12} />
            </span>
            <span className="text-[11px] truncate max-w-[300px]" style={{ color: '#6b6b7a' }}>
              {recorder.sourceName}
            </span>
          </div>
        )}

        {/* Main controls row */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Drag handle (fallback if no source name bar) */}
          {!recorder.sourceName && (
            <span
              className="cursor-grab active:cursor-grabbing p-0.5"
              style={{ color: '#4a4a55' }}
              onMouseDown={onMouseDown}
            >
              <GripHorizontal size={14} />
            </span>
          )}

          {/* Recording indicator + timer */}
          <div className="flex items-center gap-2 mr-1">
            {isRecording && (
              <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: '#e05252' }} />
            )}
            {isPaused && (
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#e0a852' }} />
            )}
            {isSaving && (
              <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ background: '#52a8e0' }} />
            )}
            <span
              className="text-sm font-mono tabular-nums"
              style={{ color: isRecording ? '#e05252' : '#f0ece0', minWidth: 52 }}
            >
              {isSaving ? 'Saving...' : formatElapsed(recorder.elapsed)}
            </span>
          </div>

          <Divider />

          {/* Pause/Resume */}
          {(isRecording || isPaused) && (
            <HUDButton
              onClick={isPaused ? recorder.resume : recorder.pause}
              title={isPaused ? 'Resume' : 'Pause'}
            >
              {isPaused ? <Play size={14} /> : <Pause size={14} />}
            </HUDButton>
          )}

          {/* Stop */}
          {(isRecording || isPaused) && (
            <HUDButton onClick={handleStop} title="Stop recording" variant="stop">
              <Square size={12} fill="currentColor" />
            </HUDButton>
          )}

          {/* Restart */}
          {(isRecording || isPaused) && (
            <HUDButton onClick={handleRestart} title="Restart recording">
              <RotateCcw size={13} />
            </HUDButton>
          )}

          <Divider />

          {/* Mic toggle + picker + level meter */}
          <div className="relative flex items-center gap-0.5">
            <HUDButton
              onClick={() => setMicEnabled(!micEnabled)}
              title={micEnabled ? 'Mute mic' : 'Unmute mic'}
              active={micEnabled}
            >
              {micEnabled ? <Mic size={14} /> : <MicOff size={14} />}
            </HUDButton>
            {mic.devices.length > 1 && !isRecording && !isPaused && (
              <span
                className="cursor-pointer p-0.5"
                style={{ color: '#6b6b7a' }}
                onClick={() => setShowMicPicker(!showMicPicker)}
              >
                <ChevronDown size={10} />
              </span>
            )}
            {/* Multi-bar audio level meter */}
            {micEnabled && <AudioLevelBars level={audioLevel} />}
            {showMicPicker && (
              <DevicePicker
                devices={mic.devices.map((d) => ({ id: d.deviceId, label: d.label }))}
                selectedId={mic.selectedId}
                onSelect={(id) => { mic.setSelectedId(id); setShowMicPicker(false) }}
                onClose={() => setShowMicPicker(false)}
              />
            )}
          </div>

          {/* System audio */}
          <HUDButton
            onClick={() => setSystemAudioEnabled(!systemAudioEnabled)}
            title={systemAudioEnabled ? 'Mute system audio' : 'Unmute system audio'}
            active={systemAudioEnabled}
          >
            {systemAudioEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </HUDButton>

          {/* Webcam toggle + picker */}
          <div className="relative flex items-center gap-0.5">
            <HUDButton
              onClick={() => setWebcamEnabled(!webcamEnabled)}
              title={webcamEnabled ? 'Disable webcam' : 'Enable webcam'}
              active={webcamEnabled}
            >
              {webcamEnabled ? <Camera size={14} /> : <CameraOff size={14} />}
            </HUDButton>
            {cam.devices.length > 1 && !isRecording && !isPaused && (
              <span
                className="cursor-pointer p-0.5"
                style={{ color: '#6b6b7a' }}
                onClick={() => setShowCamPicker(!showCamPicker)}
              >
                <ChevronDown size={10} />
              </span>
            )}
            {showCamPicker && (
              <DevicePicker
                devices={cam.devices.map((d) => ({ id: d.deviceId, label: d.label }))}
                selectedId={cam.selectedId}
                onSelect={(id) => { cam.setSelectedId(id); setShowCamPicker(false) }}
                onClose={() => setShowCamPicker(false)}
              />
            )}
          </div>

          <Divider />

          {/* Cancel */}
          <HUDButton onClick={handleCancel} title="Cancel recording">
            <X size={14} />
          </HUDButton>
        </div>
      </div>

      {/* Webcam preview (small PIP below HUD) */}
      {webcamEnabled && webcamPreviewStream && (
        <div
          className="mt-2 rounded-lg overflow-hidden shadow-lg"
          style={{ width: 160, height: 90, border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <video
            ref={webcamVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
        </div>
      )}

      {/* Warnings (non-fatal) */}
      {recorder.warnings.length > 0 && (
        <div
          className="mt-2 rounded-lg px-3 py-2 text-sm flex flex-col gap-0.5"
          style={{ background: 'rgba(224,168,82,0.12)', color: '#e0a852', border: '1px solid rgba(224,168,82,0.2)' }}
        >
          {recorder.warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      {/* Error (fatal) */}
      {recorder.error && (
        <div
          className="mt-2 rounded-lg px-3 py-2 text-sm"
          style={{ background: 'rgba(224,82,82,0.15)', color: '#e05252', border: '1px solid rgba(224,82,82,0.2)' }}
        >
          {recorder.error}
        </div>
      )}
    </div>
  )
}

function Divider() {
  return <div className="w-px h-5" style={{ background: 'rgba(255,255,255,0.08)' }} />
}

function AudioLevelBars({ level }: { level: number }) {
  // Exponential curve: lower bars light easily, top bars need louder audio
  // Thresholds: ~0.04, 0.10, 0.20, 0.38, 0.65
  return (
    <div className="flex items-end gap-px h-3.5 ml-0.5">
      {Array.from({ length: LEVEL_BARS }, (_, i) => {
        const threshold = Math.pow((i + 1) / LEVEL_BARS, 2)
        const active = level >= threshold
        let color: string
        if (i >= LEVEL_BARS - 1) color = '#e05252' // top bar = red
        else if (i >= LEVEL_BARS - 2) color = '#e0a852' // second from top = yellow
        else color = '#52e087' // rest = green
        return (
          <div
            key={i}
            className="rounded-sm transition-all"
            style={{
              width: 2.5,
              height: 4 + i * 2,
              background: active ? color : 'rgba(255,255,255,0.08)',
            }}
          />
        )
      })}
    </div>
  )
}

function HUDButton({
  onClick,
  title,
  children,
  active,
  variant,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  active?: boolean
  variant?: 'stop'
}) {
  return (
    <span
      onClick={onClick}
      title={title}
      className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-colors"
      style={{
        color: variant === 'stop' ? '#e05252' : active === false ? '#4a4a55' : '#c0bdb0',
        background: 'transparent',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </span>
  )
}

function DevicePicker({
  devices,
  selectedId,
  onSelect,
  onClose,
}: {
  devices: Array<{ id: string; label: string }>
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div
        className="absolute bottom-full mb-2 left-0 z-20 rounded-lg py-1 min-w-[200px] shadow-xl"
        style={{
          background: 'rgba(24, 24, 28, 0.96)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {devices.map((d) => (
          <div
            key={d.id}
            onClick={() => onSelect(d.id)}
            className="px-3 py-1.5 text-sm cursor-pointer transition-colors truncate"
            style={{
              color: d.id === selectedId ? '#f0ece0' : '#8a8a95',
              background: d.id === selectedId ? 'rgba(255,255,255,0.06)' : 'transparent',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = d.id === selectedId ? 'rgba(255,255,255,0.06)' : 'transparent'
            }}
          >
            {d.label}
          </div>
        ))}
      </div>
    </>
  )
}
