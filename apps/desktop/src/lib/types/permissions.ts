// ── AI Media Generation Types ───────────────────────────────────────────────

export type APIName =
  | 'heygen'
  | 'veo3'
  | 'kling'
  | 'runway'
  // fal-hosted video models (Phase 2 breadth) — run via makeFalVideoProvider.
  | 'ltx'
  | 'wan'
  | 'seedance'
  | 'hailuo'
  // Frontier video breadth — fal-hosted (own billing identity so spend gates per model, not bypassed).
  | 'veo31'
  | 'kling25'
  | 'seedance2'
  | 'imageGen'
  // Tier 3: video upscale (super-resolution). Its OWN permission/cost bucket — NOT the generation
  // provider's — because it's one shared, model-agnostic post-process. Keying it on provider.id would
  // let a caller run the same paid upscale under any allowed generation bucket and bill the cheapest.
  | 'videoUpscale'
  | 'backgroundRemoval'
  | 'elevenLabs'
  // ElevenLabs Music — own billing identity (NOT shared with elevenLabs TTS/SFX): music is
  // ~$0.40/clip vs ~$0.06 for TTS, so sharing the scalar would undercharge ~85% and defeat caps.
  | 'elevenLabsMusic'
  // Google Lyria music — own billing identity (distinct cost from Veo/Imagen/TTS under GOOGLE_AI_KEY).
  | 'googleLyria'
  | 'unsplash'
  | 'googleTts'
  | 'googleImageGen'
  | 'openaiTts'
  | 'geminiTts'
  | 'falMusic'
  | 'freesound'
  | 'pixabay'
  | 'falAvatar'

export type GenerationType = 'avatar' | 'image' | 'tts' | 'sfx' | 'music' | 'video'

export interface GenerationProviderOption {
  id: string
  name: string
  cost: string
  isFree: boolean
}

export type PermissionMode = 'always_ask' | 'always_allow' | 'always_deny' | 'ask_once'

export interface PermissionConfig {
  mode: PermissionMode
  sessionLimit: number | null
  monthlyLimit: number | null
  sessionSpend: number
  monthlySpend: number
  /** Per-API override for the single-call cost approval threshold (USD).
   *  When the estimated cost for a single call exceeds this value, an
   *  otherwise-auto-allowed call is upgraded to `ask`. `null` means use the
   *  project-level default (currently $0.50). */
  singleCallCostThreshold?: number | null
}

export interface APIPermissions {
  heygen: PermissionConfig
  veo3: PermissionConfig
  kling: PermissionConfig
  runway: PermissionConfig
  ltx: PermissionConfig
  wan: PermissionConfig
  seedance: PermissionConfig
  hailuo: PermissionConfig
  veo31: PermissionConfig
  kling25: PermissionConfig
  seedance2: PermissionConfig
  imageGen: PermissionConfig
  videoUpscale: PermissionConfig
  backgroundRemoval: PermissionConfig
  elevenLabs: PermissionConfig
  elevenLabsMusic: PermissionConfig
  googleLyria: PermissionConfig
  unsplash: PermissionConfig
  googleTts: PermissionConfig
  googleImageGen: PermissionConfig
  openaiTts: PermissionConfig
  geminiTts: PermissionConfig
  falMusic: PermissionConfig
  freesound: PermissionConfig
  pixabay: PermissionConfig
  falAvatar: PermissionConfig
}

export interface PermissionRequest {
  id: string
  api: APIName
  estimatedCost: string
  /** Scalar USD estimate used to evaluate the cost-approval threshold.
   *  Populated when the gate engine could compute one; omitted for APIs
   *  whose cost model is too variable to estimate statically. */
  estimatedCostUsd?: number
  /** When set, this request was surfaced because the scalar estimate exceeded
   *  the project's single-call threshold. Helps the UI tell the difference
   *  between "always_ask" prompts and cost-triggered prompts. */
  costThresholdExceeded?: boolean
  reason: string
  details: {
    prompt?: string
    duration?: number
    model?: string
    resolution?: string
    /** Tier 3: video upscale factor (2 or 4). The cost gate scales the flat `videoUpscale` estimate
     *  by it (4× ≈ 2× the base) so the ask/deny threshold sees the SAME amount reserve/commit charge. */
    upscaleFactor?: number
  }
}

