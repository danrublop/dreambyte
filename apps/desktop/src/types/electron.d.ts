export {}

export interface DesktopSource {
  id: string
  name: string
  thumbnailDataUrl: string
  appIconDataUrl: string | null
  displayId: string
}

export type RecordingCommand = 'start' | 'stop' | 'pause' | 'resume' | 'cancel' | null
export type RecordingStoreState = 'idle' | 'recording' | 'paused' | 'saving'

export interface RecordingConfig {
  micEnabled: boolean
  micDeviceId: string | null
  systemAudioEnabled: boolean
  webcamEnabled: boolean
  webcamDeviceId: string | null
  fps: number
  resolution: '720p' | '1080p' | '1440p' | '2160p' | 'source'
}

export interface RecordingSessionManifest {
  screenVideoPath: string
  screenVideoUrl: string
  webcamVideoPath?: string
  webcamVideoUrl?: string
  cursorTelemetry?: Array<{ t: number; x: number; y: number }>
  createdAt: number
}

/** `window.electronAPI` — file dialogs, recording, and export helpers. Single source of
 *  truth: `src/electron/preload.ts` implements it (`const api: ElectronAPI`). */
export type ElectronAPI = {
  saveDialog: (suggestedName?: string) => Promise<{ canceled: boolean; filePath: string | null }>
  /** Pick a directory (no filename). Used by Export panel "Save to" field. */
  chooseDirectory: (defaultPath?: string) => Promise<{ canceled: boolean; dirPath: string | null }>
  /** Default location for saving exports (the system Downloads folder). */
  getDefaultExportDir: () => Promise<{ dirPath: string }>
  /** Reveal the file in Finder/Explorer/Files. */
  showItemInFolder: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Open the file with its default OS application. */
  openPath: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>
  writeFile: (args: { filePath: string; bytes: ArrayBuffer }) => Promise<{ ok: true }>
  /** Best-effort delete of cancelled/failed export artifacts. */
  cleanupExportArtifacts: (args: { paths: string[] }) => Promise<{ ok: true; deleted: string[] }>
  saveRecording: (args: {
    bytes: ArrayBuffer
    extension?: string
    nameHint?: string
  }) => Promise<{ ok: true; filePath: string; fileUrl: string }>
  concatMp4: (args: {
    inputs: string[]
    output: string
    cleanup?: boolean
    transitions?: Array<{ type: string; duration?: number }>
    /** Force a re-encode on the cuts path (mixed-engine parts can't stream-copy). */
    reencode?: boolean
    /** Post-stitch loudness-normalize the final output to this LUFS target. */
    normalizeTargetLufs?: number
    /** Standalone timeline audio overlaid between stitch and loudnorm
     *  (same ordering as the all-tier3 path). */
    timelineAudio?: Array<{
      src: string
      startTime: number
      duration: number
      trimStart: number
      speed: number
      gain: number
      gainEnvelope?: Array<{ t: number; v: number }>
    }>
    masterVolume?: number
  }) => Promise<{ ok: true; programAudio: 'applied' | 'failed' | null }>
  capturePage: (args?: {
    rect?: { x: number; y: number; width: number; height: number }
  }) => Promise<{ ok: true; dataUri: string; mimeType: string } | { ok: false; error: string }>
  saveRecordingSession: (args: {
    screenBytes: ArrayBuffer
    webcamBytes?: ArrayBuffer
    nameHint?: string
  }) => Promise<RecordingSessionManifest>
  startCursorTelemetry: () => Promise<{ ok: true }>
  stopCursorTelemetry: () => Promise<{ samples: Array<{ t: number; x: number; y: number }> }>
  /** Tier 3 real-compositor MP4 export (offscreen capture + single FFmpeg pass, main process). */
  exportTier3: (args: {
    scenes: Array<{
      id: string
      html: string
      durationSeconds: number
      sceneType?: string
      bgColor?: string
      transition?: string
      audioLayer?: Record<string, unknown> | null
      /** Scene carries a <video> needing frame-seek in the composite path. */
      isVideoScene?: boolean
    }>
    outputPath: string
    fps: number
    width: number
    height: number
    profile?: 'fast' | 'quality'
    superSample?: number
    timelineAudio?: Array<{
      src: string
      startTime: number
      duration: number
      trimStart: number
      speed: number
      gain: number
    }>
    masterVolume?: number
    burnCaptionsSrt?: string
    /** NLE timeline — when present, main routes to the single-stream
     *  composite export (gaps + V2-over-V1). Plain serializable data over IPC. */
    timeline?: unknown
  }) => Promise<{
    ok: true
    outputPath: string
    captionsBurned: boolean | null
    /** null = no timeline audio requested; 'failed' = requested but none made it into the MP4. */
    programAudio: 'applied' | 'failed' | null
    /** True when the export's only narration came from a client-only TTS provider
     *  (web-speech / puter) that can't render to audio — the MP4 is silent. */
    clientOnlyNarration?: boolean
  }>
  /** A3 caption burn-in for the renderer-driven (mixed/legacy) paths: hardcode
   *  SRT captions into the finished MP4 in place (one ffmpeg re-encode).
   *  totalSeconds/fps are optional timeout-scaling hints (long 4K burns). */
  exportBurnCaptions: (args: {
    filePath: string
    srt: string
    width: number
    height: number
    totalSeconds?: number
    fps?: number
  }) => Promise<{ ok: boolean }>
  /** Tier 3 single-scene capture for the renderer's mixed-engine path. Returns the intermediate mp4 path. */
  exportTier3Scene: (args: {
    spec: {
      id: string
      html: string
      durationSeconds: number
      sceneType?: string
      bgColor?: string
      transition?: string
      audioLayer?: Record<string, unknown> | null
    }
    fps: number
    width: number
    height: number
    profile?: 'fast' | 'quality'
    intermediateCodec: 'lossless' | 'crf14'
    superSample?: number
  }) => Promise<{ ok: true; outputPath: string }>
  /** Subscribe to Tier 3 export progress. Returns an unsubscribe fn. */
  onExportTier3Progress: (
    cb: (p: { phase: string; currentScene: number; totalScenes: number; sceneProgress: number }) => void,
  ) => () => void
  /** FCPXML 1.9 interchange export: serialize the timeline + Save dialog + write.
   *  Resolves real file:// asset paths in the main process so the host NLE relinks. */
  exportFcpxml: (args: {
    timeline: unknown
    fps?: number
    width?: number
    height?: number
    name?: string
    defaultFileName?: string
  }) => Promise<{
    saved: boolean
    canceled?: boolean
    path?: string
    clipCount?: number
    skipped?: Array<{ clipId: string; sourceType: string; reason: string }>
    error?: string
  }>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
