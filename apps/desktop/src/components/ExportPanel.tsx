'use client'

import { useState, useEffect, useMemo } from 'react'
import { Download, Loader2, AlertTriangle, FolderOpen, Plus } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { isCancellable } from '@/lib/store/export-cancel'
import { resolveProjectDimensions } from '@/lib/dimensions'
import type { ExportFPS, ExportResolution, ExportSettings } from '@/lib/types'
import {
  PLATFORM_PROFILES,
  checkPlatformCompatibility,
  getPlatformProfile,
  type PlatformProfileId,
} from '@/lib/export/platform-profiles'
import { buildExportCaptionBundle } from '@/lib/export/caption-burnin'
import { reconcileSceneExportDuration } from '@/lib/export/reconcile-scene-duration'
import { createLogger } from '@/lib/logger'
import { DreambyteLogo } from './icons/DreambyteLogo'
import { SettingsButton } from '@/components/settings/GeneralSettingsTab'

const log = createLogger('export-panel')

type OSType = 'mac' | 'windows' | 'linux' | 'unknown'

function detectOS(): OSType {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (ua.includes('Mac OS X')) return 'mac'
  if (ua.includes('Windows')) return 'windows'
  if (ua.includes('Linux')) return 'linux'
  return 'unknown'
}

const OS_WARNINGS: Partial<Record<OSType, { title: string; body: string }>> = {
  mac: {
    title: 'macOS detected',
    body: 'The render server will open a visible Chrome window to capture each scene. Keep the windows in the foreground while exporting.',
  },
  windows: {
    title: 'Windows detected',
    body: 'The render server will open a visible Chrome window to capture each scene. Keep the windows in the foreground while exporting. Make sure Google Chrome is installed.',
  },
}

function getResolutions(
  aspectRatio?: import('@/lib/dimensions').AspectRatio | null,
): { value: ExportResolution; label: string; desc: string }[] {
  return (['720p', '1080p', '4k'] as const).map((res) => {
    const d = resolveProjectDimensions(aspectRatio, res)
    return { value: res, label: res === '4k' ? '4K' : res, desc: `${d.width}×${d.height}` }
  })
}

const FPS_OPTIONS: ExportFPS[] = [24, 30, 60]

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: '36px',
  padding: '0 12px',
  borderRadius: '8px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-input-bg)',
  color: 'var(--color-text-primary)',
  fontSize: '13px',
  outline: 'none',
}

const inputStyle: React.CSSProperties = {
  height: '36px',
  padding: '0 12px',
  borderRadius: '8px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-input-bg)',
  color: 'var(--color-text-primary)',
  fontSize: '13px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.048px',
  color: 'var(--color-text-muted)',
  marginBottom: '8px',
}

interface ExportPanelProps {
  onClose?: () => void
  inTab?: boolean
}