export interface PermissionResponse {
  id: string
  decision: 'allow' | 'deny'
  remember: 'once' | 'session' | 'always'
}

/** Result of the in-app always-ask spend modal (the Promise `requestSpendApproval` resolves to).
 *  `scope` tells the caller how to persist the approval: 'once'/'session' → renderer session set +
 *  approvedAsk re-dispatch; 'always' → persist apiPermissions[api].mode = 'always_allow'. */
export type SpendApprovalDecision =
  | { decision: 'approved'; scope: 'once' | 'session' | 'always' }
  | { decision: 'denied' }

// ── Rule-based permissions (Claude-Code-style) ──────────────────────────────

/** Scopes stack user → workspace → project → session, plus transient per-call. */
export const PERMISSION_SCOPES = ['user', 'workspace', 'project', 'session'] as const
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

export const PERMISSION_DECISIONS = ['allow', 'deny', 'ask'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Rule precedence (lower = higher priority). Used by evaluator tie-breaking
 *  when multiple rules match; deny-wins still overrides this. */
export const SCOPE_PRECEDENCE: Record<PermissionScope, number> = {
  session: 0,
  project: 1,
  workspace: 2,
  user: 3,
}

/** Sub-target conditions. All provided fields must match; unset fields match any. */
export interface RuleSpecifier {
  /** Provider id within the API (e.g. `flux-schnell`, `veo3`, `elevenlabs-turbo`). */
  provider?: string
  /** Provider-specific model id. */
  model?: string
  /** Max duration in seconds (video/tts). */
  durationMax?: number
  /** Min duration in seconds. */
  durationMin?: number
  /** Max per-call cost in USD. Independent of rule decision — used by evaluator
   *  to escalate an otherwise-allowed call back to `ask` when estimate exceeds. */
  costMax?: number
  /** All substrings must appear (case-insensitive) in the prompt to match. */
  promptContains?: string[]
  /** If any substring appears in the prompt, the rule does NOT match. */
  promptNotContains?: string[]
}

/** Call-site context passed to the evaluator. */
export interface PermissionCallDetails {
  prompt?: string
  duration?: number
  provider?: string
  model?: string
  resolution?: string
  /** Scalar estimate in USD. Required for costMax gating. */
  estimatedCostUsd?: number
}

/** A single layered permission rule. Lives in `permission_rules` table. */
export interface PermissionRule {
  id: string
  scope: PermissionScope
  /** Always set — rules are authored by an authenticated user. */
  userId: string
  /** Set when scope ∈ {workspace, project, session}. */
  workspaceId: string | null
  /** Set when scope ∈ {project, session}. */
  projectId: string | null
  /** Set when scope = session. */
  conversationId: string | null
  decision: PermissionDecision
  /** `*` matches any API. */
  api: APIName | '*'
  specifier: RuleSpecifier | null
  /** Optional per-call cost cap. Applied even when decision is `allow`. */
  costCapUsd: number | null
  /** When non-null the rule is ignored after this moment. */
  expiresAt: Date | null
  createdAt: Date
  createdBy: 'user-settings' | 'dialog' | 'migration' | 'admin'
  notes: string | null
}

/** Everything needed to evaluate a single call. */
export interface PermissionContext {
  userId: string
  workspaceId: string | null
  projectId: string | null
  conversationId: string | null
  api: APIName
  call: PermissionCallDetails
}

/** Spend state flows in from project-level cost tracking (unchanged). */
export interface SpendState {
  sessionSpend: number
  sessionLimit: number | null
  monthlySpend: number
  monthlyLimit: number | null
}

export type PermissionEvalResult =
  | { action: 'allow'; matchedRuleId: string | null }
  | { action: 'deny'; reason: string; matchedRuleId: string | null }
  | { action: 'ask'; reason: string; costTriggered: boolean; matchedRuleId: string | null }
