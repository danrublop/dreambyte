// Single source of truth for `window.dreambyteApi` — the primary IPC namespace
// (the smaller `window.electronAPI` surface is typed in src/types/electron.d.ts).
// `src/electron/preload.ts` implements this type (`const dreambyteApi: DreambyteApi`), so
// a drift between the bridge and these declarations is a compile error.

export {}

export type TTSProviderId =
  | 'elevenlabs'
  | 'openai-tts'
  | 'gemini-tts'
  | 'google-tts'
  | 'openai-edge-tts'
  | 'pocket-tts'
  | 'voxcpm'
  | 'native-tts'
  | 'puter'
  | 'web-speech'

export type SFXProviderId = 'elevenlabs-sfx' | 'freesound' | 'pixabay'
export type MusicProviderId = 'pixabay-music' | 'freesound-music'

export interface BranchRecord {
  id: string
  projectId: string
  name: string
  isDefault: boolean
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export interface BranchSceneMeta {
  id: string
  name: string | null
  position: number
  duration: number
  thumbnailUrl: string | null
}

export interface SceneVersionMeta {
  id: string
  sceneId: string
  branchId: string
  versionNumber: number
  operation: string | null
  label: string | null
  batchId: string | null
  createdAt: Date
}

/** One entry in the branch-wide history timeline (operations collapsed by batch). */
export interface BranchHistoryEntry {
  /** Stable restore handle: the batchId, or the row id for legacy null-batch rows. */
  key: string
  batchId: string | null
  operation: string | null
  label: string | null
  source: string
  createdAt: Date
  /** How many distinct scenes this operation changed. */
  sceneCount: number
}

export interface ListProvidersResult {
  providers: {
    tts: { id: TTSProviderId; name: string; available: boolean }[]
    sfx: { id: SFXProviderId; name: string; available: boolean }[]
    music: { id: MusicProviderId; name: string; available: boolean }[]
  }
  media: {
    id: string
    name: string
    category: 'video' | 'image' | 'avatar' | 'utility'
    available: boolean
  }[]
}

export interface ConversationSummary {
  id: string
  projectId: string
  title: string | null
  isPinned: boolean
  isArchived: boolean
  createdAt: string
  updatedAt: string
  messageCount?: number
  lastMessageAt?: string | null
}

export interface ConversationSearchResult {
  conversationId: string
  projectId: string
  title: string
  matchedOn: 'title' | 'message'
  snippet?: string
}

export interface StoredMessage {
  id: string
  conversationId: string
  projectId: string
  role: 'user' | 'assistant'
  content: string
  status?: string | null
  agentType?: string | null
  modelUsed?: string | null
  thinkingContent?: string | null
  toolCalls?: unknown
  contentSegments?: unknown
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  durationMs?: number | null
  apiCalls?: number | null
  userRating?: number | null
  generationLogId?: string | null
  /** Monotonic sequence for the streaming incremental persist. */
  seq?: number | null
  /** The IPC runId that produced this row (S6 — precise orphan detection). */
  runId?: string | null
  createdAt: string
}

export interface UsageBreakdown {
  inputTokens: number
  outputTokens: number
  costUsd: number
  count: number
}

export interface UsageRun {
  runId: string
  parentRunId: string | null
  agentType: string
  costUsd: number
  outcome: string | null
  durationMs: number
}

export interface UsageSummary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalApiCalls: number
  totalToolCalls: number
  totalRuns: number
  errorRuns: number
  byAgent: Record<string, UsageBreakdown>
  byProvider: Record<string, UsageBreakdown>
  byModel: Record<string, UsageBreakdown>
  byMonth: Array<UsageBreakdown & { month: string }>
  runs: UsageRun[]
}

export type GenerationLogDimension = 'scene_type' | 'model_used' | 'thinking_mode' | 'style_preset_id' | 'agent_type'

