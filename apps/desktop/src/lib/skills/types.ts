/**
 * Skill registry types for the Dreambyte agent framework.
 *
 * Skills are discoverable capability packages — markdown files with frontmatter
 * that the Builder agent can search, load, and use at runtime.
 * Inspired by Claude Agent SDK's SKILL.md pattern and Composio's meta-tool discovery.
 */

// ── Skill Metadata (indexed at startup, kept in memory) ─────────────────────

export interface SkillParameter {
  name: string
  type: string
  default?: unknown
  description: string
  enum?: string[]
}

/**
 * `always` skills are part of the agent's baseline doctrine and are surfaced
 * regardless of the prompt; `on-demand` skills are loaded only when the plan
 * phase matches them. Defaults to `on-demand` when unspecified.
 */
export type SkillTier = 'always' | 'on-demand'

export interface SkillMetadata {
  /** Unique skill ID (filename without extension) */
  id: string
  /** Human-readable name */
  name: string
  /** Skill category for browsing */
  category: SkillCategory
  /** Searchable tags */
  tags: string[]
  /** Which scene type this skill targets (or 'any') */
  sceneType: string
  /** How complex the implementation is */
  complexity: 'simple' | 'medium' | 'complex'
  /** IDs of skills this one depends on */
  requires: string[]
  /** Short description for search results */
  description: string
  /** Customizable parameters the agent can tune */
  parameters: SkillParameter[]

  // ── OKF (Open Knowledge Format) aliases ────────────────────────────────────
  // The registry is an OKF substrate: every concept file carries a stable OKF
  // surface (type/title/description/timestamp) alongside the registry-native
  // fields above. `description` is shared between both schemas.

  /** OKF concept type. Renderer/effect/etc. skills are `skill` concepts. */
  type: string
  /** OKF human title (alias of `name`; falls back to `name`). */
  title: string
  /** OKF last-updated marker (ISO-8601 string or empty). */
  timestamp: string
  /** Routing tier: `always` (baseline doctrine) or `on-demand` (matched). */
  tier: SkillTier

  // ── Distilled-style provenance ────────────────────────────────────────
  // Curated library skills omit these (they default to `curated` / unset).
  // Distilled style skills (video→style-skill distillation, written to the
  // writable user dir) carry them so growth governance and stub-rate honesty
  // are visible from metadata alone.

  /**
   * Where the skill came from. `curated` = bundled `library/*.md` (read-only,
   * hand-authored). `distilled` = produced by `style_skill` action:'distill' from a finished
   * project, living in the writable user dir. Defaults to `curated`.
   */
  origin: SkillOrigin
  /**
   * How a distilled skill's prose was produced. `llm` = the enrichment
   * sub-agent wrote it; `stub` = the model failed/empty/malformed and a
   * deterministic fallback was rendered from observed facts (visible so a high
   * stub-rate surfaces — #7). Empty string on curated skills. */
  enrichment: SkillEnrichment | ''
}

/** Provenance of a skill file. */
export type SkillOrigin = 'curated' | 'distilled'

/** How a distilled skill's prose was authored. */
export type SkillEnrichment = 'llm' | 'stub'

export type SkillCategory =
  | 'renderer' // Scene type foundations (canvas2d, three, motion, etc.)
  | 'effect' // Visual effects (particles, shaders, distortion)
  | 'animation' // Animation patterns (reveals, transitions, morphs)
  | 'layout' // Layout systems (grids, split, stacked)
  | 'data-viz' // Data visualization (charts, graphs, dashboards)
  | 'interaction' // Interactive elements (buttons, sliders, hover)
  | 'audio' // Audio-reactive, music sync, narration
  | 'typography' // Text effects, kinetic type
  | '3d' // 3D scenes, environments, models
  | 'media' // Video, images, avatars
  | 'template' // Pre-built scene templates
  | 'technique' // General techniques (PRNG, easing, color)
  | 'style' // Distilled project styles (video→style-skill distillation)

// ── Full Skill Content (loaded on demand) ───────────────────────────────────

export interface SkillContent {
  metadata: SkillMetadata
  /** Full implementation guide (markdown body after frontmatter) */
  guide: string
}

// ── Search Results ──────────────────────────────────────────────────────────

export interface SkillSearchResult {
  /** Skill metadata (no guide — lightweight) */
  metadata: SkillMetadata
  /** Relevance score (0-1) */
  score: number
}
