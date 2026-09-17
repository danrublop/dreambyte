import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, blob } from 'drizzle-orm/sqlite-core'
import { relations, sql } from 'drizzle-orm'

// OAuth account `type` discriminator. Mirrors next-auth/adapters'
// AdapterAccountType so a future auth lib can plug in without a migration.
type AccountType = 'oauth' | 'oidc' | 'email' | 'webauthn'
import crypto from 'node:crypto'
import type {
  GlobalStyle,
  SceneStyleOverride,
  TransitionConfig,
  AudioLayer,
  VideoLayer,
  SceneLayer,
  SceneElement,
  InteractionElement,
  EdgeCondition,
  PublishedProject,
  MP4Settings,
  InteractiveSettings,
  AssetPlacement,
  AudioSettings,
  BrandKit,
  ProjectBrief,
} from '../types'
import type { StructuralCut } from '../agents/types'

// ── SQLite conventions ───────────────────────────────────────────────────────
// Local-first: a single `dreambyte.db` SQLite file lives in the user's data dir
// (or a libsql remote URL when cloud sync is enabled). Column conventions:
//   - enums: inline `text({ enum: [...] })` — Drizzle type-checks the union
//   - JSON: `text({ mode: 'json' })` + `$type<>()`, stored as TEXT
//   - ids: `text().$defaultFn(crypto.randomUUID)` (no native UUID type)
//   - timestamps: `integer({ mode: 'timestamp' })` (Unix epoch seconds, exposed
//     as a JS Date), defaulting to `(unixepoch())`
//   - booleans: `integer({ mode: 'boolean' })` (stored 0/1)
//   - arrays: `text({ mode: 'json' }).$type<T[]>()`
//   - indexes: plain b-tree on the underlying columns (no expression indexes;
//     add FTS5 separately if text search is needed)
// ────────────────────────────────────────────────────────────────────────────

const now = () => sql`(unixepoch())`

// ── Users ──────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name'),
  emailVerified: integer('email_verified', { mode: 'timestamp' }),
  image: text('image'),
  avatarUrl: text('avatar_url'),
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).default('free'),
  defaultStorageMode: text('default_storage_mode', { enum: ['local', 'cloud'] }).default('local'),
  preferences: text('preferences', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
})

// ── Auth (Auth.js / NextAuth) ─────────────────────────
export const accounts = sqliteTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => ({
    compoundKey: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
)

export const sessions = sqliteTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: integer('expires', { mode: 'timestamp' }).notNull(),
})

// ── User Memory (cross-session agent learnings) ───────
export const userMemory = sqliteTable(
  'user_memory',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Project scope: NULL = a user-global memory that
    // applies to every project; a value = a memory learned for one project
    // only. Workspace-level taste is NOT stored here — it lives in the
    // authoritative `workspaces.brandKit`/`globalStyle` and is merged as the
    // middle precedence layer at read time (getMemoriesScoped). Precedence:
    //   project-memory > workspace.brandKit > user-memory.
    // ON DELETE set null: deleting a project demotes its memories to global
    // rather than discarding the learning (and avoids dangling FKs).
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    category: text('category').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    confidence: real('confidence').default(0.5).notNull(),
    sourceRunId: text('source_run_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    userIdx: index('user_memory_user_idx').on(t.userId),
    // Uniqueness now includes projectId so the SAME (category, key) can hold a
    // distinct value per project AND a user-global fallback (projectId NULL)
    // at the same time. SQLite treats NULL as DISTINCT inside a UNIQUE index,
    // which would let many global rows collide on (user, cat, key); coalescing
    // NULL → '' collapses every global row to one stable scope token so the
    // global slot stays unique while project slots stay separate. This is the
    // upsert conflict target (onConflictDoUpdate) for both scopes.
    userScopeKeyIdx: uniqueIndex('user_memory_user_scope_key_idx').on(
      t.userId,
      sql`coalesce(${t.projectId}, '')`,
      t.category,
      t.key,
    ),
    // Backs the scoped read (getMemoriesScoped): one query fetches both this
    // project's rows AND the user-global (project_id IS NULL) rows.
    userProjectKeyIdx: index('user_memory_user_project_key_idx').on(t.userId, t.projectId, t.category, t.key),
  }),
)

// ── Workspaces ────────────────────────────────────────
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    icon: text('icon'),
    brandKit: text('brand_kit', { mode: 'json' }).$type<BrandKit | null>().default(null),
    globalStyle: text('global_style', { mode: 'json' }).$type<GlobalStyle | null>().default(null),
    settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    isDefault: integer('is_default', { mode: 'boolean' }).default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    userIdx: index('workspaces_user_idx').on(t.userId),
    defaultIdx: index('workspaces_default_idx').on(t.userId, t.isDefault),
  }),
)