export default function ExportPanel({ onClose, inTab = false }: ExportPanelProps) {
  const {
    exportProgress,
    closeExportModal,
    exportVideo,
    cancelExport,
    scenes,
    project,
    updateProject,
    saveProjectToDb,
    exportFormDraft,
    setExportFormDraft,
    markExportStatusSeen,
  } = useVideoStore()

  useEffect(() => {
    if (exportFormDraft) return
    const initialPlatformId: PlatformProfileId = project?.mp4Settings?.platformProfileId ?? 'custom'
    const initialProfile = getPlatformProfile(initialPlatformId)
    const initialName = project?.name
      ? project.name
          .replace(/[^a-zA-Z0-9_\-\s]/g, '')
          .trim()
          .replace(/\s+/g, '-') || 'export'
      : 'export'
    setExportFormDraft({
      platformId: initialPlatformId,
      resolution:
        initialPlatformId === 'custom' ? (project?.mp4Settings?.resolution ?? '1080p') : initialProfile.resolution,
      fps: initialPlatformId === 'custom' ? (project?.mp4Settings?.fps ?? 30) : initialProfile.fps,
      profile: 'quality',
      os: detectOS(),
      filename: initialName,
      saveDirPath: '',
      saveDirName: '',
    })
    if (typeof window !== 'undefined' && window.electronAPI?.getDefaultExportDir) {
      window.electronAPI
        .getDefaultExportDir()
        .then(({ dirPath }) => {
          if (!dirPath) return
          setExportFormDraft({
            saveDirPath: dirPath,
            saveDirName: dirPath.split(/[\\/]/).pop() || dirPath,
          })
        })
        .catch(() => {})
    }
  }, [exportFormDraft, project, setExportFormDraft])

  useEffect(() => {
    markExportStatusSeen()
  }, [markExportStatusSeen])

  const draft = exportFormDraft
  const platformId = draft?.platformId ?? 'custom'
  const resolution = draft?.resolution ?? '1080p'
  const fps = draft?.fps ?? 30
  const profile = draft?.profile ?? 'quality'
  const os = draft?.os ?? 'unknown'
  const filename = draft?.filename ?? 'export'
  const saveDirPath = draft?.saveDirPath ?? ''
  const saveDirName = draft?.saveDirName ?? ''

  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  // Burn captions into the video pixels (one extra re-encode). Default
  // off — sidecar .srt/.vtt ship regardless; burn-in is for muted-feed
  // platforms that ignore sidecars.
  const [burnCaptions, setBurnCaptions] = useState(false)

  const setResolution = (v: ExportResolution) => {
    let nextPlatform: PlatformProfileId = platformId
    if (platformId !== 'custom') {
      const prof = getPlatformProfile(platformId)
      if (prof.resolution !== v) nextPlatform = 'custom'
    }
    setExportFormDraft({ resolution: v, platformId: nextPlatform })
  }
  const setFps = (v: ExportFPS) => {
    let nextPlatform: PlatformProfileId = platformId
    if (platformId !== 'custom') {
      const prof = getPlatformProfile(platformId)
      if (prof.fps !== v) nextPlatform = 'custom'
    }
    setExportFormDraft({ fps: v, platformId: nextPlatform })
  }

  const pickSaveLocation = async () => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.chooseDirectory) {
        const res = await window.electronAPI.chooseDirectory(saveDirPath || undefined)
        if (res.canceled || !res.dirPath) return
        setExportFormDraft({
          saveDirPath: res.dirPath,
          saveDirName: res.dirPath.split(/[\\/]/).pop() || res.dirPath,
        })
        return
      }
      if ('showDirectoryPicker' in window) {
        const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
        setExportFormDraft({ saveDirPath: '', saveDirName: handle.name })
      }
    } catch {
      // User cancelled
    }
  }

  const osWarning = OS_WARNINGS[os]
  const isElectronPath2 = typeof window !== 'undefined' && !!window.electronAPI

  const currentPlatform = useMemo(() => getPlatformProfile(platformId), [platformId])
  // Reconciled durations — extend-scene avatar/Veo clips grow the export,
  // so the platform-cap compat warning and the duration row must measure the
  // length the export will ACTUALLY have, not the authored sums.
  const totalDuration = useMemo(
    () => scenes.reduce((a, s) => a + reconcileSceneExportDuration(s).duration, 0),
    [scenes],
  )
  const compat = useMemo(
    () => checkPlatformCompatibility(currentPlatform, project?.mp4Settings?.aspectRatio ?? '16:9', totalDuration),
    [currentPlatform, project?.mp4Settings?.aspectRatio, totalDuration],
  )

  const applyPlatform = (id: PlatformProfileId) => {
    const prof = getPlatformProfile(id)
    setExportFormDraft({
      platformId: id,
      ...(id !== 'custom' ? { resolution: prof.resolution, fps: prof.fps } : {}),
    })
    updateProject({
      mp4Settings: {
        ...project.mp4Settings,
        platformProfileId: id === 'custom' ? null : id,
      },
    })
  }

  const applyProjectAspect = () => {
    if (!currentPlatform.aspectRatio) return
    updateProject({
      mp4Settings: {
        ...project.mp4Settings,
        aspectRatio: currentPlatform.aspectRatio,
      },
    })
    saveProjectToDb().catch((err) => {
      log.warn('failed to persist aspect change', { error: err })
    })
  }

  // Same assembly the export paths use (src/lib/store/export-actions.ts) — if this
  // hand-rolled its own cursor loop the checkbox could show for a project the
  // export would then skip ("no cues"), or vice versa. Durations are A4-
  // reconciled for the same reason: the standalone .srt/.vtt downloads below
  // must carry the SAME cue offsets the export writes, or every cue after an
  // extended scene drifts.
  const mergedCaptions = useMemo(
    () =>
      buildExportCaptionBundle(
        scenes.map((s) => ({
          duration: reconcileSceneExportDuration(s).duration,
          words: s.audioLayer?.tts?.captions?.words,
          transitionToNext: s.transition,
          transitionToNextDuration: 0.5,
        })),
        !!project?.timeline,
      ),
    [scenes, project?.timeline],
  )
  // Burn-in is cuts-only: a real transition flips the stitcher onto its xfade
  // path (the one allowed lossy pass) — burning would add a second full
  // re-encode. export-actions gates this too; here we explain it up front.
  const burnGatedByXfade = useMemo(() => scenes.slice(0, -1).some((s) => (s.transition ?? 'none') !== 'none'), [scenes])

  const sanitizedName = filename.replace(/[^a-zA-Z0-9_\-]/g, '') || 'export'

  const downloadCaptions = (kind: 'srt' | 'vtt') => {
    if (!mergedCaptions) return
    const content = kind === 'srt' ? mergedCaptions.srt : mergedCaptions.vtt
    const mime = kind === 'srt' ? 'application/x-subrip' : 'text/vtt'
    const blob = new Blob([content], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitizedName}.${kind}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const isRendering = exportProgress?.phase === 'rendering'
  const isMixingAudio = exportProgress?.phase === 'mixing_audio'
  const isStitching = exportProgress?.phase === 'stitching'
  const isComplete = exportProgress?.phase === 'complete'
  const isError = exportProgress?.phase === 'error'
  const isCancelled = exportProgress?.phase === 'cancelled'
  // Cancel is only safe during the per-scene render — once finalize/mux
  // (stitching / mixing_audio) starts, cancelling could leave a torn MP4, so
  // the button is hidden. Single source of truth: export-cancel.ts.
  const canCancelExport = isCancellable(exportProgress?.phase)

  const handleExport = () => {
    const settings: ExportSettings = {
      resolution,
      fps,
      format: 'mp4',
      outputName: sanitizedName,
      profile,
      ...(burnCaptions && mergedCaptions && !burnGatedByXfade ? { burnCaptions: true } : {}),
    }
    if (isElectronPath2 && saveDirPath) {
      settings.outputPath = `${saveDirPath.replace(/[\\/]+$/, '')}/${sanitizedName}.mp4`
    }
    // Fire-and-forget: render progress/errors surface via exportProgress. The
    // .catch swallows the re-entrancy rejection (exportVideo throws if another
    // export is already running) so it doesn't become an unhandled rejection.
    void exportVideo(settings).catch(() => {})
  }

  const handleCancelClick = () => {
    if (onClose) {
      onClose()
    } else {
      closeExportModal()
    }
  }

  const wrapperStyle: React.CSSProperties = inTab
    ? {
        maxWidth: '560px',
        margin: '0 auto',
        width: '100%',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      }
    : { padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }

  return (
    <div style={wrapperStyle}>
      {!exportProgress ? (
        <>
          {/* Platform */}
          <div>
            <label style={labelStyle}>Platform</label>
            <select
              value={platformId}
              onChange={(e) => applyPlatform(e.target.value as PlatformProfileId)}
              style={selectStyle}
            >
              {PLATFORM_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.note ? ` — ${p.note}` : ''}
                </option>
              ))}
            </select>
            {currentPlatform.id !== 'custom' && (
              <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '6px' }}>
                {currentPlatform.description}
              </p>
            )}
            {currentPlatform.id !== 'custom' && !compat.aspectMatch && (
              <div
                style={{
                  marginTop: '8px',
                  display: 'flex',
                  gap: '8px',
                  background: 'rgba(120,80,0,0.2)',
                  border: '1px solid rgba(160,100,0,0.4)',
                  borderRadius: '8px',
                  padding: '10px',
                }}
              >
                <AlertTriangle size={13} style={{ color: 'rgb(251,191,36)', flexShrink: 0, marginTop: '2px' }} />
                <div
                  style={{
                    fontSize: '12px',
                    color: 'rgb(253,230,138)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <p style={{ margin: 0 }}>
                    Project aspect is {compat.actualAspect} but {currentPlatform.label} expects {compat.expectedAspect}.
                    The export will render at {compat.actualAspect} unless you switch the project aspect.
                  </p>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={applyProjectAspect}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyProjectAspect()
                    }}
                    style={{ color: 'rgb(252,211,77)', textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    Switch project to {compat.expectedAspect}
                  </span>
                </div>
              </div>
            )}
            {compat.durationExceeds && compat.maxDurationSeconds !== null && (
              <div
                style={{
                  marginTop: '8px',
                  display: 'flex',
                  gap: '8px',
                  background: 'rgba(120,80,0,0.2)',
                  border: '1px solid rgba(160,100,0,0.4)',
                  borderRadius: '8px',
                  padding: '10px',
                }}
              >
                <AlertTriangle size={13} style={{ color: 'rgb(251,191,36)', flexShrink: 0, marginTop: '2px' }} />
                <p style={{ fontSize: '12px', color: 'rgb(253,230,138)', margin: 0 }}>
                  Video is {Math.round(compat.totalDurationSeconds)}s — exceeds {currentPlatform.label}'s{' '}
                  {compat.maxDurationSeconds}s cap. Trim scenes before uploading.
                </p>
              </div>
            )}
          </div>

          {/* Filename */}
          <div>
            <label style={labelStyle}>Filename</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input
                type="text"
                value={filename}
                onChange={(e) => setExportFormDraft({ filename: e.target.value })}
                placeholder="my-video"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>.mp4</span>
            </div>
          </div>

          {/* Save location */}
          {'showDirectoryPicker' in globalThis && (
            <div>
              <label style={labelStyle}>Save to</label>
              <span
                role="button"
                tabIndex={0}
                onClick={pickSaveLocation}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') pickSaveLocation()
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  ...inputStyle,
                  width: '100%',
                  cursor: 'pointer',
                  overflow: 'hidden',
                }}
              >
                <FolderOpen size={14} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: saveDirName ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                  }}
                >
                  {saveDirName || 'Default (Downloads)'}
                </span>
              </span>
            </div>
          )}

          {/* Resolution / Frame Rate / Export Profile */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <div>
              <label style={labelStyle}>Resolution</label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ExportResolution)}
                style={selectStyle}
              >
                {getResolutions(project.mp4Settings?.aspectRatio).map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label} ({r.desc})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Frame Rate</label>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value) as ExportFPS)} style={selectStyle}>
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Export Profile</label>
              <select
                value={profile}
                onChange={(e) => setExportFormDraft({ profile: e.target.value as 'fast' | 'quality' })}
                style={selectStyle}
              >
                <option value="fast">Fast</option>
                <option value="quality">Quality</option>
              </select>
            </div>
          </div>

          {/* Summary */}
          <div
            style={{
              background: 'var(--color-surface)',
              borderRadius: '8px',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {[
              ['Scenes', String(scenes.length)],
              ['Total duration', `${Math.round(totalDuration * 10) / 10}s`],
              ...(mergedCaptions ? [['Captions', `${mergedCaptions.cues.length} cues · SRT + VTT`]] : []),
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>{k}</span>
                <span style={{ color: 'var(--color-text-primary)' }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Caption burn-in toggle — only when the project has cues.
              Disabled (with the reason) when scene transitions force the xfade
              stitch path, where burning would add a second lossy re-encode. */}
          {mergedCaptions && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13px',
                color: burnGatedByXfade ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                cursor: burnGatedByXfade ? 'not-allowed' : 'pointer',
                padding: '0 2px',
              }}
            >
              <input
                type="checkbox"
                checked={burnCaptions && !burnGatedByXfade}
                disabled={burnGatedByXfade}
                onChange={(e) => setBurnCaptions(e.target.checked)}
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span>Burn captions into video</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>
                {burnGatedByXfade
                  ? 'unavailable with scene transitions · sidecar .srt/.vtt still exported'
                  : 'hardcoded for muted feeds · adds an encode pass'}
              </span>
            </label>
          )}

          {/* OS warning */}
          {osWarning && !isElectronPath2 && (
            <div
              style={{
                display: 'flex',
                gap: '10px',
                background: 'rgba(120,80,0,0.2)',
                border: '1px solid rgba(160,100,0,0.4)',
                borderRadius: '8px',
                padding: '12px',
              }}
            >
              <AlertTriangle size={14} style={{ color: 'rgb(251,191,36)', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <p style={{ margin: 0, color: 'rgb(251,191,36)', fontWeight: 500 }}>{osWarning.title}</p>
                <p style={{ margin: 0, color: 'rgb(253,230,138)', opacity: 0.8 }}>{osWarning.body}</p>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleCancelClick}
              style={{
                flex: 1,
                height: '36px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-panel)',
                color: 'var(--color-text-muted)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {onClose ? 'Cancel' : 'Reset'}
            </button>
            <button
              onClick={handleExport}
              disabled={scenes.length === 0}
              style={{
                flex: 1,
                height: '36px',
                borderRadius: '8px',
                border: '1px solid color-mix(in srgb, var(--color-accent) 60%, transparent)',
                background: 'color-mix(in srgb, var(--color-accent) 20%, transparent)',
                color: 'var(--color-accent)',
                fontSize: '13px',
                fontWeight: 700,
                cursor: scenes.length === 0 ? 'not-allowed' : 'pointer',
                opacity: scenes.length === 0 ? 0.4 : 1,
              }}
            >
              Start Export
            </button>
          </div>
        </>
      ) : isComplete ? (
        /* Complete */
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-text-primary)' }}>
            <DreambyteLogo size={56} />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 500, color: 'var(--color-text-primary)' }}>Your video is ready</p>
            {exportProgress.warning && (
              <p
                style={{
                  margin: '8px 16px 0',
                  fontSize: '12px',
                  color: '#e6b450',
                  background: 'rgba(120,80,0,0.2)',
                  border: '1px solid rgba(230,180,80,0.35)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  textAlign: 'left',
                }}
              >
                {exportProgress.warning}
              </p>
            )}
            {exportProgress.filePath && (
              <p
                style={{
                  margin: '6px 0 0',
                  fontSize: '12px',
                  color: 'var(--color-text-muted)',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                  padding: '0 16px',
                }}
                title={exportProgress.filePath}
              >
                {exportProgress.filePath}
              </p>
            )}
          </div>
          {(exportProgress.filePath || exportProgress.downloadUrl) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
              {[
                {
                  icon: <FolderOpen size={14} />,
                  label: os === 'windows' ? 'Show in Explorer' : os === 'linux' ? 'Show in Files' : 'Show in Finder',
                  onClick: () => {
                    if (exportProgress.filePath && window.electronAPI?.showItemInFolder) {
                      window.electronAPI.showItemInFolder(exportProgress.filePath).catch(() => {})
                      return
                    }
                    const url = exportProgress.downloadUrl
                    if (url) window.open(url, '_blank')
                  },
                },
                {
                  icon: <Download size={14} />,
                  label: 'Open',
                  onClick: () => {
                    if (exportProgress.filePath && window.electronAPI?.openPath) {
                      window.electronAPI.openPath(exportProgress.filePath).catch(() => {})
                      return
                    }
                    const url = exportProgress.downloadUrl
                    if (!url) return
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${sanitizedName}.mp4`
                    document.body.appendChild(a)
                    a.click()
                    a.remove()
                  },
                },
                {
                  icon: <Plus size={14} />,
                  label: onClose ? 'Close' : 'New Export',
                  onClick: handleCancelClick,
                },
              ].map(({ icon, label, onClick }, i, arr) => (
                <span key={label} style={{ display: 'contents' }}>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={onClick}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onClick()
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {icon}
                    {label}
                  </span>
                  {i < arr.length - 1 && <span style={{ color: 'var(--color-border)' }}>|</span>}
                </span>
              ))}
            </div>
          )}
          {mergedCaptions && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '16px',
                paddingTop: '4px',
              }}
            >
              {(['srt', 'vtt'] as const).map((kind, i) => (
                <span key={kind} style={{ display: 'contents' }}>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => downloadCaptions(kind)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') downloadCaptions(kind)
                    }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <Download size={12} />
                    Download {kind.toUpperCase()}
                  </span>
                  {i === 0 && <span style={{ color: 'var(--color-border)' }}>|</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : isError ? (
        /* Error */
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-accent)' }}>
            <AlertTriangle size={48} />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 500, color: 'var(--color-text-primary)' }}>Export failed</p>
            <p
              style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--color-text-muted)', wordBreak: 'break-word' }}
            >
              {exportProgress?.error}
            </p>
          </div>
          {exportProgress?.diagnostics && exportProgress.diagnostics.length > 0 && (
            <div
              style={{
                textAlign: 'left',
                background: 'var(--color-surface)',
                borderRadius: '8px',
                padding: '12px',
                maxHeight: '112px',
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.048px',
                  color: 'var(--color-text-muted)',
                  marginBottom: '8px',
                }}
              >
                Export diagnostics
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {exportProgress.diagnostics.slice(-8).map((d, i) => (
                  <div
                    key={`${d}-${i}`}
                    style={{
                      fontSize: '12px',
                      color: 'var(--color-text-muted)',
                      fontFamily: 'monospace',
                      wordBreak: 'break-all',
                    }}
                  >
                    {d}
                  </div>
                ))}
              </div>
            </div>
          )}
          <SettingsButton onClick={handleCancelClick}>{onClose ? 'Close' : 'Try Again'}</SettingsButton>
        </div>
      ) : isCancelled ? (
        /* Cancelled — never presents a partial file as a result. */
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
            <AlertTriangle size={48} />
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 500, color: 'var(--color-text-primary)' }}>Export cancelled</p>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--color-text-muted)' }}>
              No file was written.
            </p>
          </div>
          <SettingsButton onClick={handleCancelClick}>{onClose ? 'Close' : 'Done'}</SettingsButton>
        </div>
      ) : (
        /* Progress */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {isRendering && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    fontSize: '13px',
                    color: 'var(--color-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <Loader2 size={14} className="animate-spin" />
                  Rendering scene {exportProgress.currentScene} of {exportProgress.totalScenes}
                </span>
                <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>
                  {Math.round(exportProgress.sceneProgress)}%
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {scenes.map((scene, i) => {
                  const sceneNum = i + 1
                  const isDone = sceneNum < exportProgress.currentScene
                  const isCurrent = sceneNum === exportProgress.currentScene
                  const progress = isDone ? 100 : isCurrent ? exportProgress.sceneProgress : 0
                  return (
                    <div key={scene.id}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '11px',
                          color: 'var(--color-text-muted)',
                          marginBottom: '2px',
                        }}
                      >
                        <span>
                          Scene {sceneNum}: {scene.name || scene.prompt.slice(0, 30) || 'Untitled'}
                        </span>
                        <span>{progress > 0 ? `${Math.round(progress)}%` : '—'}</span>
                      </div>
                      <div
                        style={{
                          height: '4px',
                          background: 'var(--color-surface)',
                          borderRadius: '999px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            background: 'var(--color-accent)',
                            borderRadius: '999px',
                            transition: 'width 0.3s',
                            width: `${progress}%`,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Cancel — only during per-scene render. Hidden once
                  finalize/mux starts so a torn MP4 can't result. */}
              {canCancelExport && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                  <SettingsButton onClick={() => cancelExport()}>Stop export</SettingsButton>
                </div>
              )}
            </div>
          )}

          {isMixingAudio && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0' }}>
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
              <div>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  Mixing audio...
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                  Combining TTS, SFX, and music tracks
                </p>
              </div>
            </div>
          )}

          {isStitching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 0' }}>
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
              <div>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  Stitching scenes...
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '13px', color: 'var(--color-text-muted)' }}>
                  Combining clips with FFmpeg
                </p>
              </div>
            </div>
          )}

          {exportProgress?.diagnostics && exportProgress.diagnostics.length > 0 && (
            <div
              style={{
                background: 'var(--color-surface)',
                borderRadius: '8px',
                padding: '12px',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.048px',
                  color: 'var(--color-text-muted)',
                  marginBottom: '8px',
                }}
              >
                Export diagnostics
              </div>
              <div
                style={{ maxHeight: '96px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                {exportProgress.diagnostics.slice(-6).map((d, i) => (
                  <div
                    key={`${d}-${i}`}
                    style={{
                      fontSize: '12px',
                      color: 'var(--color-text-muted)',
                      fontFamily: 'monospace',
                      wordBreak: 'break-all',
                    }}
                  >
                    {d}
                  </div>
                ))}
              </div>
            </div>
          )}

          {showCancelConfirm ? (
            <div
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text-primary)' }}>
                Cancel the export? Progress will be lost.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <SettingsButton onClick={() => setShowCancelConfirm(false)}>Continue</SettingsButton>
                <SettingsButton
                  variant="danger"
                  onClick={() => {
                    setShowCancelConfirm(false)
                    closeExportModal()
                  }}
                >
                  Cancel Export
                </SettingsButton>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
              <SettingsButton onClick={() => setShowCancelConfirm(true)}>Cancel</SettingsButton>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
