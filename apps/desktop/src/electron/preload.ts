import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DreambyteApi } from '../types/dreambyte-api'
import type { ElectronAPI } from '../types/electron'

// Buffer recent agent persist_done signals so a subscriber that
// registers AFTER main already forwarded the event (sub-second runs) still gets
// it via replay, instead of falling back to the ~600ms version poll. Bounded to
// the last N runIds (FIFO) so it can't grow unbounded across a long session.
const _persistDoneBuffer = new Map<string, boolean>()
const _PERSIST_DONE_BUFFER_MAX = 32
ipcRenderer.on(
  'dreambyte:agent.persistDone',
  (_evt: Electron.IpcRendererEvent, payload: { runId?: string; persistOk?: boolean }) => {
    if (!payload?.runId) return
    _persistDoneBuffer.set(payload.runId, payload.persistOk !== false)
    if (_persistDoneBuffer.size > _PERSIST_DONE_BUFFER_MAX) {
      const oldest = _persistDoneBuffer.keys().next().value
      if (oldest !== undefined) _persistDoneBuffer.delete(oldest)
    }
  },
)

// ── window.dreambyteApi — primary IPC namespace ───────────────────────────────
// `dreambyteApi.<category>.<method>()` invokes channel `dreambyte:<category>.<method>`.
// The smaller `window.electronAPI` surface below carries file-dialog / export helpers.