// ── Projects ───────────────────────────────────────────
export const projects = sqliteTable(
  'projects',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    sceneGraphStartSceneId: text('scene_graph_start_scene_id'),
    outputMode: text('output_mode', { enum: ['mp4', 'interactive'] }).default('mp4'),
    storageMode: text('storage_mode', { enum: ['local', 'cloud'] }).default('local'),
    // Lifecycle status:
    //   'ready'   — a normal, persisted project.
    //   'forking' — mid-fork (rows exist but asset files may still be copying);
    //               list/open paths hide these so a half-built fork is never
    //               openable. Flipped to 'ready' once the fork completes; a
    //               crashed fork is reclaimed by the heartbeat orphan sweep.
    //   'draft'   — created with zero-friction entry; a real row exists from
    //               the first moment instead of the old lazy in-memory persist.
    //               Promoted to 'ready' on the first real activity (a scene with
    //               content, a chat message, a rename, or a reopen).
    //   'hidden'  — soft-hidden by the startup sweep because it was a provably
    //               untouched empty draft. `hiddenAt` stamps when; the sweep
    //               hard-purges only rows hidden for >7 days. NEVER hard-deleted
    //               directly by the sweep.
    // See src/electron/ipc/fork.ts and src/lib/store/draft-sweep.ts.
    status: text('status', { enum: ['ready', 'forking', 'draft', 'hidden'] })
      .default('ready')
      .notNull(),
    globalStyle: text('global_style', { mode: 'json' }).$type<GlobalStyle>().default({
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    }),
    // The agent's proposal / handoff state (structuralCutsProposed,
    // pausedAgentRun, runCheckpoint) moved OFF this
    // table into `branchProposals` (keyed (projectId, branchId)) in 0015 — it
    // is per-branch working state, not project-level config. See that table
    // below. `agentConfig` stays here: it is a project-level setting.
    agentConfig: text('agent_config', { mode: 'json' })
      .$type<import('../agents/config-resolver').AgentConfig | null>()
      .default(null),
    // OKF Layer 0 — project intent / the compass (format, video type, log line,
    // voice driver, media strategy). Project-level setting, like agentConfig.
    // Null until extracted from the first prompt.
    projectBrief: text('project_brief', { mode: 'json' }).$type<ProjectBrief | null>().default(null),
    mp4Settings: text('mp4_settings', { mode: 'json' }).$type<MP4Settings>().default({
      resolution: '1080p',
      fps: 30,
      format: 'mp4',
      aspectRatio: '16:9',
    }),
    interactiveSettings: text('interactive_settings', { mode: 'json' }).$type<InteractiveSettings>().default({
      playerTheme: 'dark',
      showProgressBar: true,
      showSceneNav: false,
      allowFullscreen: true,
      brandColor: '#e84545',
      customDomain: null,
      password: null,
    }),
    apiPermissions: text('api_permissions', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    audioSettings: text('audio_settings', { mode: 'json' }).$type<AudioSettings>().default({
      defaultTTSProvider: 'auto',
      defaultSFXProvider: 'auto',
      defaultMusicProvider: 'auto',
      defaultVoiceId: null,
      defaultVoiceName: null,
      webSpeechVoice: null,
      puterProvider: 'openai',
      openaiTTSModel: 'tts-1',
      openaiTTSVoice: 'alloy',
      geminiTTSModel: 'gemini-2.5-flash-preview-tts',
      geminiVoice: null,
      edgeTTSUrl: null,
      pocketTTSUrl: null,
      voxcpmUrl: null,
      musicgenUrl: null,
      globalMusicDucking: true,
      globalMusicDuckLevel: 0.2,
    }),
    audioProviderEnabled: text('audio_provider_enabled', { mode: 'json' }).$type<Record<string, boolean>>().default({}),
    mediaGenEnabled: text('media_gen_enabled', { mode: 'json' }).$type<Record<string, boolean>>().default({}),
    watermark: text('watermark', { mode: 'json' })
      .$type<{
        assetId: string
        position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
        opacity: number
        sizePercent: number
      } | null>()
      .default(null),
    brandKit: text('brand_kit', { mode: 'json' })
      .$type<{
        brandName: string | null
        logoAssetIds: string[]
        palette: string[]
        fontPrimary: string | null
        fontSecondary: string | null
        guidelines: string | null
      } | null>()
      .default(null),
    version: integer('version').default(1).notNull(),
    thumbnailUrl: text('thumbnail_url'),
    // Tier 2 file mirror root (W0). When set, debounced project saves
    // also write project.json + scenes/*.html + scenes/*.dreambyte.json under
    // this folder so the project is git-able and external-agent readable.
    // Null = Tier 2 not yet exported. Path validated against `realpath`
    // before any write to prevent symlink escape into unrelated dirs.
    tier2Path: text('tier2_path'),
    isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
    // When the startup draft-sweep soft-hid this project (status='hidden').
    // Null otherwise. The hard-purge step deletes rows whose hiddenAt is >7 days
    // old. See src/lib/store/draft-sweep.ts.
    hiddenAt: integer('hidden_at', { mode: 'timestamp' }),
    lastOpenedAt: integer('last_opened_at', { mode: 'timestamp' }).default(now()),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    userIdx: index('projects_user_idx').on(t.userId),
    archivedIdx: index('projects_archived_idx').on(t.userId, t.isArchived),
    updatedIdx: index('projects_updated_idx').on(t.userId, t.updatedAt),
    workspaceIdx: index('projects_workspace_idx').on(t.workspaceId),
  }),
)

// ── Project Assets (Media Library) ─────────────────────
export const projectAssets = sqliteTable(
  'project_assets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    storagePath: text('storage_path').notNull(),
    publicUrl: text('public_url').notNull(),
    type: text('type').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: real('duration_seconds'),
    name: text('name').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    thumbnailUrl: text('thumbnail_url'),
    extractedColors: text('extracted_colors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    source: text('source').default('upload').notNull(),
    prompt: text('prompt'),
    provider: text('provider'),
    model: text('model'),
    costCents: integer('cost_cents'),
    parentAssetId: text('parent_asset_id'),
    referenceAssetIds: text('reference_asset_ids', { mode: 'json' }).$type<string[]>(),
    enhanceTags: text('enhance_tags', { mode: 'json' }).$type<string[]>(),
    contentHash: text('content_hash'),
    sourceUrl: text('source_url'),
    classificationTimestamp: integer('classification_timestamp', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('project_assets_project_idx').on(t.projectId),
    typeIdx: index('project_assets_type_idx').on(t.projectId, t.type),
    sourceIdx: index('project_assets_source_idx').on(t.projectId, t.source),
    contentHashIdx: index('project_assets_content_hash_idx').on(t.contentHash),
  }),
)

// ── Research memory (research_notes) ────────────────────────────
// Persisted output of a research sub-agent run: the brief, the sources it used,
// the assets it staged, and a 384-d embedding of the TOPIC for semantic reuse.
// Similarity is JS cosine over a project's handful of notes (see src/lib/research/
// embed.ts) — no vector DB, no libsql vector functions, so the migration is a
// plain drizzle-generated column. `embedModel`/`embedDim` guard against comparing
// vectors across embedder changes (mismatched dims poison KNN).
export const researchNotes = sqliteTable(
  'research_notes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    brief: text('brief').notNull(),
    sources: text('sources', { mode: 'json' }).$type<{ title: string; url: string }[]>().notNull().default([]),
    assetIds: text('asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    embedding: text('embedding', { mode: 'json' }).$type<number[]>(),
    embedModel: text('embed_model'),
    embedDim: integer('embed_dim'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('research_notes_project_idx').on(t.projectId, t.createdAt),
  }),
)

// ── Character bundles ────────────────────────────
// A reusable character identity: a reference image set + a pinned seed + an i2i model +
// a style descriptor. Reusing the character conditions generation on its primary reference
// AND its seed so the same subject re-appears across scenes (Higgsfield-style consistency).
// The reference images themselves live in project_assets; this table just names the bundle.
export const characters = sqliteTable(
  'characters',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Appearance/style descriptor folded into every prompt (e.g. "a young woman with
    // red hair and freckles, wearing a green jacket"). Keeps identity stable beyond the seed.
    description: text('description'),
    // Ordered i2i reference set; [0] is the primary conditioning image. JSON (no SQLite array).
    referenceAssetIds: text('reference_asset_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Pinned RNG seed for reproducibility. Null = let the model pick (less consistent).
    seed: integer('seed'),
    // i2i-capable model slug used when reusing the character. Null = router picks at call time.
    model: text('model'),
    // i2i conditioning strength override 0..1. Null = endpoint default.
    strength: real('strength'),
    // Tier 3 Cast: a bound cloned voice (cloned_voices.id). A "Cast member" = this character row
    // with both a face (reference_asset_ids[0]) and a voice. Null = no voice bound (face only).
    // set null on voice delete so erasing a voice doesn't delete the character.
    voiceId: text('voice_id').references((): any => clonedVoices.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('characters_project_idx').on(t.projectId),
    // One character per name per project (case-insensitive) — names are the handle the agent
    // reuses by, so duplicates would make reuse_character pick an ambiguous bundle.
    projectNameUnique: uniqueIndex('characters_project_name_unique').on(t.projectId, sql`lower(${t.name})`),
  }),
)

// ── Cloned voices (Tier 3 Cast, Slice 2) ──────────────────────────────────
// A cloned voice = a third-party (ElevenLabs) or local (VoxCPM) voiceprint created from a user
// audio sample. The raw biometric audio is NOT stored at rest — only the provider's voice id,
// sample metadata, and a consent audit. characters.voiceId (Slice 3) references this.
export const clonedVoices = sqliteTable(
  'cloned_voices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(), // 'elevenlabs' | 'voxcpm'
    providerVoiceId: text('provider_voice_id').notNull(),
    sampleMime: text('sample_mime'),
    sampleBytes: integer('sample_bytes'),
    // Consent audit snapshot — the consent in effect when this sample was sent to the provider.
    consentAt: integer('consent_at', { mode: 'timestamp' }).notNull(),
    consentVersion: text('consent_version').notNull(),
    consentDestination: text('consent_destination').notNull(), // named third party, e.g. 'ElevenLabs (US)'
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('cloned_voices_project_idx').on(t.projectId),
    // Names are the handle the picker/agent selects by — one per project, case-insensitive.
    projectNameUnique: uniqueIndex('cloned_voices_project_name_unique').on(t.projectId, sql`lower(${t.name})`),
  }),
)