export interface DreambyteApi {
  /** App lifecycle bridge. */
  app: {
    /** Subscribe to the main-process `before-quit` best-effort chat flush. The renderer
     *  flushes its in-flight streaming assistant message so a Cmd-Q mid-stream doesn't
     *  lose the partial. Returns an unsubscribe fn. */
    onFlushBeforeQuit(cb: () => void): () => void
    /** Running app version string (e.g. "0.7.16.0"). */
    getVersion(): Promise<{ version: string }>
    /** Native clipboard write via the main process — reliable under the custom
     *  `dreambyte://` scheme where navigator.clipboard may be undefined. */
    copyText(text: string): Promise<{ ok: boolean }>
    /** Capture the focused window as a downscaled PNG data URL (feedback widget). */
    captureWindow(): Promise<{ dataUrl: string | null }>
  }
  settings: {
    /** List audio + media provider availability based on configured API keys. */
    listProviders(): Promise<ListProvidersResult>
    /** Read the current telemetry opt-in state. Cheap (file stat). */
    getTelemetry(): Promise<{ enabled: boolean }>
    /** Toggle telemetry. Persists to a file marker; takes effect next launch. */
    setTelemetry(args: { enabled: boolean }): Promise<{ ok: boolean }>
    /** Forward a renderer-side event to the main-process telemetry queue. */
    trackEvent(args: { event: string; properties?: Record<string, unknown> }): Promise<{ ok: boolean }>
    /** BYOK: list configured provider keys. Never returns plaintext — only
     *  `{ provider, envVar, hasKey, maskedPreview }` rows. */
    listProviderKeys(): Promise<{
      keys: { provider: string; envVar: string; hasKey: boolean; maskedPreview: string | null }[]
    }>
    /** BYOK: save or clear a provider's API key. Passing `null` or empty string clears
     *  it. Drops cached provider clients so the next agent request re-reads the key. */
    setProviderKey(args: { provider: string; apiKey: string | null }): Promise<{ ok: boolean }>
  }
  agent: {
    /**
     * Start a streaming agent run. Returns the runId; events arrive via `subscribe`.
     * Subscribe BEFORE starting so events emitted synchronously by the runner
     * (run_start) are not dropped.
     */
    start(body: Record<string, unknown>): Promise<{ runId: string }>
    abort(runId: string): Promise<{ ok: boolean }>
    captureResponse(payload: {
      captureId: string
      dataUri?: string
      mimeType?: string
      error?: string
    }): Promise<{ ok: boolean }>
    exportResponse(payload: {
      exportId: string
      outputPath?: string
      error?: string
      /** 11b — failing-scene context for scene-scoped render errors (1-based). */
      sceneIndex?: number
      sceneId?: string
    }): Promise<{ ok: boolean }>
    steer(payload: { runId: string; id: string; text: string }): Promise<{ ok: boolean }>
    clipResponse(payload: { clipId: string; dataUri?: string; mimeType?: string; error?: string }): Promise<{
      ok: boolean
    }>
    /**
     * Subscribe to events for a runId. Returns an unsubscribe fn. The framework inserts a
     * synthetic `{ type: '__stream_end__' }` after the last real event so consumers can
     * resolve without waiting for `done` (which the runner may not emit on hard crashes).
     */
    subscribe(runId: string, handler: (event: Record<string, unknown>) => void): () => void
    /**
     * Ack that the `subscribe` listener for `runId` is attached. Main buffers events
     * emitted before this ack and flushes them in order. MUST be called AFTER `subscribe`.
     */
    subscribed(runId: string): Promise<{ ok: boolean }>
    /**
     * Out-of-band "scenes persisted" signal for `runId`. Fires once with `persistOk`
     * after main completes the post-run DB write (success, error, OR abort). Returns an
     * unsubscribe fn. Subscribe BEFORE awaiting the run.
     */
    onPersistDone(runId: string, handler: (persistOk: boolean) => void): () => void
    /** RunIds currently in flight on the main process (orphaned-stream detection). */
    activeRunIds(): Promise<{ runIds: string[] }>
    /** Phase C.2 — fan one agent run across N target projects, each isolated. Leg
     *  events arrive via `subscribeCrossProject(groupId, ...)`. */
    dispatchProjects(args: {
      originBody: Record<string, unknown>
      targets: string[]
      instruction: string
      groupBudgetUsd?: number | null
    }): Promise<{ groupId: string; outcomes: Array<{ targetProjectId: string; runId: string; status: string }> }>
    abortCrossProject(groupId: string): Promise<{ ok: boolean }>
    subscribeCrossProject(
      groupId: string,
      handler: (msg: {
        groupId: string
        originProjectId: string
        targetProjectId: string
        runId: string
        event: Record<string, unknown>
      }) => void,
    ): () => void
  }
  branches: {
    list(args: { projectId: string }): Promise<{ branches: BranchRecord[] }>
    create(args: { projectId: string; name: string; sourceBranchId?: string }): Promise<{ branch: BranchRecord }>
    rename(args: { projectId: string; id: string; name: string }): Promise<{ branch: BranchRecord }>
    delete(args: { projectId: string; id: string }): Promise<{ success: true; deletedSceneCount: number }>
    /** Make a branch the project's default, atomically swapping the old default. */
    setDefault(args: { projectId: string; id: string }): Promise<{ branch: BranchRecord }>
    /** Fork a branch into a brand-new standalone project (deep-copies scenes + assets). */
    fork(args: {
      sourceProjectId: string
      sourceBranchId: string
      name?: string
    }): Promise<{ projectId: string; sceneCount: number; assetCount: number }>
    listVersions(args: {
      projectId: string
      sceneId: string
      branchId: string
    }): Promise<{ versions: SceneVersionMeta[] }>
    restoreVersion(args: {
      projectId: string
      versionId: string
    }): Promise<{ success: true; newVersionNumber: number; sceneId: string }>
    /** Branch-wide history timeline, newest first, operations collapsed by batch. */
    history(args: {
      projectId: string
      branchId: string
      limit?: number
      /** Pagination cursor: epoch ms; returns entries strictly older than this. */
      before?: number
      /** Compound keyset half of the cursor: the LAST entry's `key`. With it,
       *  entries in the same second as `before` page correctly (keys below the
       *  cursor key still surface) instead of being silently dropped. */
      beforeKey?: string
    }): Promise<{ entries: BranchHistoryEntry[] }>
    /** Restore the whole branch to one history entry (batch). Reverts every scene
     *  the batch touched and returns the affected scene ids. */
    restoreToPoint(args: {
      projectId: string
      branchId: string
      key: string
    }): Promise<{ success: true; restoredSceneIds: string[] }>
    listScenes(args: { projectId: string; branchId: string }): Promise<{ scenes: BranchSceneMeta[] }>
    loadEditorScenes(args: {
      projectId: string
      branchId: string
    }): Promise<{ scenes: unknown[]; sceneGraph: unknown | null }>
    // Branch-scoped agent proposals (0015). branchId null = default branch.
    getProposals(args: {
      projectId: string
      branchId: string | null
    }): Promise<{ proposals: Record<string, unknown> | null }>
    setProposal(args: {
      projectId: string
      branchId: string | null
      field: string
      value: unknown
    }): Promise<{ version: number }>
  }
  conversations: {
    list(projectId: string): Promise<{ conversations: ConversationSummary[] }>
    create(args: { projectId: string; title?: string }): Promise<{ conversation: ConversationSummary }>
    get(id: string): Promise<{ conversation: ConversationSummary; messages: StoredMessage[] }>
    update(args: {
      id: string
      updates: { title?: string; isPinned?: boolean; isArchived?: boolean }
    }): Promise<{ conversation: ConversationSummary }>
    delete(id: string): Promise<{ success: true }>
    listMessages(id: string): Promise<{ messages: StoredMessage[] }>
    addMessage(args: {
      id?: string
      messageId?: string
      conversationId: string
      projectId: string
      role: 'user' | 'assistant'
      content: string
      status?: string
      /** Monotonic sequence for the streaming incremental persist. */
      seq?: number | null
      /** The IPC runId that produced this row (S6 — precise orphan detection). */
      runId?: string | null
      agentType?: string
      modelUsed?: string
      thinkingContent?: string
      toolCalls?: unknown
      contentSegments?: unknown
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
      durationMs?: number
      apiCalls?: number
      userRating?: number | null
      generationLogId?: string
      _method?: 'PUT'
    }): Promise<{ message?: StoredMessage; success?: true }>
    updateMessage(args: {
      conversationId: string
      messageId: string
      userRating?: number | null
      content?: string
      status?: string
      /** Monotonic sequence for the streaming incremental persist. */
      seq?: number | null
      /** The IPC runId that produced this row (S6 — precise orphan detection). */
      runId?: string | null
      agentType?: string
      modelUsed?: string
      thinkingContent?: string
      toolCalls?: unknown
      contentSegments?: unknown
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
      durationMs?: number
      apiCalls?: number
      generationLogId?: string
    }): Promise<{ success: true; applied: boolean }>
    clearMessages(id: string): Promise<{ success: true }>
    /**
     * Tail-delete the conversation after a message (rewind primitive).
     * Optionally swaps `messageId`'s content (the edit case) in the same
     * transaction. Unknown messageId ⇒ `{ found: false }` with zero mutation.
     * Returns the surviving messages so the store can splice in lockstep.
     */
    deleteMessagesAfter(args: {
      conversationId: string
      messageId: string
      newContent?: string
    }): Promise<{ found: boolean; remaining: unknown[] }>
    /**
     * Global conversation search for the command palette. Matches
     * titles + message content (case-insensitive LIKE, LIMIT 50). Archived
     * conversations are excluded unless `includeArchived` is set.
     */
    search(args: {
      query: string
      includeArchived?: boolean
      limit?: number
    }): Promise<{ results: ConversationSearchResult[] }>
  }
  /** Durable undo/redo stacks, one row per (projectId, branchId). */
  undoStacks: {
    save(args: { projectId: string; branchId: string | null; payload: string }): Promise<{ success: boolean }>
    load(args: { projectId: string; branchId: string | null }): Promise<{ payload: string | null }>
  }
  usage: {
    getSummary(projectId?: string, range?: { days: number }): Promise<UsageSummary>
  }
  generationLog: {
    update(args: {
      logId: string
      userAction?: string
      timeToActionMs?: number
      editDistance?: number
      userRating?: number
      exportSucceeded?: boolean
      exportErrorMessage?: string
      generatedCodeLength?: number
    }): Promise<{ success: true }>
    list(args: { projectId?: string; sceneId?: string; limit?: number; offset?: number }): Promise<{ logs: unknown[] }>
  }
  permissions: {
    /** Per-API session + monthly spend tracking. */
    getSpend(): Promise<Record<string, { sessionSpend: number; monthlySpend: number }>>
    /** List all layered permission rules owned by the desktop user. */
    listRules(): Promise<{ rules: import('@/lib/types/permissions').PermissionRule[] }>
    /** Create a layered rule. id/userId/createdAt are filled by the server. */
    createRule(args: {
      scope: import('@/lib/types/permissions').PermissionScope
      workspaceId?: string | null
      projectId?: string | null
      conversationId?: string | null
      decision: import('@/lib/types/permissions').PermissionDecision
      api: import('@/lib/types/permissions').APIName | '*'
      specifier?: import('@/lib/types/permissions').RuleSpecifier | null
      costCapUsd?: number | null
      expiresAt?: string | null
      createdBy?: 'user-settings' | 'dialog' | 'migration' | 'admin'
      notes?: string | null
    }): Promise<{ rule: import('@/lib/types/permissions').PermissionRule }>
    /** Delete a rule by id. `{ ok: false }` if no row matched. */
    deleteRule(id: string): Promise<{ ok: boolean }>
  }
  skills: {
    /** Read a markdown skill file from the bundled skill trees. */
    readFile(args: { source: string; file: string }): Promise<{ content: string; file: string; source: string }>
    /** Full Dreambyte skill index (frontmatter only) + total count. */
    list(): Promise<{
      skills: { id: string; name: string; description: string; category: string; source: string }[]
      count: number
    }>
  }
  /** Behavior-guidance rules (Settings → Rules). Local-only, scope user|project. */
  rules: {
    list(args: { scope: 'user' | 'project'; projectId?: string | null }): Promise<{
      rules: import('@/lib/types/rules').RuleConfig[]
    }>
    create(input: import('@/lib/types/rules').CreateRuleInput): Promise<{
      rule: import('@/lib/types/rules').RuleConfig
    }>
    update(args: { id: string; patch: import('@/lib/types/rules').UpdateRuleInput }): Promise<{
      rule: import('@/lib/types/rules').RuleConfig | null
    }>
    delete(id: string): Promise<{ ok: boolean }>
  }
  projects: {
    list(args?: {
      limit?: number
      cursor?: string
      workspaceId?: string | 'none'
    }): Promise<Array<Record<string, unknown>> | { items: Array<Record<string, unknown>>; nextCursor: string | null }>
    create(args: Record<string, unknown>): Promise<Record<string, unknown>>
    /**
     * Loads the project. `branchId` scopes the returned scenes/sceneGraph to
     * that branch (must belong to the project); omitted = default branch.
     */
    get(projectId: string, branchId?: string): Promise<Record<string, unknown>>
    getVersion(
      projectId: string,
    ): Promise<{ version: number; updatedAt: Date; sceneCount: number; hasRichContent: boolean }>
    update(args: { projectId: string; updates: Record<string, unknown> }): Promise<Record<string, unknown>>
    delete(projectId: string): Promise<{ ok: true }>
    listAssets(args: {
      projectId: string
      type?: 'image' | 'video' | 'svg'
      source?: 'upload' | 'generated'
    }): Promise<{ assets: unknown[] }>
    updateBrandKit(args: { projectId: string; updates: Record<string, unknown> }): Promise<{ brandKit: unknown }>
    /** Partial update of a single project asset (rename / retag). */
    patchAsset(args: {
      projectId: string
      assetId: string
      name?: string
      tags?: string[]
    }): Promise<{ asset: Record<string, unknown> }>
    /** Delete an asset row + its on-disk storage + thumbnail. */
    deleteAsset(args: { projectId: string; assetId: string }): Promise<{ success: true }>
    /**
     * Regenerate an image asset as a sibling record (parentAssetId points
     * to the original). Optional overrides can change the prompt, model,
     * aspectRatio, or enrichment tags.
     */
    regenerateAsset(args: {
      projectId: string
      assetId: string
      promptOverride?: string
      model?: string
      aspectRatio?: string
      enhanceTags?: string[]
    }): Promise<{ asset: Record<string, unknown>; cost: number; finalPrompt: string }>
    /**
     * Upload a user-supplied file (image / SVG / video) and persist it as a
     * project asset. Allowlist (JPEG, PNG, WebP, GIF, SVG, MP4, MOV,
     * WebM) and per-type size cap (10MB images, 100MB video). Returns
     * the freshly inserted asset row.
     */
    uploadAsset(args: {
      projectId: string
      /** Exactly one of data | filePath (filePath streams from disk in main). */
      data?: ArrayBuffer
      filePath?: string
      mimeType: string
      originalName: string
      tags?: string[]
      name?: string | null
    }): Promise<{ asset: Record<string, unknown> }>
    /** Absolute path for a renderer File ('' when unavailable). Electron-only. */
    getPathForFile(file: File): string
  }
  tier2: {
    pickFolder(): Promise<{ canceled: boolean; tier2Path: string | null }>
    setPath(args: { projectId: string; tier2Path: string | null }): Promise<{ ok: true; tier2Path: string | null }>
    export(args: { projectId: string }): Promise<{ ok: true; filesWritten: number; rootRealPath: string }>
    import(args: { projectId: string }): Promise<{
      ok: true
      project: Record<string, unknown>
      scenes: Record<string, unknown>[]
      warnings: string[]
      rootRealPath: string
    }>
    revealInFinder(args: { projectId: string }): Promise<{ ok: boolean }>
  }
  workspaces: {
    list(): Promise<Array<Record<string, unknown>>>
    get(workspaceId: string): Promise<Record<string, unknown>>
    create(args: {
      name: string
      description?: string | null
      color?: string | null
      icon?: string | null
      isDefault?: boolean
    }): Promise<Record<string, unknown>>
    update(args: { workspaceId: string; updates: Record<string, unknown> }): Promise<Record<string, unknown>>
    delete(workspaceId: string): Promise<{ success: true }>
  }
  publish: {
    run(args: {
      project: Record<string, unknown>
      scenes: unknown[]
      globalStyle?: unknown
    }): Promise<{ publishedUrl: string; version: number }>
  }
  scene: {
    /** Write a raw scene HTML file to the scenes dir (dev: public/scenes, packaged: userData/scenes). */
    writeHtml(args: { id: string; html: string }): Promise<{ success: true; path: string }>
    /** Fetch a single scene by id from the project's scene store. */
    get(args: { projectId: string; sceneId: string }): Promise<{ scene: Record<string, unknown> }>
    /** Read a scene's on-disk HTML for the self-heal check. html is null when missing. */
    readHtml(args: { id: string }): Promise<{ exists: boolean; html: string | null }>
  }
  /** Playback error beacon forwarding — preview host → main ring buffer,
   *  read by verify_scene + the runner's context refresh. */
  sceneErrors: {
    report(args: {
      sceneId: string
      error: { kind: string; message: string; line?: number; source?: string; at: number }
    }): Promise<{ ok: boolean }>
  }
  /**
   * Tier 2 git collab. All methods take a
   * projectId; main resolves the project's tier2Path and shells out to
   * the system `git` binary. Returns typed structures parsed from the
   * porcelain output.
   */
  git: {
    init(args: { projectId: string }): Promise<{ ok: true; tier2Path: string }>
    status(args: { projectId: string }): Promise<{ entries: Array<{ code: string; path: string }> }>
    commit(args: {
      projectId: string
      message: string
      addAll?: boolean
      allowEmpty?: boolean
    }): Promise<{ sha: string; actionsBound: number }>
    log(args: { projectId: string; maxCount?: number; ref?: string }): Promise<{
      commits: Array<{
        sha: string
        date: string
        authorName: string
        authorEmail: string
        subject: string
      }>
    }>
    branchList(args: { projectId: string }): Promise<{ branches: string[]; current: string | null }>
    branchCreate(args: { projectId: string; name: string; checkout?: boolean }): Promise<{ ok: true; branch: string }>
    checkout(args: { projectId: string; branch: string; create?: boolean }): Promise<{ ok: true; branch: string }>
    diff(args: { projectId: string; from: string; to: string }): Promise<{
      entries: Array<{ status: string; path: string; oldPath?: string }>
    }>
    /**
     * Bridge: enumerate commits in
     * `from..to` and return the action_log rows stamped with those
     * SHAs. The diff viewer uses this to render the "real" action diff
     * for a commit range instead of "everything is new".
     */
    listActionsForRange(args: { projectId: string; from: string; to: string; includeUncommitted?: boolean }): Promise<{
      actions: Array<Record<string, unknown>>
      commitShas: string[]
    }>
    /** Remote + push/pull surface. Tokens stay in main. */
    remoteAdd(args: { projectId: string; name: string; url: string }): Promise<{ ok: true }>
    remoteList(args: { projectId: string }): Promise<{
      remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }>
    }>
    setRemoteToken(args: { projectId: string; remoteName: string; token: string }): Promise<{ ok: true }>
    hasRemoteToken(args: { projectId: string; remoteName: string }): Promise<{ has: boolean }>
    clearRemoteToken(args: { projectId: string; remoteName: string }): Promise<{ ok: true }>
    push(args: { projectId: string; remote: string; ref: string }): Promise<{ ok: true }>
    pull(args: { projectId: string; remote: string; ref: string }): Promise<{ ok: true }>
  }
  /**
   * Action layer persistence. Renderer dispatches
   * an action through `src/lib/store/action-dispatch.ts`; main writes the WAL
   * line + action_log row.
   */
  actionLog: {
    append(args: {
      projectId: string
      branchId?: string | null
      action: Record<string, unknown>
    }): Promise<{ success: true; written: { wal: boolean; db: boolean } }>
  }
  media: {
    /**
     * Write a file to the uploads dir. Dev returns `/uploads/<filename>`
     * (served by Next); packaged returns `dreambyte://uploads/<filename>`
     * (served by the dreambyte protocol handler). Enforces 100MB cap +
     * whitelist of video/audio/json mime types; validates Lottie JSON
     * before writing.
     */
    upload(args: {
      data: ArrayBuffer
      mimeType: string
      originalName?: string
    }): Promise<{ url: string; filename: string }>
  }
  tts: {
    /**
     * Server-side TTS synthesis. Returns either `{mode: 'client', ...}`
     * (web-speech / puter — renderer speaks) or `{url, duration, provider, captions}`
     * (MP3/WAV written to the audio dir; URL is `/audio/<name>` in dev
     * or `dreambyte://audio/<name>` in packaged).
     */
    synthesize(args: {
      text: string
      sceneId: string
      projectId?: string
      voiceId?: string
      provider?: string
      model?: string
      instructions?: string
      localMode?: boolean
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }): Promise<Record<string, unknown>>
    /** List available voices for a TTS provider (cached 1h in main). */
    listVoices(provider: TTSProviderId): Promise<{ voices: unknown[]; provider: TTSProviderId }>
    /** Tier 3 Cast: record biometric voice-clone consent for (project, destination) when the user
     *  approves the in-chat consent card. The resumed clone_voice run then finds this consent and
     *  proceeds. consentAt is stamped server-side. */
    recordVoiceConsent(args: { projectId: string; destination: string; version: string }): Promise<{ ok: true }>
  }
  sfx: {
    /** Search Freesound/Pixabay or generate via ElevenLabs when `prompt` is set. */
    search(args: {
      query?: string
      prompt?: string
      provider?: string
      limit?: number
      duration?: number
      download?: boolean
      mode?: 'search' | 'library' | 'generated'
      categoryId?: string
      page?: number
      commercialOnly?: boolean
    }): Promise<Record<string, unknown>>
    /** Prompt -> generate a sound effect (gated). Returns `{ sfx }`, `{ error }`, or `{ permissionNeeded }`. */
    generate(args: {
      projectId?: string
      prompt: string
      provider?: string
      duration?: number
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }): Promise<Record<string, unknown>>
  }
  music: {
    /** Prompt -> generate background music (gated, fal Stable Audio). Returns `{ music }`, `{ error }`, or `{ permissionNeeded }`. */
    generate(args: {
      projectId?: string
      prompt: string
      provider?: string
      duration?: number
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }): Promise<Record<string, unknown>>
  }
  agents: {
    /** Detect which CLI integrations are on the user's PATH (`installed: false` with
     *  null version/path when missing). */
    detectCli(): Promise<{
      claudeCode: { installed: boolean; version: string | null; path: string | null }
      codex: { installed: boolean; version: string | null; path: string | null }
    }>
    /** One-click MCP install info: connector path + per-client config snippets. */
    mcpInstallInfo(): Promise<{
      serverName: string
      connectorPath: string
      claudeCodeCommand: string
      codexCommand: string
      jsonSnippet: string
    }>
  }
  characters: {
    list: (projectId: string) => Promise<{
      characters: Array<{
        id: string
        name: string
        description: string | null
        referenceAssetIds: string[]
        seed: number | null
        model: string | null
        strength: number | null
      }>
    }>
    reuse: (args: {
      projectId: string
      character: string
      prompt: string
      negativePrompt?: string
      aspectRatio?: string
      mediaGenEnabled?: Record<string, boolean> | null
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }) => Promise<
      | { assetId: string; imageUrl: string; characterId: string; cost: number; finalPrompt: string; error?: undefined }
      | { error: string }
      | {
          permissionNeeded: {
            api: string
            estimatedCost: string
            estimatedCostUsd?: number
            costThresholdExceeded?: boolean
            reason?: string
            details?: Record<string, unknown>
          }
        }
    >
  }
  generate: {
    /**
     * Scene-code generators. Each routes through `src/lib/generation/generate.ts`
     * which picks Anthropic / OpenAI / Google / local based on `modelId` +
     * `modelConfigs`. Response shapes match the HTTP routes they replaced
     * so call sites can swap transports without adapting parse logic.
     */
    canvas(args: GenerateCodeArgs): Promise<GenerateCodeStringResult>
    motion(
      args: GenerateCodeArgs & { font?: string },
    ): Promise<GenerateCodeStructuredResult<{ sceneCode: string; styles?: unknown; htmlContent?: unknown }>>
    three(args: GenerateCodeArgs): Promise<GenerateCodeStructuredResult<{ sceneCode: string }>>
    react(
      args: GenerateCodeArgs & { font?: string },
    ): Promise<GenerateCodeStructuredResult<{ sceneCode: string; styles?: unknown }>>
    /**
     * Lottie overlay animation. Returns serialized JSON string in `result`
     * plus a quality score. May produce `fixCount > 0` when the validator
     * auto-repairs the model's output.
     */
    lottie(args: GenerateCodeArgs & { font?: string; motionPersonality?: string }): Promise<{
      result: string
      usage: GenerateCodeUsage
      quality: { score: number; dimensions: unknown; suggestions: unknown }
      fixCount?: number
    }>
    /**
     * D3 data visualization via the `dreambyte_charts` structured pipeline.
     * `result.chartLayers` is the canonical compiled output; `sceneCode` +
     * `styles` are legacy compatibility fields that scenes still read.
     */
    d3(args: GenerateCodeArgs & { font?: string; d3Data?: unknown }): Promise<{
      result: {
        chartLayers: unknown[]
        sceneCode: string
        d3Data: unknown
        styles: unknown
        suggestedData: unknown
      }
      usage: GenerateCodeUsage
    }>
    /**
     * AI image generation (Flux / DALL-E / Recraft via the image-gen
     * router). When `removeBackground` is true, follows with a
     * background-removal pass and returns `stickerUrl` alongside.
     */
    image(args: {
      prompt: string
      negativePrompt?: string
      model?: string
      aspectRatio?: string
      style?: string | null
      removeBackground?: boolean
      seed?: number | null
      strength?: number | null
      projectId?: string
      sceneId?: string
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }): Promise<{
      imageUrl?: string
      stickerUrl?: string | null
      width?: number
      height?: number
      cost?: number
      error?: string
      /** Present when project policy requires interactive approval (always-ask). */
      permissionNeeded?: {
        api: string
        estimatedCost: string
        estimatedCostUsd: number
        costThresholdExceeded?: boolean
        reason?: string
        details: Record<string, unknown>
      }
    }>
    /** HeyGen avatar generation start — returns a `videoId` to poll via `pollHeygen`. */
    avatar(args: {
      projectId?: string
      sceneId?: string
      layerId?: string
      avatarId: string
      voiceId: string
      script: string
      width?: number
      height?: number
      bgColor?: string
    }): Promise<{
      videoId: string
      estimatedSeconds: number
      estimatedCost: number
      sceneId?: string
      layerId?: string
    }>
    /** Start a text-to-video job (Veo3 / Kling / Runway / fal). Returns the operationName to poll,
     *  or a permissionNeeded / error block when the project policy blocks it. */
    video(args: {
      projectId?: string
      sceneId?: string
      layerId?: string
      provider?: string
      prompt: string
      negativePrompt?: string
      aspectRatio?: string
      duration?: number
      seed?: number
      imageUrl?: string
      camera?: { moves: { type: string; intensity?: number }[] }
      /** Tier 2 (#8): a VFX effect preset id, compiled into the prompt by startVideo. */
      effect?: string
      /** Re-dispatch flag set after the user approves the always-ask modal. */
      approvedAsk?: boolean
    }): Promise<{
      operationName: string
      enhancedPrompt: string
      estimatedCost: number
      provider: string
      reservationId: string | null
      projectId?: string
      sceneId?: string
      layerId?: string
      permissionNeeded?: {
        api: string
        estimatedCost: string
        estimatedCostUsd: number
        costThresholdExceeded?: boolean
        reason?: string
        details: Record<string, unknown>
      }
      error?: string
    }>
    /** Lipsync: a face image + narration → a talking-head video clip (synchronous result). */
    lipsync(args: {
      projectId?: string
      provider: string
      sourceImageUrl: string
      text: string
      audioUrl?: string
      voiceId?: string
      ttsProvider?: string
      /** Re-dispatch flag set after the user approves the always-ask modal (covers avatar + TTS). */
      approvedAsk?: boolean
    }): Promise<{
      videoUrl?: string
      durationSeconds?: number
      audioUrl?: string
      error?: string
      permissionNeeded?: {
        api: string
        estimatedCost: string
        estimatedCostUsd?: number
        costThresholdExceeded?: boolean
        reason?: string
        details?: Record<string, unknown>
      }
    }>
    /**
     * Poll a HeyGen avatar video job. Returns `status: 'completed'` with
     * `videoUrl` when the video is downloaded + cached; otherwise reports
     * the upstream job status.
     */
    pollHeygen(videoId: string): Promise<{
      status: string
      videoUrl?: string
      thumbnailUrl?: string
      /** Real rendered clip length (s) from HeyGen — present on completion; drives scene-fit. */
      durationSeconds?: number
      error?: string
    }>
    /**
     * Poll a Veo3 / Kling / Runway text-to-video job. Returns
     * `done: true, videoUrl` on success (after saving to cache +
     * calling `logSpend`) or `done: false` if still processing.
     */
    pollVideo(args: {
      operationName: string
      projectId?: string
      prompt?: string
      providerId?: string
      reservationId?: string
    }): Promise<{
      done: boolean
      videoUrl?: string
      provider?: string
      error?: string
    }>
    /** Default SVG generation. */
    svg(args: GenerateCodeArgs & { strokeWidth?: number; font?: string }): Promise<{
      result: string
      usage: GenerateCodeUsage
    }>
    /** One-shot enhancement of a scene prompt (~512 tokens). */
    enhancePrompt(args: { prompt: string; modelId?: string; modelConfigs?: unknown[] }): Promise<{
      result: string
      usage: GenerateCodeUsage
    }>
    /** 200-token summary of a prompt + SVG content (used for `previousSummary` chaining). */
    summarize(args: {
      prompt: string
      svgContent?: string
      modelId?: string
      modelConfigs?: unknown[]
    }): Promise<{ result: string }>
    /** Rewrite an existing SVG per a natural-language edit instruction. */
    editSvg(args: {
      svgContent: string
      editInstruction: string
      modelId?: string
      modelConfigs?: unknown[]
    }): Promise<{ result: string; usage: GenerateCodeUsage }>
    /**
     * Reactive generation-job status push (pro-style). The main-process runner owns the
     * poll loop and emits when a job advances; subscribe ONCE at boot. Returns an unsubscribe fn.
     */
    onUpdate(
      handler: (update: {
        jobId: string
        projectId: string
        kind: 'video' | 'image' | 'audio' | 'avatar'
        status: 'queued' | 'running' | 'downloading' | 'succeeded' | 'failed'
        sceneId?: string | null
        layerId?: string | null
        clipId?: string | null
        resultUrl?: string | null
        resultDurationMs?: number | null
        error?: string | null
      }) => void,
    ): () => void
  }
}

interface GenerateCodeArgs {
  prompt: string
  palette?: string[]
  bgColor?: string
  duration?: number
  previousSummary?: string
  modelId?: string
  modelConfigs?: unknown[]
}

interface GenerateCodeUsage {
  input_tokens: number
  output_tokens: number
  cost_usd: number
}

interface GenerateCodeStringResult {
  result: string
  usage: GenerateCodeUsage
  truncated?: boolean
}

interface GenerateCodeStructuredResult<R> {
  result: R
  usage: GenerateCodeUsage
  truncated?: boolean
}

declare global {
  interface Window {
    /**
     * The desktop IPC surface. Only present in Electron (dev or packaged).
     * In a pure browser context it is `undefined`.
     */
    dreambyteApi?: DreambyteApi
  }
}