const dreambyteApi: DreambyteApi = {
  app: {
    onFlushBeforeQuit: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('dreambyte:app.flushBeforeQuit', listener)
      return () => ipcRenderer.removeListener('dreambyte:app.flushBeforeQuit', listener)
    },
    getVersion: () => ipcRenderer.invoke('dreambyte:app.getVersion'),
    copyText: (text: string) => ipcRenderer.invoke('dreambyte:app.copyText', text),
    captureWindow: () => ipcRenderer.invoke('dreambyte:app.captureWindow'),
  },
  settings: {
    listProviders: () => ipcRenderer.invoke('dreambyte:settings.listProviders'),
    getTelemetry: () => ipcRenderer.invoke('dreambyte:settings.getTelemetry'),
    setTelemetry: (args) => ipcRenderer.invoke('dreambyte:settings.setTelemetry', args),
    trackEvent: (args) => ipcRenderer.invoke('dreambyte:settings.trackEvent', args),
    listProviderKeys: () => ipcRenderer.invoke('dreambyte:settings.listProviderKeys'),
    setProviderKey: (args) => ipcRenderer.invoke('dreambyte:settings.setProviderKey', args),
  },
  branches: {
    list: (args) => ipcRenderer.invoke('dreambyte:branches.list', args),
    create: (args) => ipcRenderer.invoke('dreambyte:branches.create', args),
    rename: (args) => ipcRenderer.invoke('dreambyte:branches.rename', args),
    delete: (args) => ipcRenderer.invoke('dreambyte:branches.delete', args),
    setDefault: (args) => ipcRenderer.invoke('dreambyte:branches.setDefault', args),
    fork: (args) => ipcRenderer.invoke('dreambyte:branches.fork', args),
    listVersions: (args) => ipcRenderer.invoke('dreambyte:branches.listVersions', args),
    restoreVersion: (args) => ipcRenderer.invoke('dreambyte:branches.restoreVersion', args),
    history: (args) => ipcRenderer.invoke('dreambyte:branches.history', args),
    restoreToPoint: (args) => ipcRenderer.invoke('dreambyte:branches.restoreToPoint', args),
    listScenes: (args) => ipcRenderer.invoke('dreambyte:branches.listScenes', args),
    loadEditorScenes: (args) => ipcRenderer.invoke('dreambyte:branches.loadEditorScenes', args),
    getProposals: (args) => ipcRenderer.invoke('dreambyte:branches.getProposals', args),
    setProposal: (args) => ipcRenderer.invoke('dreambyte:branches.setProposal', args),
  },
  conversations: {
    list: (projectId) => ipcRenderer.invoke('dreambyte:conversations.list', projectId),
    create: (args) => ipcRenderer.invoke('dreambyte:conversations.create', args),
    get: (id) => ipcRenderer.invoke('dreambyte:conversations.get', id),
    update: (args) => ipcRenderer.invoke('dreambyte:conversations.update', args),
    delete: (id) => ipcRenderer.invoke('dreambyte:conversations.delete', id),
    listMessages: (id) => ipcRenderer.invoke('dreambyte:conversations.listMessages', id),
    addMessage: (args) => ipcRenderer.invoke('dreambyte:conversations.addMessage', args),
    updateMessage: (args) => ipcRenderer.invoke('dreambyte:conversations.updateMessage', args),
    clearMessages: (id) => ipcRenderer.invoke('dreambyte:conversations.clearMessages', id),
    deleteMessagesAfter: (args) => ipcRenderer.invoke('dreambyte:conversations.deleteMessagesAfter', args),
    search: (args) => ipcRenderer.invoke('dreambyte:conversations.search', args),
  },
  undoStacks: {
    save: (args) => ipcRenderer.invoke('dreambyte:undoStacks.save', args),
    load: (args) => ipcRenderer.invoke('dreambyte:undoStacks.load', args),
  },
  usage: {
    getSummary: (projectId, range) => ipcRenderer.invoke('dreambyte:usage.getSummary', projectId, range),
  },
  generationLog: {
    update: (args) => ipcRenderer.invoke('dreambyte:generationLog.update', args),
    list: (args) => ipcRenderer.invoke('dreambyte:generationLog.list', args),
  },
  permissions: {
    getSpend: () => ipcRenderer.invoke('dreambyte:permissions.getSpend'),
    listRules: () => ipcRenderer.invoke('dreambyte:permissions.listRules'),
    createRule: (args) => ipcRenderer.invoke('dreambyte:permissions.createRule', args),
    deleteRule: (id) => ipcRenderer.invoke('dreambyte:permissions.deleteRule', id),
  },
  skills: {
    readFile: (args) => ipcRenderer.invoke('dreambyte:skills.readFile', args),
    list: () => ipcRenderer.invoke('dreambyte:skills.list'),
  },
  rules: {
    list: (args) => ipcRenderer.invoke('dreambyte:rules.list', args),
    create: (input) => ipcRenderer.invoke('dreambyte:rules.create', input),
    update: (args) => ipcRenderer.invoke('dreambyte:rules.update', args),
    delete: (id) => ipcRenderer.invoke('dreambyte:rules.delete', id),
  },
  projects: {
    list: (args) => ipcRenderer.invoke('dreambyte:projects.list', args),
    create: (args) => ipcRenderer.invoke('dreambyte:projects.create', args),
    get: (projectId, branchId) => ipcRenderer.invoke('dreambyte:projects.get', projectId, branchId),
    getVersion: (projectId) => ipcRenderer.invoke('dreambyte:projects.getVersion', projectId),
    update: (args) => ipcRenderer.invoke('dreambyte:projects.update', args),
    delete: (projectId) => ipcRenderer.invoke('dreambyte:projects.delete', projectId),
    listAssets: (args) => ipcRenderer.invoke('dreambyte:projects.listAssets', args),
    updateBrandKit: (args) => ipcRenderer.invoke('dreambyte:projects.updateBrandKit', args),
    patchAsset: (args) => ipcRenderer.invoke('dreambyte:projects.patchAsset', args),
    deleteAsset: (args) => ipcRenderer.invoke('dreambyte:projects.deleteAsset', args),
    regenerateAsset: (args) => ipcRenderer.invoke('dreambyte:projects.regenerateAsset', args),
    uploadAsset: (args) => ipcRenderer.invoke('dreambyte:projects.uploadAsset', args),
    // Electron-only: resolve a renderer File (drag-drop / file input) to its
    // absolute path so uploads can stream from disk instead of copying the
    // bytes over IPC. Returns '' when unavailable (e.g. pasted blobs).
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
  tier2: {
    pickFolder: () => ipcRenderer.invoke('dreambyte:tier2.pickFolder'),
    setPath: (args) => ipcRenderer.invoke('dreambyte:tier2.setPath', args),
    export: (args) => ipcRenderer.invoke('dreambyte:tier2.export', args),
    import: (args) => ipcRenderer.invoke('dreambyte:tier2.import', args),
    revealInFinder: (args) => ipcRenderer.invoke('dreambyte:tier2.revealInFinder', args),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('dreambyte:workspaces.list'),
    get: (workspaceId) => ipcRenderer.invoke('dreambyte:workspaces.get', workspaceId),
    create: (args) => ipcRenderer.invoke('dreambyte:workspaces.create', args),
    update: (args) => ipcRenderer.invoke('dreambyte:workspaces.update', args),
    delete: (workspaceId) => ipcRenderer.invoke('dreambyte:workspaces.delete', workspaceId),
  },
  publish: {
    run: (args) => ipcRenderer.invoke('dreambyte:publish.run', args),
  },
  scene: {
    writeHtml: (args) => ipcRenderer.invoke('dreambyte:scene.writeHtml', args),
    get: (args) => ipcRenderer.invoke('dreambyte:scene.get', args),
    readHtml: (args) => ipcRenderer.invoke('dreambyte:scene.readHtml', args),
  },
  sceneErrors: {
    report: (args) => ipcRenderer.invoke('dreambyte:sceneErrors.report', args),
  },
  git: {
    init: (args) => ipcRenderer.invoke('dreambyte:git.init', args),
    status: (args) => ipcRenderer.invoke('dreambyte:git.status', args),
    commit: (args) => ipcRenderer.invoke('dreambyte:git.commit', args),
    log: (args) => ipcRenderer.invoke('dreambyte:git.log', args),
    branchList: (args) => ipcRenderer.invoke('dreambyte:git.branchList', args),
    branchCreate: (args) => ipcRenderer.invoke('dreambyte:git.branchCreate', args),
    checkout: (args) => ipcRenderer.invoke('dreambyte:git.checkout', args),
    diff: (args) => ipcRenderer.invoke('dreambyte:git.diff', args),
    listActionsForRange: (args) => ipcRenderer.invoke('dreambyte:git.listActionsForRange', args),
    remoteAdd: (args) => ipcRenderer.invoke('dreambyte:git.remoteAdd', args),
    remoteList: (args) => ipcRenderer.invoke('dreambyte:git.remoteList', args),
    setRemoteToken: (args) => ipcRenderer.invoke('dreambyte:git.setRemoteToken', args),
    hasRemoteToken: (args) => ipcRenderer.invoke('dreambyte:git.hasRemoteToken', args),
    clearRemoteToken: (args) => ipcRenderer.invoke('dreambyte:git.clearRemoteToken', args),
    push: (args) => ipcRenderer.invoke('dreambyte:git.push', args),
    pull: (args) => ipcRenderer.invoke('dreambyte:git.pull', args),
  },
  actionLog: {
    append: (args) => ipcRenderer.invoke('dreambyte:actionLog.append', args),
  },
  media: {
    upload: (args) => ipcRenderer.invoke('dreambyte:media.upload', args),
  },
  tts: {
    synthesize: (args) => ipcRenderer.invoke('dreambyte:tts.synthesize', args),
    listVoices: (provider) => ipcRenderer.invoke('dreambyte:tts.listVoices', provider),
    recordVoiceConsent: (args) => ipcRenderer.invoke('dreambyte:tts.recordVoiceConsent', args),
  },
  sfx: {
    search: (args) => ipcRenderer.invoke('dreambyte:sfx.search', args),
    generate: (args) => ipcRenderer.invoke('dreambyte:sfx.generate', args),
  },
  music: {
    generate: (args) => ipcRenderer.invoke('dreambyte:music.generate', args),
  },
  agent: {
    start: (body) => ipcRenderer.invoke('dreambyte:agent.start', body),
    abort: (runId) => ipcRenderer.invoke('dreambyte:agent.abort', { runId }),
    captureResponse: (payload) => ipcRenderer.invoke('dreambyte:agent.captureResponse', payload),
    exportResponse: (payload) => ipcRenderer.invoke('dreambyte:agent.exportResponse', payload),
    steer: (payload) => ipcRenderer.invoke('dreambyte:agent.steer', payload),
    clipResponse: (payload) => ipcRenderer.invoke('dreambyte:agent.clipResponse', payload),
    activeRunIds: () => ipcRenderer.invoke('dreambyte:agent.activeRunIds'),
    subscribe: (runId, handler) => {
      // Single shared listener filters by runId. Without filtering, two
      // concurrent runs (different windows or rapid succession) would
      // cross-deliver events and the consumer would mis-route them.
      const listener = (
        _evt: Electron.IpcRendererEvent,
        payload: { runId: string; event: Record<string, unknown> },
      ) => {
        if (payload?.runId === runId) handler(payload.event)
      }
      ipcRenderer.on('dreambyte:agent.event', listener)
      return () => {
        ipcRenderer.removeListener('dreambyte:agent.event', listener)
      }
    },
    // Ack that the per-runId listener (above) is attached so the main process
    // flushes any events it buffered during the start→subscribe window. Always
    // invoke AFTER `subscribe`.
    subscribed: (runId) => ipcRenderer.invoke('dreambyte:agent.subscribed', { runId }),
    // Out-of-band "scenes persisted" signal for a run, keyed by runId. This
    // channel is independent of the per-run event subscription above (which the
    // renderer tears down on abort), so the post-run refresh can wait for the
    // durable write even on the error/abort paths. Subscribe BEFORE awaiting the
    // run; the handler fires once when main forwards persist completion.
    onPersistDone: (runId, handler) => {
      const listener = (_evt: Electron.IpcRendererEvent, payload: { runId: string; persistOk: boolean }) => {
        if (payload?.runId === runId) handler(payload.persistOk)
      }
      ipcRenderer.on('dreambyte:agent.persistDone', listener)
      // A sub-second run can forward persist_done from main
      // BEFORE this subscription registers, so the live listener misses it and
      // the caller falls back to the ~600ms version poll. The module-level
      // buffer below records every persistDone; replay a buffered hit for this
      // runId on the next microtask so the fast path still fires. (Belt-and-
      // suspenders: the live listener stays registered; waitForRunPersist's
      // finish() is idempotent, so a double-fire is harmless.)
      const buffered = _persistDoneBuffer.get(runId)
      if (buffered !== undefined) {
        Promise.resolve().then(() => handler(buffered))
      }
      return () => ipcRenderer.removeListener('dreambyte:agent.persistDone', listener)
    },
    // Phase C.2 cross-project dispatch.
    dispatchProjects: (args) => ipcRenderer.invoke('dreambyte:agent.dispatchProjects', args),
    abortCrossProject: (groupId) => ipcRenderer.invoke('dreambyte:agent.abortCrossProject', { groupId }),
    // Subscribe to a cross-project group's leg events (separate channel from
    // `dreambyte:agent.event` — the consumer is a dedicated run view that NEVER
    // mutates the active project's store). Filters by groupId.
    subscribeCrossProject: (groupId, handler) => {
      const listener = (
        _evt: Electron.IpcRendererEvent,
        msg: { groupId: string; originProjectId: string; targetProjectId: string; runId: string; event: Record<string, unknown> },
      ) => {
        if (msg?.groupId === groupId) handler(msg)
      }
      ipcRenderer.on('dreambyte:agent.crossProjectEvent', listener)
      return () => {
        ipcRenderer.removeListener('dreambyte:agent.crossProjectEvent', listener)
      }
    },
  },
  agents: {
    detectCli: () => ipcRenderer.invoke('dreambyte:agents.detectCli'),
    mcpInstallInfo: () => ipcRenderer.invoke('dreambyte:agents.mcpInstallInfo'),
  },
  characters: {
    list: (projectId) => ipcRenderer.invoke('dreambyte:characters.list', projectId),
    reuse: (args) => ipcRenderer.invoke('dreambyte:characters.reuse', args),
  },
  generate: {
    canvas: (args) => ipcRenderer.invoke('dreambyte:generate.canvas', args),
    motion: (args) => ipcRenderer.invoke('dreambyte:generate.motion', args),
    three: (args) => ipcRenderer.invoke('dreambyte:generate.three', args),
    react: (args) => ipcRenderer.invoke('dreambyte:generate.react', args),
    lottie: (args) => ipcRenderer.invoke('dreambyte:generate.lottie', args),
    d3: (args) => ipcRenderer.invoke('dreambyte:generate.d3', args),
    image: (args) => ipcRenderer.invoke('dreambyte:generate.image', args),
    avatar: (args) => ipcRenderer.invoke('dreambyte:generate.avatar', args),
    video: (args) => ipcRenderer.invoke('dreambyte:generate.video', args),
    lipsync: (args) => ipcRenderer.invoke('dreambyte:generate.lipsync', args),
    pollHeygen: (videoId) => ipcRenderer.invoke('dreambyte:generate.pollHeygen', videoId),
    pollVideo: (args) => ipcRenderer.invoke('dreambyte:generate.pollVideo', args),
    svg: (args) => ipcRenderer.invoke('dreambyte:generate.svg', args),
    enhancePrompt: (args) => ipcRenderer.invoke('dreambyte:generate.enhancePrompt', args),
    summarize: (args) => ipcRenderer.invoke('dreambyte:generate.summarize', args),
    editSvg: (args) => ipcRenderer.invoke('dreambyte:generate.editSvg', args),
    // Reactive generation jobs: the main-process runner pushes a job-status change here when
    // a generation advances (succeeded/failed). The renderer subscribes once at boot and applies
    // the finished asset by jobId/layerId — no agent polling required. Broadcast channel; the
    // store filters to jobs it knows about.
    onUpdate: (handler) => {
      const listener = (_evt: Electron.IpcRendererEvent, update: Parameters<typeof handler>[0]) => handler(update)
      ipcRenderer.on('dreambyte:generation.update', listener)
      return () => ipcRenderer.removeListener('dreambyte:generation.update', listener)
    },
  },
}