// Voice-clone consent per (project, destination). "Once per project, then remembered" — recorded
// per named third party so each destination keeps its own contemporaneous consentAt + version (a
// later consent to a second destination never overwrites the first's audit). Biometric uploads are
// fail-closed on the absence of a row for that destination — see src/lib/services/voice-clone.
export const voiceCloneConsents = sqliteTable(
  'voice_clone_consents',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(), // named third party, e.g. 'ElevenLabs (US)'
    version: text('version').notNull(), // id/hash of the consent text the user accepted
    consentAt: integer('consent_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.destination] }),
  }),
)

// ── Scenes ─────────────────────────────────────────────
export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name'),
    position: integer('position').notNull(),
    duration: real('duration').default(8).notNull(),
    bgColor: text('bg_color').default('#fffef9'),
    styleOverride: text('style_override', { mode: 'json' }).$type<SceneStyleOverride>().default({}),
    transition: text('transition', { mode: 'json' }).$type<TransitionConfig>().default({
      type: 'none',
      duration: 0.5,
    }),
    audioLayer: text('audio_layer', { mode: 'json' }).$type<AudioLayer>(),
    videoLayer: text('video_layer', { mode: 'json' }).$type<VideoLayer>(),
    thumbnailUrl: text('thumbnail_url'),
    gridConfig: text('grid_config', { mode: 'json' }),
    cameraMotion: text('camera_motion', { mode: 'json' }),
    worldConfig: text('world_config', { mode: 'json' }),
    sceneBlob: text('scene_blob', { mode: 'json' }).$type<Record<string, unknown> | null>().default(null),
    avatarConfigId: text('avatar_config_id'),
    branchId: text('branch_id').references(() => projectBranches.id, { onDelete: 'cascade' }),
    // Verify-scene gate: stamped after every scene write by the offscreen
    // verifier. 'unknown' covers never-verified rows + verifier-unavailable cases;
    // 'pending' is only observed if a process died mid-verify.
    verifyStatus: text('verify_status', {
      enum: ['unknown', 'pending', 'verifying', 'verified', 'errored'],
    })
      .default('unknown')
      .notNull(),
    verifyError: text('verify_error', { mode: 'json' }).$type<SceneVerifyError | null>().default(null),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('scenes_project_idx').on(t.projectId),
    positionIdx: index('scenes_position_idx').on(t.projectId, t.position),
    branchIdx: index('scenes_branch_idx').on(t.projectId, t.branchId),
  }),
)

export interface SceneVerifyError {
  kind: 'syntax' | 'runtime' | 'timeout' | 'asset' | 'unknown'
  message: string
  line?: number
  source?: string
}

// ── Generated Media Cache ───────────────────────────────
export const generatedMedia = sqliteTable(
  'generated_media',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').references(() => users.id),
    type: text('type').notNull(),
    promptHash: text('prompt_hash').notNull(),
    prompt: text('prompt'),
    model: text('model'),
    url: text('url'),
    status: text('status', { enum: ['pending', 'generating', 'processing', 'ready', 'error'] }).default('pending'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    costUsd: real('cost_usd'),
    externalJobId: text('external_job_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    hashIdx: uniqueIndex('media_hash_idx').on(t.promptHash),
    userIdx: index('media_user_idx').on(t.userId),
    statusIdx: index('media_status_idx').on(t.status),
  }),
)

// ── Layers ─────────────────────────────────────────────
export const layers = sqliteTable(
  'layers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    parentLayerId: text('parent_layer_id'),
    type: text('type', {
      enum: [
        'canvas2d',
        'svg',
        'd3',
        'three',
        'zdog',
        'lottie',
        'html',
        'assets',
        'group',
        'avatar',
        'veo3',
        'image',
        'sticker',
      ],
    }).notNull(),
    label: text('label'),
    zIndex: integer('z_index').default(0).notNull(),
    visible: integer('visible', { mode: 'boolean' }).default(true).notNull(),
    opacity: real('opacity').default(1).notNull(),
    blendMode: text('blend_mode').default('normal'),
    startAt: real('start_at').default(0).notNull(),
    duration: real('duration'),
    generatedCode: text('generated_code'),
    elements: text('elements', { mode: 'json' }).$type<SceneElement[]>().default([]),
    assetPlacements: text('asset_placements', { mode: 'json' }).$type<AssetPlacement[]>().default([]),
    prompt: text('prompt'),
    modelUsed: text('model_used'),
    generatedAt: integer('generated_at', { mode: 'timestamp' }),
    layerConfig: text('layer_config', { mode: 'json' }),
    mediaId: text('media_id').references(() => generatedMedia.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    sceneIdx: index('layers_scene_idx').on(t.sceneId),
    typeIdx: index('layers_type_idx').on(t.sceneId, t.type),
    zIndexIdx: index('layers_zindex_idx').on(t.sceneId, t.zIndex),
  }),
)

// ── Scene Graph ─────────────────────────────────────────
export const sceneEdges = sqliteTable(
  'scene_edges',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromSceneId: text('from_scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
    toSceneId: text('to_scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
    condition: text('condition', { mode: 'json' }).$type<EdgeCondition>().default({
      type: 'auto',
      interactionId: null,
      variableName: null,
      variableValue: null,
    }),
    position: text('position', { mode: 'json' }),
  },
  (t) => ({
    projectIdx: index('edges_project_idx').on(t.projectId),
  }),
)

export const sceneNodes = sqliteTable(
  'scene_nodes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    position: text('position', { mode: 'json' }).notNull(),
  },
  (t) => ({
    projectIdx: index('nodes_project_idx').on(t.projectId),
    sceneUniqueIdx: uniqueIndex('nodes_project_scene_unique_idx').on(t.projectId, t.sceneId),
  }),
)

// ── Interactions ────────────────────────────────────────
export const interactions = sqliteTable(
  'interactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    config: text('config', { mode: 'json' }).$type<InteractionElement>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    sceneIdx: index('interactions_scene_idx').on(t.sceneId),
  }),
)

// ── Assets ──────────────────────────────────────────────
export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    category: text('category'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    description: text('description'),
    type: text('type').default('canvas'),
    canvasDrawFn: text('canvas_draw_fn'),
    svgData: text('svg_data'),
    defaultWidth: integer('default_width').default(200),
    defaultHeight: integer('default_height').default(200),
    bounds: text('bounds', { mode: 'json' }),
    thumbnailUrl: text('thumbnail_url'),
    isBuiltIn: integer('is_built_in', { mode: 'boolean' }).default(true),
    isPublic: integer('is_public', { mode: 'boolean' }).default(false),
    userId: text('user_id').references(() => users.id),
    useCount: integer('use_count').default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    categoryIdx: index('assets_category_idx').on(t.category),
    publicIdx: index('assets_public_idx').on(t.isPublic),
  }),
)

// ── 3D Components ───────────────────────────────────────
export const threeDComponents = sqliteTable('three_d_components', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  description: text('description'),
  buildFn: text('build_fn'),
  thumbnailUrl: text('thumbnail_url'),
  animates: integer('animates', { mode: 'boolean' }).default(true),
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
})

// ── Scene Templates ─────────────────────────────────────
export const sceneTemplates = sqliteTable(
  'scene_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
    layers: text('layers', { mode: 'json' }).$type<Omit<SceneLayer, 'id'>[]>().default([]),
    duration: real('duration').default(8),
    styleOverride: text('style_override', { mode: 'json' }).$type<SceneStyleOverride>().default({}),
    placeholders: text('placeholders', { mode: 'json' }).$type<string[]>().default([]),
    thumbnailUrl: text('thumbnail_url'),
    isBuiltIn: integer('is_built_in', { mode: 'boolean' }).default(false),
    isPublic: integer('is_public', { mode: 'boolean' }).default(false),
    userId: text('user_id').references(() => users.id),
    useCount: integer('use_count').default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    categoryIdx: index('templates_category_idx').on(t.category),
    publicIdx: index('templates_public_idx').on(t.isPublic),
  }),
)

// ── Snapshots (undo/redo) ───────────────────────────────
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    diff: text('diff', { mode: 'json' }).notNull(),
    agentMessage: text('agent_message'),
    agentType: text('agent_type', { enum: ['router', 'director', 'scene-maker', 'editor', 'dop', 'planner'] }),
    stackIndex: integer('stack_index').notNull(),
    branchId: text('branch_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('snapshots_project_idx').on(t.projectId),
    stackIdx: index('snapshots_stack_idx').on(t.projectId, t.stackIndex),
    branchIdx: index('snapshots_branch_idx').on(t.projectId, t.branchId),
  }),
)

// ── API Spend ───────────────────────────────────────────
// Monthly rollups range-scan the (userId, createdAt) b-tree index — fine for
// single-user desktop volumes.
export const apiSpend = sqliteTable(
  'api_spend',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').references(() => users.id),
    projectId: text('project_id'),
    api: text('api').notNull(),
    costUsd: real('cost_usd').notNull(),
    description: text('description'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    userIdx: index('spend_user_idx').on(t.userId),
    monthIdx: index('spend_user_created_idx').on(t.userId, t.createdAt),
    apiCreatedIdx: index('spend_api_created_idx').on(t.api, t.createdAt),
  }),
)

// ── Published Projects ──────────────────────────────────
export const publishedProjects = sqliteTable(
  'published_projects',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id),
    manifest: text('manifest', { mode: 'json' }).$type<PublishedProject>(),
    version: integer('version').default(1).notNull(),
    isPasswordProtected: integer('is_password_protected', { mode: 'boolean' }).default(false),
    passwordHash: text('password_hash'),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    viewCount: integer('view_count').default(0),
    customDomain: text('custom_domain'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('published_project_idx').on(t.projectId),
    activeIdx: index('published_active_idx').on(t.isActive),
  }),
)

// ── Analytics Events ────────────────────────────────────
export const analyticsEvents = sqliteTable(
  'analytics_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    publishedProjectId: text('published_project_id').references(() => publishedProjects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    eventType: text('event_type').notNull(),
    sceneId: text('scene_id'),
    interactionId: text('interaction_id'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    userAgent: text('user_agent'),
    country: text('country'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('analytics_project_idx').on(t.publishedProjectId),
    eventTypeIdx: index('analytics_event_type_idx').on(t.publishedProjectId, t.eventType),
    sessionIdx: index('analytics_session_idx').on(t.sessionId),
    createdIdx: index('analytics_created_idx').on(t.createdAt),
  }),
)

// ── Conversations ──────────────────────────────────────
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
    isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
    branchId: text('branch_id'),
    totalInputTokens: integer('total_input_tokens').default(0),
    totalOutputTokens: integer('total_output_tokens').default(0),
    totalCostUsd: real('total_cost_usd').default(0),
    lastMessageAt: integer('last_message_at', { mode: 'timestamp' }).default(now()),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('conv_project_idx').on(t.projectId),
    lastMsgIdx: index('conv_last_msg_idx').on(t.projectId, t.lastMessageAt),
    branchIdx: index('conv_branch_idx').on(t.projectId, t.branchId),
  }),
)

// ── Messages ───────────────────────────────────────────
export const messages = sqliteTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    agentType: text('agent_type', { enum: ['router', 'director', 'scene-maker', 'editor', 'dop', 'planner'] }),
    modelUsed: text('model_used'),
    thinkingContent: text('thinking_content'),
    toolCalls: text('tool_calls', { mode: 'json' }).$type<unknown[]>().default([]),
    contentSegments: text('content_segments', { mode: 'json' }),
    /**
     * Permission gates raised during this message's run. Persisted so the
     * inline permission card survives a renderer reload while the user is
     * still deciding whether to allow the generation. Resolved state
     * (allow / deny) is part of each entry, so the "Allowed" / "Denied"
     * pill survives too.
     */
    pendingPermissions: text('pending_permissions', { mode: 'json' }).$type<unknown[]>(),
    status: text('status').notNull().default('complete'),
    // Monotonic sequence number for the in-flight incremental persist.
    // Carried alongside the runId by the streaming upsert so the persist layer
    // can reject stale / out-of-order writes: an older seq must never overwrite
    // newer streamed content. Null for legacy rows and for finalized writes that
    // don't supply one (the final persist supersedes partials unconditionally).
    seq: integer('seq'),
    // The IPC runId that produced (or is producing) this row. Persisted on
    // every streaming write + the run-start placeholder so orphan detection can
    // be precise: a 'streaming' row whose runId is not among the live
    // activeRunIds() is an orphan regardless of other in-flight runs. Null for
    // legacy rows (which keep the conservative any-active-run grace).
    runId: text('run_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    generationLogId: text('generation_log_id'),
    userRating: integer('user_rating'),
    durationMs: integer('duration_ms'),
    apiCalls: integer('api_calls'),
    position: integer('position').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    convIdx: index('msg_conv_idx').on(t.conversationId),
    projectIdx: index('msg_project_idx').on(t.projectId),
    positionIdx: index('msg_position_idx').on(t.conversationId, t.position),
    createdIdx: index('msg_created_idx').on(t.conversationId, t.createdAt),
  }),
)