contextBridge.exposeInMainWorld('dreambyteApi', dreambyteApi)

// ── window.electronAPI — file dialogs, recording, and export helpers ───────────
const api: ElectronAPI = {
  saveDialog: (suggestedName?: string) => ipcRenderer.invoke('dreambyte:saveDialog', suggestedName),
  chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke('dreambyte:chooseDirectory', defaultPath),
  getDefaultExportDir: () => ipcRenderer.invoke('dreambyte:getDefaultExportDir'),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('dreambyte:showItemInFolder', filePath),
  openPath: (filePath: string) => ipcRenderer.invoke('dreambyte:openPath', filePath),
  writeFile: (args) => ipcRenderer.invoke('dreambyte:writeFile', args),
  cleanupExportArtifacts: (args) => ipcRenderer.invoke('dreambyte:cleanupExportArtifacts', args),
  saveRecording: (args) => ipcRenderer.invoke('dreambyte:saveRecording', args),
  concatMp4: (args) => ipcRenderer.invoke('dreambyte:concatMp4', args),
  capturePage: (args) => ipcRenderer.invoke('dreambyte:capturePage', args),
  saveRecordingSession: (args) => ipcRenderer.invoke('dreambyte:saveRecordingSession', args),
  startCursorTelemetry: () => ipcRenderer.invoke('dreambyte:startCursorTelemetry'),
  stopCursorTelemetry: () => ipcRenderer.invoke('dreambyte:stopCursorTelemetry'),
  exportTier3: (args) => ipcRenderer.invoke('dreambyte:exportTier3', args),
  exportBurnCaptions: (args) => ipcRenderer.invoke('dreambyte:export.burnCaptions', args),
  exportTier3Scene: (args) => ipcRenderer.invoke('dreambyte:exportTier3Scene', args),
  exportFcpxml: (args) => ipcRenderer.invoke('dreambyte:export.fcpxml', args),
  onExportTier3Progress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: { phase: string; currentScene: number; totalScenes: number; sceneProgress: number },
    ) => cb(p)
    ipcRenderer.on('dreambyte:exportTier3:progress', listener)
    return () => ipcRenderer.removeListener('dreambyte:exportTier3:progress', listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