// ── Media Cache (HTTP cache for fetched media) ──────────
export const mediaCache = sqliteTable(
  'media_cache',
  {
    hash: text('hash').primaryKey(),
    api: text('api').notNull(),
    filePath: text('file_path').notNull(),
    prompt: text('prompt'),
    model: text('model'),
    config: text('config'),
    contentHash: text('content_hash'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    contentHashIdx: index('media_cache_content_hash_idx').on(t.contentHash),
  }),
)

// ── Video Jobs (async video durability) ───────────
// One row per in-flight text-to-video generation. Persisted so the (stateless) poll loop
// can enforce a deadline across restarts: a still-pending job past deadlineAt is marked
// 'timeout', its in-memory reservation released, and a clear error returned instead of an
// infinite spinner. Keyed by operationName (the id the poll loop already carries).
export const videoJobs = sqliteTable('video_jobs', {
  operationName: text('operation_name').primaryKey(),
  projectId: text('project_id').notNull(),
  provider: text('provider').notNull(),
  reservationId: text('reservation_id'),
  status: text('status').notNull().default('pending'), // pending | done | error | timeout
  // Hash of the canonical request params (start-cache): identical re-requests dedupe
  // instead of re-billing. video_url lets a 'done' job return its clip without re-polling the
  // provider (also serves cache-hit jobs that never had a real provider operation).
  requestHash: text('request_hash'),
  videoUrl: text('video_url'),
  // Reserved cost in cents (duration-scaled at start). The stateless poll has no `duration`,
  // so it commits THIS persisted amount on success — keeping reserve == commit for per-second
  // models (LTX/Seedance), where a flat per-call number would disagree ~Nx with the reservation.
  estimatedCostCents: integer('estimated_cost_cents'),
  startedAt: integer('started_at', { mode: 'timestamp' }).default(now()).notNull(),
  deadlineAt: integer('deadline_at', { mode: 'timestamp' }).notNull(),
  errorReason: text('error_reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
})

// ── Media Generations (reactive job record) ─────────────────────
// One lifecycle row per async AI-media generation across ALL kinds (video/image/
// audio/avatar). This is the orchestration layer that lets a MAIN-PROCESS job
// runner own the poll loop (off the agent) and push status to the renderer — the
// reactive job model that closes the async-orchestration gap. Cost reserve/commit
// + request-hash dedupe stay on `video_jobs`; this table references the same
// `operation_name` and never duplicates the cost-accounting columns.
export const mediaGenerations = sqliteTable(
  'media_generations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull(),
    // Drives which provider/poller the runner uses for this job.
    kind: text('kind', { enum: ['video', 'image', 'audio', 'avatar'] }).notNull(),
    provider: text('provider').notNull(),
    // Provider-side handle the runner polls (fal request_id, veo op name, heygen
    // video id). Null for a kind that resolves synchronously.
    operationName: text('operation_name'),
    // 5-state lifecycle: queued→running→downloading→succeeded|failed.
    status: text('status', { enum: ['queued', 'running', 'downloading', 'succeeded', 'failed'] })
      .notNull()
      .default('queued'),
    prompt: text('prompt'),
    // Where the agent dropped the placeholder, so a push can finalize it directly.
    sceneId: text('scene_id'),
    layerId: text('layer_id'),
    clipId: text('clip_id'),
    // Final asset (public dreambyte:// path) once downloaded + cached.
    resultUrl: text('result_url'),
    // Real duration discovered after download — used to resize the placeholder clip.
    resultDurationMs: integer('result_duration_ms'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    // Wall-clock ceiling; past it a stuck job is failed (the underlying pollVideoStatus
    // path frees the reservation). Reuses deadlineFor().
    deadlineAt: integer('deadline_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('media_gen_project_idx').on(t.projectId),
    statusIdx: index('media_gen_status_idx').on(t.status),
    opIdx: index('media_gen_op_idx').on(t.operationName),
  }),
)

// ── Permission Sessions ────────────────────────────────
export const permissionSessions = sqliteTable('permission_sessions', {
  api: text('api').primaryKey(),
  decision: text('decision').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
})

// ── Agent Usage ─────────────────────────────────────────
export const agentUsage = sqliteTable(
  'agent_usage',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').notNull(),
    agentType: text('agent_type').notNull(),
    modelId: text('model_id').notNull(),
    // Nullable: rows written before migration 0013 have no provider/outcome/run
    // correlation. The summary query coalesces these to 'unknown'.
    provider: text('provider'),
    outcome: text('outcome'), // 'success' | 'error'
    runId: text('run_id'),
    parentRunId: text('parent_run_id'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    // Prompt-cache accounting. The runner has ALWAYS collected these (runner.ts
    // message_start handler) and then thrown them away at the insert, which is why
    // every audit of this codebase has recorded the cache hit rate as "unmeasured"
    // — the caching work in #388/#402 could not be evaluated after it shipped.
    // Nullable, not .notNull(): rows written before this migration genuinely have no
    // value, and defaulting them to 0 would read as "no cache hits" rather than
    // "not recorded", which is the same lie in a different direction.
    cacheCreationTokens: integer('cache_creation_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    apiCalls: integer('api_calls').default(1).notNull(),
    toolCalls: integer('tool_calls').default(0).notNull(),
    costUsd: real('cost_usd').default(0).notNull(),
    durationMs: integer('duration_ms').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('agent_usage_project_idx').on(t.projectId),
    agentIdx: index('agent_usage_agent_idx').on(t.agentType),
    monthIdx: index('agent_usage_month_idx').on(t.createdAt),
    providerIdx: index('agent_usage_provider_idx').on(t.provider),
    modelIdx: index('agent_usage_model_idx').on(t.modelId),
  }),
)

// ── Generation Logs ────────────────────────────────────
export const generationLogs = sqliteTable(
  'generation_logs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
    layerId: text('layer_id').references(() => layers.id, { onDelete: 'set null' }),

    userPrompt: text('user_prompt').notNull(),
    systemPromptHash: text('system_prompt_hash'),
    systemPromptSnapshot: text('system_prompt_snapshot'),
    injectedRules: text('injected_rules', { mode: 'json' }).$type<string[]>(),

    stylePresetId: text('style_preset_id'),
    agentType: text('agent_type'),
    modelUsed: text('model_used'),
    thinkingMode: text('thinking_mode'),

    sceneType: text('scene_type'),
    generatedCodeLength: integer('generated_code_length'),

    thinkingContent: text('thinking_content'),

    generationTimeMs: integer('generation_time_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    thinkingTokens: integer('thinking_tokens'),
    costUsd: real('cost_usd'),

    userAction: text('user_action'),
    timeToActionMs: integer('time_to_action_ms'),
    editDistance: integer('edit_distance'),
    userRating: integer('user_rating'),
    exportSucceeded: integer('export_succeeded', { mode: 'boolean' }),
    exportErrorMessage: text('export_error_message'),

    qualityScore: real('quality_score'),
    analysisNotes: text('analysis_notes'),

    runId: text('run_id'),
    runTrace: text('run_trace', { mode: 'json' }),

    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('gen_log_project_idx').on(t.projectId),
    modelIdx: index('gen_log_model_idx').on(t.modelUsed),
    presetIdx: index('gen_log_preset_idx').on(t.stylePresetId),
    actionIdx: index('gen_log_action_idx').on(t.userAction),
    createdIdx: index('gen_log_created_idx').on(t.createdAt),
    runIdIdx: index('gen_log_run_id_idx').on(t.runId),
  }),
)

// ── Avatar Configs ─────────────────────────────────────
export const avatarConfigs = sqliteTable(
  'avatar_configs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('talkinghead'),
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    name: text('name').notNull().default('Default Avatar'),
    thumbnailUrl: text('thumbnail_url'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('avatar_configs_project_idx').on(t.projectId),
    defaultIdx: index('avatar_configs_default_idx').on(t.projectId, t.isDefault),
  }),
)

// ── Avatar Videos ──────────────────────────────────────
export const avatarVideos = sqliteTable(
  'avatar_videos',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
    avatarConfigId: text('avatar_config_id').references(() => avatarConfigs.id, { onDelete: 'set null' }),

    provider: text('provider').notNull(),
    status: text('status').notNull().default('pending'),

    text: text('text').notNull(),
    audioUrl: text('audio_url'),
    sourceImageUrl: text('source_image_url'),

    videoUrl: text('video_url'),
    durationSeconds: real('duration_seconds'),

    errorMessage: text('error_message'),

    costUsd: real('cost_usd'),

    // Async HeyGen durability. The provider videoId is the poll handle —
    // persisting it on the row lets the SERVER poll (pollHeygenStatus) correlate a
    // poll back to this row to enforce the deadline and flip status on completion.
    // (Nullable: only the async HeyGen submit sets it; sync/other providers don't.)
    heygenVideoId: text('heygen_video_id'),
    // Render deadline (epoch). A still-`generating` row past this is timed out on the
    // next poll by ANY caller, so a wedged HeyGen job can't be polled forever and the
    // record flips to error even with no editor window open.
    deadlineAt: integer('deadline_at', { mode: 'timestamp' }),

    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: index('avatar_videos_project_idx').on(t.projectId),
    sceneIdx: index('avatar_videos_scene_idx').on(t.sceneId),
    statusIdx: index('avatar_videos_status_idx').on(t.status),
    heygenVideoIdx: index('avatar_videos_heygen_video_idx').on(t.heygenVideoId),
  }),
)

// ── Permission Rules ────────────────────────────────────
export const permissionRules = sqliteTable(
  'permission_rules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<'user' | 'workspace' | 'project' | 'session'>().notNull(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    decision: text('decision').$type<'allow' | 'deny' | 'ask'>().notNull(),
    api: text('api').notNull(),
    specifier: text('specifier', { mode: 'json' })
      .$type<import('../types/permissions').RuleSpecifier | null>()
      .default(null),
    costCapUsd: real('cost_cap_usd'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    createdBy: text('created_by')
      .$type<'user-settings' | 'dialog' | 'migration' | 'admin'>()
      .notNull()
      .default('user-settings'),
    notes: text('notes'),
  },
  (t) => ({
    userScopeIdx: index('permission_rules_user_scope_idx').on(t.userId, t.scope),
    projectIdx: index('permission_rules_project_idx').on(t.projectId),
    workspaceIdx: index('permission_rules_workspace_idx').on(t.workspaceId),
    conversationIdx: index('permission_rules_conversation_idx').on(t.conversationId, t.expiresAt),
  }),
)

// ── Behavior-guidance Rules (CLAUDE.md/Cursor-style) ────────────────────────
// Local-only config (no users FK by design — desktop is single-user and there
// is no desktop user row; see src/electron/ipc/permissions.ts on why permission
// rules were blocked on that). Scope is `user` (global, projectId null) or
// `project` (bound to one project). Injected into the agent system prompt.
export const rules = sqliteTable(
  'rules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scope: text('scope').$type<'user' | 'project'>().notNull().default('user'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    body: text('body').notNull(),
    applyMode: text('apply_mode').$type<'always' | 'glob' | 'manual'>().notNull().default('always'),
    globPattern: text('glob_pattern'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    scopeIdx: index('rules_scope_idx').on(t.scope),
    projectIdx: index('rules_project_idx').on(t.projectId),
  }),
)

// ── GitHub Integration ──────────────────────────────────────────────────────
export const githubLinks = sqliteTable(
  'github_links',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repoFullName: text('repo_full_name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp' }),
    lastPushedSha: text('last_pushed_sha'),
    lastPulledSha: text('last_pulled_sha'),
    linkedAt: integer('linked_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectIdx: uniqueIndex('github_links_project_idx').on(t.projectId),
    repoIdx: index('github_links_repo_idx').on(t.repoFullName),
  }),
)

// ── Project Branches ───────────────────────────────────
export const projectBranches = sqliteTable(
  'project_branches',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).default(false).notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    projectNameIdx: uniqueIndex('branches_project_name_idx').on(t.projectId, t.name),
    projectIdx: index('branches_project_idx').on(t.projectId),
    // One default branch per project — migration 0002 created this partial
    // unique index but it was never declared here, so any DB built from the
    // schema (rather than the migration chain) silently lost the invariant
    // and it rested entirely on setDefaultBranch's transaction (B10).
    projectDefaultIdx: uniqueIndex('branches_project_default_idx')
      .on(t.projectId)
      .where(sql`is_default = 1`),
  }),
)

// ── Scene Versions ─────────────────────────────────────
export const sceneVersions = sqliteTable(
  'scene_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => projectBranches.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    layerSnapshot: text('layer_snapshot', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    operation: text('operation'),
    label: text('label'),
    // Groups every scene-version written by ONE logical operation (an agent run,
    // a user save) under a shared id. Branch history restores by batch boundary,
    // not by raw timestamp — restoring a moment that splices half of one
    // operation with half of another would yield a branch state that never
    // existed. Nullable for legacy rows written before batchId; those fall back
    // to per-row restore.
    batchId: text('batch_id'),
    source: text('source', { enum: ['autosave', 'agent', 'user', 'restore', 'branch-init'] })
      .notNull()
      .default('autosave'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    uniqueVersionIdx: uniqueIndex('scene_versions_unique_idx').on(t.sceneId, t.branchId, t.versionNumber),
    sceneBranchIdx: index('scene_versions_scene_branch_idx').on(t.sceneId, t.branchId),
    // Powers the branch-wide history timeline: all versions on a branch, newest
    // first, in one paginated indexed scan (no per-scene N+1).
    branchCreatedIdx: index('scene_versions_branch_created_idx').on(t.branchId, t.createdAt),
  }),
)

// ── Dead tables: timeline_tracks / timeline_clips ──────
//
// Two tables exist in every installed DB and are defined in NO Drizzle schema —
// deliberately. `src/lib/db/migrations/0000_public_lester.sql:530,556` creates them and
// `0009_track_type_expansion.sql` alters them, but they have no Drizzle
// definitions: zero rows, zero readers, zero writers. Timeline state persists as a BLOB on
// the project row instead (src/lib/db/queries/projects.ts merges `payload.timeline`
// into the scene blob) — the relational design was never adopted.
//
// NOT dropped, on purpose. A DROP needs a new migration + a hand-edited
// meta/_journal.json (everything past 0016 is already hand-written, and 0033 is
// missing from the sequence), and editing 0000 in place would brick FIRST LAUNCH:
// 0009's `UPDATE timeline_tracks` would hit "no such table", which
// migrate.ts:60's isIdempotentDdlReapply does NOT tolerate. Two empty tables cost
// nothing at runtime. This note exists so the next audit stops re-reporting them.
//
// ── Branch Locks ───────────────────────────────────────
// Cross-process advisory lock for branch-mutating operations (delete, fork,
// restore). The in-memory Zustand branchOperation flag only guards one window;
// agents run in separate Electron windows / git worktrees against the SAME
// SQLite file, so the authoritative lock has to live in the DB. Acquire is an
// atomic insert; a stale lock (owner crashed) is reclaimable once its
// heartbeat passes the TTL. See src/lib/db/queries/branch-locks.ts.
export const branchLocks = sqliteTable('branch_locks', {
  branchId: text('branch_id')
    .primaryKey()
    .references(() => projectBranches.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  // Opaque per-window owner token; only the owner (or a TTL-expired takeover)
  // may release.
  ownerId: text('owner_id').notNull(),
  operation: text('operation', { enum: ['delete', 'fork', 'restore', 'promote'] }).notNull(),
  heartbeatAt: integer('heartbeat_at', { mode: 'timestamp' }).default(now()).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
})

// ── Agent Run Leases ───────────────────────────────────
// Cross-process advisory lease for AGENT RUNS. reserveRunSlot guards
// runs WITHIN one window (in-memory); two windows / git worktrees driving the
// same project share one ~/.dreambyte/studio.db, so an in-memory flag can't
// coordinate them. This DB-backed lease mirrors branch_locks: atomic
// upsert-acquire, heartbeat + TTL liveness (a crashed window's lease is
// reclaimable once its heartbeat passes the TTL), self-only release.
//
// Composite PK (project_id, branch_id): runs on DIFFERENT branches of one
// project may run in parallel; same-branch runs across windows are excluded.
// A null/unset branch normalizes to '' (NOT NULL default) so it maps to one
// stable PK value. See src/lib/db/queries/agent-run-leases.ts.
export const agentRunLeases = sqliteTable(
  'agent_run_leases',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    branchId: text('branch_id').notNull().default(''),
    // Opaque per-acquisition owner token; only the owner (or a TTL-expired
    // takeover) may release.
    ownerToken: text('owner_token').notNull(),
    // Human-readable owner identity for the "another run is active" refuse
    // message: which window (instance id) and OS process holds the lease.
    ownerInstanceId: text('owner_instance_id'),
    ownerPid: integer('owner_pid'),
    runId: text('run_id'),
    heartbeatAt: integer('heartbeat_at', { mode: 'timestamp' }).default(now()).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.branchId] }),
  }),
)

// ── Action layer ─────────────────────────────────────
// Append-only action stream is the deepest truth; the
// scenes / layers / projects tables become projections that can always be
// rebuilt from action_log + WAL.
export const actionLog = sqliteTable(
  'action_log',
  {
    id: text('id').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    branchId: text('branch_id'),
    type: text('type').notNull(),
    source: text('source', { enum: ['user', 'agent', 'replay', 'migration'] }).notNull(),
    runId: text('run_id'),
    version: integer('version').default(1).notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    inverseParams: text('inverse_params', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    resultBlobHash: text('result_blob_hash'),
    nondeterministic: integer('nondeterministic', { mode: 'boolean' }).default(false).notNull(),
    timestamp: integer('timestamp').notNull(),
    /**
     * Git commit that owns this action. Rows written before a
     * commit are NULL; the post-commit hook stamps them. The diff viewer
     * fetches by (projectId, commit_sha) ranges to render real per-commit
     * action diffs instead of "everything added".
     */
    commitSha: text('commit_sha'),
  },
  (t) => ({
    projectIdx: index('action_log_project_idx').on(t.projectId),
    branchTsIdx: index('action_log_branch_ts_idx').on(t.branchId, t.timestamp),
    runIdx: index('action_log_run_idx').on(t.runId),
    commitIdx: index('action_log_commit_idx').on(t.projectId, t.commitSha),
  }),
)

// Encrypted Personal Access Tokens for Tier 2 remotes.
// `encryptedToken` is the Electron `safeStorage.encryptString` output — a
// raw Buffer the renderer never sees. One row per (project, remote).
export const gitCredentials = sqliteTable(
  'git_credentials',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    remoteName: text('remote_name').notNull(),
    encryptedToken: blob('encrypted_token').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.remoteName] }),
  }),
)

// Materialized projection. Refreshed every 500 actions (perf finding #1) so
// cold load = latest snapshot + tail replay. One row per (project, branch).
export const materializedState = sqliteTable(
  'materialized_state',
  {
    projectId: text('project_id').notNull(),
    branchId: text('branch_id'),
    lastActionId: text('last_action_id'),
    state: text('state', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.branchId] }),
  }),
)

// Per-branch agent proposal / handoff state. Everything these fields reference
// (scenes, action_log, snapshots, conversations) is branch-scoped, so they are
// keyed (projectId, branchId), mirroring `materialized_state` — a proposal made
// on branch A must not be read by branch B.
//
// branchId is NOT NULL (FK cascade): unlike scenes/materialized_state, which
// use NULL = default branch, every proposal row resolves to a concrete branch
// at the API boundary (null → the project's is_default branch). A composite PK
// with a nullable column does not dedupe in SQLite, so NOT NULL also makes the
// PK well-defined. `version` + `updatedAt` give the SSE write path a staleness
// guard: the client applies an event only when it is newer than its local row.
// `version` is a monotonic bump (not a check-expected-version CAS); safe because
// writes are serialized on single-writer SQLite. See branch-proposals.ts.
export const branchProposals = sqliteTable(
  'branch_proposals',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => projectBranches.id, { onDelete: 'cascade' }),
    structuralCutsProposed: text('structural_cuts_proposed', { mode: 'json' })
      .$type<StructuralCut[] | null>()
      .default(null),
    pausedAgentRun: text('paused_agent_run', { mode: 'json' })
      .$type<{
        toolName: string
        toolInput: Record<string, unknown>
        agentType?: string | null
        reason?: string | null
        createdAt: string
      } | null>()
      .default(null),
    runCheckpoint: text('run_checkpoint', { mode: 'json' })
      .$type<import('../agents/types').RunCheckpoint | null>()
      .default(null),
    // Monotonic per-row counter. Bumped on every write; the SSE event carries
    // the post-write value so the client can reject stale/out-of-order events.
    version: integer('version').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.branchId] }),
  }),
)

// Content-addressable blob store metadata: actions can reference `blob_hash`
// instead of inlining scene HTML / generated code / audio. Files live at
// <user-data>/projects/{projectId}/blobs/<hash>. Nothing writes here yet.
export const blobs = sqliteTable(
  'blobs',
  {
    hash: text('hash').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    refcount: integer('refcount').default(0).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    projectIdx: index('blobs_project_idx').on(t.projectId),
  }),
)

// ── Relations (unchanged from PG version — Drizzle relations are dialect-agnostic) ────
export const userMemoryRelations = relations(userMemory, ({ one }) => ({
  user: one(users, { fields: [userMemory.userId], references: [users.id] }),
}))

export const permissionRulesRelations = relations(permissionRules, ({ one }) => ({
  user: one(users, { fields: [permissionRules.userId], references: [users.id] }),
  workspace: one(workspaces, { fields: [permissionRules.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [permissionRules.projectId], references: [projects.id] }),
  conversation: one(conversations, {
    fields: [permissionRules.conversationId],
    references: [conversations.id],
  }),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  user: one(users, { fields: [workspaces.userId], references: [users.id] }),
  projects: many(projects),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  scenes: many(scenes),
  sceneEdges: many(sceneEdges),
  sceneNodes: many(sceneNodes),
  snapshots: many(snapshots),
  conversations: many(conversations),
  messages: many(messages),
  publishedProjects: many(publishedProjects),
  assets: many(projectAssets),
  characters: many(characters),
  avatarConfigs: many(avatarConfigs),
  avatarVideos: many(avatarVideos),
  clonedVoices: many(clonedVoices),
  branches: many(projectBranches),
}))

export const projectAssetsRelations = relations(projectAssets, ({ one }) => ({
  project: one(projects, { fields: [projectAssets.projectId], references: [projects.id] }),
}))

export const charactersRelations = relations(characters, ({ one }) => ({
  project: one(projects, { fields: [characters.projectId], references: [projects.id] }),
}))

export const clonedVoicesRelations = relations(clonedVoices, ({ one }) => ({
  project: one(projects, { fields: [clonedVoices.projectId], references: [projects.id] }),
}))

export const scenesRelations = relations(scenes, ({ one, many }) => ({
  project: one(projects, { fields: [scenes.projectId], references: [projects.id] }),
  layers: many(layers),
  interactions: many(interactions),
  avatarConfig: one(avatarConfigs, { fields: [scenes.avatarConfigId], references: [avatarConfigs.id] }),
  branch: one(projectBranches, { fields: [scenes.branchId], references: [projectBranches.id] }),
  versions: many(sceneVersions),
}))

export const sceneNodesRelations = relations(sceneNodes, ({ one }) => ({
  project: one(projects, { fields: [sceneNodes.projectId], references: [projects.id] }),
  scene: one(scenes, { fields: [sceneNodes.sceneId], references: [scenes.id] }),
}))

export const layersRelations = relations(layers, ({ one, many }) => ({
  scene: one(scenes, { fields: [layers.sceneId], references: [scenes.id] }),
  parent: one(layers, {
    fields: [layers.parentLayerId],
    references: [layers.id],
    relationName: 'layer_parent',
  }),
  children: many(layers, { relationName: 'layer_parent' }),
  media: one(generatedMedia, {
    fields: [layers.mediaId],
    references: [generatedMedia.id],
  }),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, { fields: [conversations.projectId], references: [projects.id] }),
  messages: many(messages),
  branch: one(projectBranches, { fields: [conversations.branchId], references: [projectBranches.id] }),
}))

export const snapshotsRelations = relations(snapshots, ({ one }) => ({
  project: one(projects, { fields: [snapshots.projectId], references: [projects.id] }),
  branch: one(projectBranches, { fields: [snapshots.branchId], references: [projectBranches.id] }),
}))

export const projectBranchesRelations = relations(projectBranches, ({ one, many }) => ({
  project: one(projects, { fields: [projectBranches.projectId], references: [projects.id] }),
  scenes: many(scenes),
  snapshots: many(snapshots),
  conversations: many(conversations),
  sceneVersions: many(sceneVersions),
  proposals: one(branchProposals, {
    fields: [projectBranches.id],
    references: [branchProposals.branchId],
  }),
}))

export const branchProposalsRelations = relations(branchProposals, ({ one }) => ({
  project: one(projects, { fields: [branchProposals.projectId], references: [projects.id] }),
  branch: one(projectBranches, { fields: [branchProposals.branchId], references: [projectBranches.id] }),
}))

export const sceneVersionsRelations = relations(sceneVersions, ({ one }) => ({
  scene: one(scenes, { fields: [sceneVersions.sceneId], references: [scenes.id] }),
  branch: one(projectBranches, { fields: [sceneVersions.branchId], references: [projectBranches.id] }),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  project: one(projects, { fields: [messages.projectId], references: [projects.id] }),
}))

export const avatarConfigsRelations = relations(avatarConfigs, ({ one, many }) => ({
  project: one(projects, { fields: [avatarConfigs.projectId], references: [projects.id] }),
  videos: many(avatarVideos),
}))

export const avatarVideosRelations = relations(avatarVideos, ({ one }) => ({
  project: one(projects, { fields: [avatarVideos.projectId], references: [projects.id] }),
  scene: one(scenes, { fields: [avatarVideos.sceneId], references: [scenes.id] }),
  avatarConfig: one(avatarConfigs, { fields: [avatarVideos.avatarConfigId], references: [avatarConfigs.id] }),
}))

export const githubLinksRelations = relations(githubLinks, ({ one }) => ({
  project: one(projects, { fields: [githubLinks.projectId], references: [projects.id] }),
}))

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  workspaces: many(workspaces),
  projects: many(projects),
  userMemory: many(userMemory),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

// ── Media analysis cache ───────────────────────────────────────
// Persisted vision/audio/doc understanding, content-addressed so an altered
// file (new contentHash) automatically misses → re-analyzes, and the same clip
// re-uploaded across projects is analyzed once. Keyed by (contentHash, engineId,
// modelVersion): switching engines or a model upgrade re-analyzes rather than
// serving a stale result. Failed/empty analyses are never written (see
// media-analysis-cache.ts). Not project-scoped — it's a shared cache, not state.
export const mediaAnalysis = sqliteTable(
  'media_analysis',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    contentHash: text('content_hash').notNull(),
    engineId: text('engine_id').notNull(),
    kind: text('kind').notNull(),
    modelVersion: text('model_version').notNull().default(''),
    analysis: text('analysis', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(now()).notNull(),
  },
  (t) => ({
    lookupIdx: uniqueIndex('media_analysis_lookup_idx').on(t.contentHash, t.engineId, t.modelVersion),
  }),
)
