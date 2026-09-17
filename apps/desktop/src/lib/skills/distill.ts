/**
 * Video → style-skill distillation.
 *
 * The "magic": walk a FINISHED project (its scenes + globalStyle + the run's
 * toolCalls) and distil a reusable `style` skill — a markdown file in the
 * writable user dir that the auto-load read path can later inject into a fresh
 * build's scene sub-agents. Mirrors the rule-based post-artifact extractor
 * (src/lib/agents/memory-extractor.ts): a deterministic, $0 pass GATHERS facts; an
 * optional LLM sub-agent WRITES the prose.
 *
 * Pipeline (all but enrichStyle are pure / $0):
 *   observeStyle(project, toolCalls) → StyleObservation     (pure, works w/ ZERO designBrief)
 *   enrichStyle(obs)                 → StyleProse            (LLM; fail/empty/malformed → stub)
 *   renderStyleSkill(obs, prose)     → { id, markdown }      (pure; prose in BODY, primitives in frontmatter)
 *   writeStyleSkill(id, markdown)    → on-disk path          (path-guarded, UPSERT, cap 25)
 *
 * LOCKED decisions this file embodies:
 *  - Skills live in the writable ~/.dreambyte/skills/styles/ (registry.getUserStylesDir).
 *  - ALL LLM prose goes in the markdown BODY. parseFrontmatter is a naive
 *        YAML subset that a stray `:`/`[`/`#` corrupts — so frontmatter is
 *        PRIMITIVES ONLY (id/name/category/tier/origin/enrichment/sceneType/
 *        tags/timestamp).
 *  - #3: id = slug(name) + short hash(projectId) → re-distill UPSERTS, never duplicates.
 *  - #4: cap the styles dir at 25 (evict oldest by mtime on write).
 *  - #7: stamp enrichment:'llm'|'stub' so a high stub-rate is visible.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parse as parseYaml } from 'yaml'
import type { Scene } from '../types'
import type { GlobalStyle } from '../types/project'
import { completeText, resolveTextModel, hasAnyTextProviderKey } from '../generation/generate'
import { getUserStylesDir, reindexSkills, searchSkills, loadSkill } from './registry'
import type { SkillContent } from './types'
import { safeResolve } from '../agents/dreambyte-fs/path-guard'
import { STYLE_PRESETS } from '../styles/presets'

// ── Observation (pure, $0) ──────────────────────────────────────────────

/**
 * Deterministic facts gathered from a finished project. Every axis is OPTIONAL
 * in spirit — a sparse project (no preset, no brief, a single scene) still
 * yields a valid observation; absent axes are simply empty. The `designBrief`
 * excerpt is a BONUS signal (often absent — it's an in-memory string, not a
 * file) — never required (#2).
 */
export interface StyleObservation {
  /** The project id the style was distilled from (drives the id hash). */
  projectId: string
  /** 4-colour palette if the project resolved one (preset/override), else []. */
  palette: string[]
  /** Most-common scene background colour, or null. */
  background: string | null
  /** Heading + body fonts in use (deduped, non-empty), or []. */
  fonts: string[]
  /** sceneType → count histogram across the project's scenes. */
  sceneTypeHistogram: Record<string, number>
  /** Dominant sceneType (the most-used renderer), or null when no scenes. */
  dominantSceneType: string | null
  /** Distinct camera-move types observed across scenes (e.g. dollyIn, pan). */
  cameraMoves: string[]
  /** Motion personality if the project set one, else null. */
  motionPersonality: string | null
  /** Style preset id if active, else null. */
  presetId: string | null
  /** Roughness level if any scene carried one, else null. */
  roughness: number | null
  /** Number of scenes observed. */
  sceneCount: number
  /** A short excerpt of the project's design brief, when present (bonus, #2). */
  designBriefExcerpt: string | null
}

const DESIGN_BRIEF_EXCERPT_CHARS = 600

/**
 * Observe a finished project: gather deterministic style facts. Pure, $0, and
 * resilient to a near-empty project — never throws, always returns a complete
 * (possibly-sparse) observation. `toolCalls` is reserved for future motion-preset
 * mining; camera moves come straight off the scenes (authoritative) today.
 */
export function observeStyle(project: {
  id: string
  scenes: Scene[]
  globalStyle?: GlobalStyle | null
}): StyleObservation {
  const scenes = Array.isArray(project.scenes) ? project.scenes : []
  const gs = project.globalStyle ?? undefined

  // Palette: preset override → legacy palette → []. Keep it to 4 entries.
  const paletteSrc = gs?.paletteOverride ?? gs?.palette ?? []
  const palette = (Array.isArray(paletteSrc) ? paletteSrc : [])
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .slice(0, 4)

  // Background: the most-common scene bgColor (falls back to the global override).
  const bgCounts = new Map<string, number>()
  for (const s of scenes) {
    const bg = (s.bgColor || '').trim()
    if (bg) bgCounts.set(bg, (bgCounts.get(bg) ?? 0) + 1)
  }
  const background = [...bgCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? gs?.bgColorOverride ?? null

  // Fonts: heading + body overrides / legacy font, deduped.
  const fonts = Array.from(
    new Set(
      [gs?.fontOverride, gs?.bodyFontOverride, gs?.font]
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim()),
    ),
  )

  // sceneType histogram + dominant renderer.
  const sceneTypeHistogram: Record<string, number> = {}
  for (const s of scenes) {
    const t = (s.sceneType as string) || 'unknown'
    sceneTypeHistogram[t] = (sceneTypeHistogram[t] ?? 0) + 1
  }
  const dominantSceneType = Object.entries(sceneTypeHistogram).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // Camera moves: distinct move types across all scenes.
  const cameraMoveSet = new Set<string>()
  for (const s of scenes) {
    for (const m of s.cameraMotion ?? []) {
      if (m && typeof m.type === 'string') cameraMoveSet.add(m.type)
    }
  }

  // Roughness: first scene that carries a roughness level.
  let roughness: number | null = null
  for (const s of scenes) {
    const r = (s as { roughnessLevel?: number | null }).roughnessLevel
    if (typeof r === 'number') {
      roughness = r
      break
    }
  }

  const brief = gs?.designBrief?.trim()
  const designBriefExcerpt = brief ? brief.slice(0, DESIGN_BRIEF_EXCERPT_CHARS) : null

  return {
    projectId: project.id,
    palette,
    background,
    fonts,
    sceneTypeHistogram,
    dominantSceneType,
    cameraMoves: [...cameraMoveSet].sort(),
    motionPersonality: gs?.motionPersonality ?? null,
    presetId: gs?.presetId ?? null,
    roughness,
    sceneCount: scenes.length,
    designBriefExcerpt,
  }
}

/** True when an observation carries enough signal to be worth distilling.
 *  Used by the tool handler to fail honestly on an empty project. */
export function observationHasSignal(obs: StyleObservation): boolean {
  return (
    obs.sceneCount > 0 &&
    (obs.palette.length > 0 ||
      obs.fonts.length > 0 ||
      obs.background != null ||
      obs.dominantSceneType != null ||
      obs.cameraMoves.length > 0 ||
      obs.presetId != null ||
      obs.designBriefExcerpt != null)
  )
}

// ── Facet projection (saved-style → composer facet sources) ───────

/**
 * A saved style's flat `StyleObservation` facts, PROJECTED onto the faceted-style
 * composer's facet taxonomy (src/lib/agents/faceted-style-composer.ts). This is the
 * decomposition: a saved style is NOT a wholesale
 * prose guide the composer pastes in — it contributes INDIVIDUAL facets the
 * composer can mix per-aspect with a preset/brand/playbook (palette from the
 * saved style, pacing from a playbook, etc.).
 *
 * EVERY facet is OPTIONAL — a sparse saved style (no palette, single scene)
 * simply omits the facets it has no fact for, so the composer never fabricates a
 * source. AUDIO / AVATAR / DATA-VIZ facets are DELIBERATELY ABSENT from this
 * interface: `observeStyle` mines ZERO audio/avatar facts (no audio layers are
 * walked), and the composer treats those as prose hints, not structured facets
 * (hints only). Documenting their absence
 * here is the "documented-empty, do not fabricate" contract.
 */
export interface StyleFacets {
  /** Saved-style palette (≤4 colors) → composer `palette` facet source. */
  palette?: string[]
  /** Saved-style background → composer `background` facet source. */
  background?: string
  /** Saved-style fonts (heading[, body]) → composer `typography` facet source. */
  fonts?: string[]
  /** roughness + presetId → composer `visual character` facet source. */
  visualCharacter?: { roughness?: number | null; presetId?: string | null }
  /** cameraMoves + motionPersonality → composer `motion` facet source. */
  motion?: { cameraMoves?: string[]; motionPersonality?: string | null }
  /** dominantSceneType → composer renderer HINT. */
  renderer?: string
  // NO audio / avatar / dataViz: observeStyle mines no such facts (documented-empty).
}

/**
 * Project a flat {@link StyleObservation} onto the composer's {@link StyleFacets}
 * taxonomy. PURE. Omits any facet with no underlying fact (never fabricates an
 * empty palette/font/motion). Audio/avatar/data-viz facets are not produced — see
 * {@link StyleFacets} for why (they are documented-empty, not silently dropped).
 */
export function observationToFacets(obs: StyleObservation): StyleFacets {
  const facets: StyleFacets = {}
  if (obs.palette.length > 0) facets.palette = [...obs.palette]
  if (obs.background) facets.background = obs.background
  if (obs.fonts.length > 0) facets.fonts = [...obs.fonts]
  // Visual character: only when at least one of roughness/presetId is set.
  if (obs.roughness != null || obs.presetId != null) {
    facets.visualCharacter = { roughness: obs.roughness, presetId: obs.presetId }
  }
  // Motion: only when at least one of cameraMoves/motionPersonality is set.
  if (obs.cameraMoves.length > 0 || obs.motionPersonality != null) {
    facets.motion = {
      cameraMoves: obs.cameraMoves.length > 0 ? [...obs.cameraMoves] : undefined,
      motionPersonality: obs.motionPersonality,
    }
  }
  if (obs.dominantSceneType) facets.renderer = obs.dominantSceneType
  return facets
}

/**
 * A saved style the composer can read as per-facet sources: its human name +
 * the facets projected from its observation. `null` facets/fields are omitted by
 * {@link observationToFacets}, so the composer only ever sees real facts.
 */
export interface SavedStyleFacetSource {
  name: string
  facets: StyleFacets
}

/**
 * Recover {@link StyleFacets} from a LOADED style skill's markdown body (the
 * "## Observed style facts (honour these)" section renderStyleSkill writes). The
 * composer reads a SAVED skill (SkillContent) at compose-time — not a live
 * project — so the facet projection has to round-trip through the on-disk body.
 *
 * renderStyleSkill writes those facts as a deterministic `- **<Label>:** <value>`
 * list; this parses each label back to its facet. Resilient to a sparse body (a
 * stub project with "(sparse project — few concrete facts observed)") — returns
 * whatever it can recover, possibly `{}`. PURE.
 */
export function facetsFromSkillGuide(guide: string): StyleFacets {
  const facets: StyleFacets = {}
  if (!guide) return facets
  // Match the fact lines renderStyleSkill emits: `- **Label:** value`.
  const factRe = /^- \*\*([^:*]+):\*\*\s*(.+)$/gm
  let m: RegExpExecArray | null
  let roughness: number | null = null
  let presetId: string | null = null
  let cameraMoves: string[] = []
  let motionPersonality: string | null = null
  while ((m = factRe.exec(guide)) !== null) {
    const label = m[1].trim().toLowerCase()
    const value = m[2].trim()
    switch (label) {
      case 'palette':
        facets.palette = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .slice(0, 4)
        break
      case 'background':
        facets.background = value
        break
      case 'fonts':
        facets.fonts = value
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
        break
      case 'renderer':
        facets.renderer = value
        break
      case 'camera moves':
        cameraMoves = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
        break
      case 'motion personality':
        motionPersonality = value
        break
      case 'style preset':
        presetId = value
        break
      case 'roughness': {
        const n = Number(value)
        roughness = Number.isFinite(n) ? n : null
        break
      }
    }
  }
  if (roughness != null || presetId != null) {
    facets.visualCharacter = { roughness, presetId }
  }
  if (cameraMoves.length > 0 || motionPersonality != null) {
    facets.motion = {
      cameraMoves: cameraMoves.length > 0 ? cameraMoves : undefined,
      motionPersonality,
    }
  }
  return facets
}

/**
 * Map a saved style's {@link StyleFacets} → the GlobalStyle override fields the
 * WHOLE-STYLE escape hatch writes (`paletteOverride` / `fontOverride` /
 * `bodyFontOverride` / `bgColorOverride` / `motionPersonality` / `presetId`).
 *
 * This is the "use my exact <X> look" path — it writes the saved style's VALUES
 * straight into GlobalStyle, the same visual/motion fields apply_brand_kit and
 * set_global_style already hold. ONLY the fields the saved style actually carries
 * are written (a sparse style leaves the rest untouched); audio/avatar/data are
 * NOT mapped (GlobalStyle holds no such fields — the design's visual/motion-only
 * constraint). PURE; the caller merges the patch into world.globalStyle.
 */
export function facetsToGlobalStylePatch(facets: StyleFacets): {
  paletteOverride?: [string, string, string, string]
  fontOverride?: string
  bodyFontOverride?: string
  bgColorOverride?: string
  motionPersonality?: 'playful' | 'premium' | 'corporate' | 'energetic'
  presetId?: string
} {
  const patch: ReturnType<typeof facetsToGlobalStylePatch> = {}
  if (facets.palette && facets.palette.length >= 4) {
    patch.paletteOverride = facets.palette.slice(0, 4) as [string, string, string, string]
  }
  if (facets.fonts && facets.fonts.length > 0) {
    patch.fontOverride = facets.fonts[0]
    if (facets.fonts[1]) patch.bodyFontOverride = facets.fonts[1]
  }
  if (facets.background) patch.bgColorOverride = facets.background
  const mp = facets.motion?.motionPersonality
  if (mp === 'playful' || mp === 'premium' || mp === 'corporate' || mp === 'energetic') {
    patch.motionPersonality = mp
  }
  // A saved style that itself carried a preset propagates it as the base block —
  // but only if that preset still EXISTS (a renamed/removed base preset must not
  // persist a bogus presetId into GlobalStyle). Mirrors the presetId-ARG guard in
  // style_skill action:'apply' preset path: `(id in STYLE_PRESETS)`.
  const presetId = facets.visualCharacter?.presetId
  if (presetId && presetId !== 'none' && presetId in STYLE_PRESETS) patch.presetId = presetId
  return patch
}

/** True when a projected facet bundle carries at least one usable facet. */
export function hasAnyFacet(f: StyleFacets): boolean {
  return !!(
    (f.palette && f.palette.length) ||
    f.background ||
    (f.fonts && f.fonts.length) ||
    f.visualCharacter ||
    f.motion ||
    f.renderer
  )
}

// ── Prose (LLM enrichment, stubbed in CI) ───────────────────────────────

/**
 * The human-readable layer a style skill needs that observation can't produce:
 * a name and the negative-framed routing prose ("evokes X / reach for it when Y
 * / skipping it risks Z"). Written by the LLM sub-agent; a deterministic stub
 * stands in on any failure.
 */
export interface StyleProse {
  /** Short human name for the style (e.g. "Editorial Calm"). */
  name: string
  /** What this style evokes / feels like. */
  evokes: string
  /** When to reach for it. */
  reachForWhen: string
  /** What skipping / ignoring it risks. */
  skipRisks: string
  /** Searchable intent tags (lowercased, deduped). */
  tags: string[]
  /** Provenance stamp — 'llm' when the model wrote this, 'stub' on fallback (#7). */
  enrichment: 'llm' | 'stub'
}

const ENRICH_SYSTEM_PROMPT = `You name and describe a REUSABLE VIDEO STYLE distilled from a finished project's design facts.

Return ONLY a JSON object (no prose, no markdown fences):
{"name": "<2-4 word style name>", "evokes": "<one sentence on the feeling/mood>", "reachForWhen": "<one sentence: what kind of video this style fits>", "skipRisks": "<one sentence: what a build loses by ignoring this style>", "tags": ["<lowercase intent tag>", ...]}

Rules:
- Be concrete and grounded in the facts you are given (palette, fonts, renderer, camera moves, mood). Do NOT invent facts.
- name is a human label, NOT a slug. tags are 3-6 lowercase single words or hyphenated phrases describing INTENT (e.g. "data-story", "editorial", "energetic", "minimal").
- Keep every string short. No colons-as-structure, no nested objects.`

/** Test seam — swap the LLM transport with a deterministic stub (no network I/O).
 *  Mirrors src/lib/agents/semantic-memory.ts's __setSemanticMemoryTransportForTesting. */
export type EnrichTransport = (systemPrompt: string, userPrompt: string) => Promise<string | null>
let _enrichTransport: EnrichTransport | null = null
export function __setEnrichTransportForTesting(t: EnrichTransport | null): void {
  _enrichTransport = t
}

const ENRICH_TIMEOUT_MS = 15_000

async function callEnrichModel(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (_enrichTransport) return _enrichTransport(systemPrompt, userPrompt)
  if (!hasAnyTextProviderKey()) return null
  const model = resolveTextModel(undefined, 'budget')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ENRICH_TIMEOUT_MS)
  })
  const work = completeText(model, systemPrompt, userPrompt, 400)
    .then((c) => (c?.raw?.trim() ? c.raw : null))
    .catch(() => null)
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Render the deterministic facts into the LLM's user prompt. */
function describeObservation(obs: StyleObservation): string {
  const lines: string[] = []
  if (obs.palette.length) lines.push(`Palette: ${obs.palette.join(', ')}`)
  if (obs.background) lines.push(`Background: ${obs.background}`)
  if (obs.fonts.length) lines.push(`Fonts: ${obs.fonts.join(', ')}`)
  if (obs.dominantSceneType) lines.push(`Dominant renderer: ${obs.dominantSceneType}`)
  if (obs.cameraMoves.length) lines.push(`Camera moves: ${obs.cameraMoves.join(', ')}`)
  if (obs.motionPersonality) lines.push(`Motion personality: ${obs.motionPersonality}`)
  if (obs.presetId) lines.push(`Style preset: ${obs.presetId}`)
  if (obs.roughness != null) lines.push(`Roughness: ${obs.roughness}`)
  lines.push(`Scenes: ${obs.sceneCount}`)
  if (obs.designBriefExcerpt) lines.push(`Design brief excerpt:\n${obs.designBriefExcerpt}`)
  return lines.join('\n')
}

/**
 * Deterministic fallback prose built straight from observation facts. Used when
 * the model fails/empties/returns malformed JSON, OR when the caller supplies a
 * `notes` name hint and we want a guaranteed-valid floor. Stamped enrichment:'stub'.
 */
export function stubProse(obs: StyleObservation, nameHint?: string): StyleProse {
  const renderer = obs.dominantSceneType ?? 'react'
  const paletteBit = obs.palette.length ? `a ${obs.palette.length}-colour palette` : 'a clean palette'
  const fontBit = obs.fonts.length ? ` set in ${obs.fonts[0]}` : ''
  const name =
    nameHint?.trim() || (obs.presetId ? `${titleCase(obs.presetId)} Style` : `${titleCase(renderer)} Project Style`)
  const tags = Array.from(
    new Set(
      [obs.presetId, obs.dominantSceneType, obs.motionPersonality, ...obs.cameraMoves]
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .map((t) => t.toLowerCase()),
    ),
  ).slice(0, 6)
  return {
    name,
    evokes: `A ${renderer} look built on ${paletteBit}${fontBit}.`,
    reachForWhen: `Reach for it on projects that want this project's ${renderer} feel and palette.`,
    skipRisks: `Skipping it risks an inconsistent palette and renderer across a related build.`,
    tags: tags.length ? tags : ['distilled'],
    enrichment: 'stub',
  }
}

/**
 * Enrich an observation into prose via the LLM sub-agent. On ANY failure path —
 * no provider key, model timeout, empty output, or malformed/incomplete JSON —
 * falls back to {@link stubProse} stamped enrichment:'stub' (#7). Never throws.
 */
export async function enrichStyle(
  obs: StyleObservation,
  opts?: { nameHint?: string; notes?: string },
): Promise<StyleProse> {
  const userPrompt = [
    describeObservation(obs),
    opts?.notes ? `User notes about the desired style: ${opts.notes}` : null,
    opts?.nameHint ? `Suggested name: ${opts.nameHint}` : null,
    'Name and describe this style as the JSON object.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await callEnrichModel(ENRICH_SYSTEM_PROMPT, userPrompt)
  const parsed = raw ? parseProse(raw) : null
  if (!parsed) return stubProse(obs, opts?.nameHint)
  return { ...parsed, enrichment: 'llm' }
}

/** Parse + validate the model's JSON prose. Returns null on malformed/incomplete
 *  output so the caller falls back to the stub. */
function parseProse(raw: string): Omit<StyleProse, 'enrichment'> | null {
  // Tolerate ```json fences and leading/trailing chatter.
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const name = str(o.name)
  const evokes = str(o.evokes)
  const reachForWhen = str(o.reachForWhen)
  const skipRisks = str(o.skipRisks)
  // Require the load-bearing fields; tags may be empty (defaulted below).
  if (!name || !evokes || !reachForWhen || !skipRisks) return null
  const tags = Array.isArray(o.tags)
    ? Array.from(new Set(o.tags.map((t) => str(t).toLowerCase()).filter(Boolean))).slice(0, 6)
    : []
  return { name, evokes, reachForWhen, skipRisks, tags: tags.length ? tags : ['distilled'] }
}

// ── Render (pure) ───────────────────────────────────────────────────────

/** Slugify a human name into a filesystem- and id-safe token. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'style'
  )
}

/** Short, stable hash of a project id. Same projectId → same hash → UPSERT (#3). */
function shortHash(projectId: string): string {
  return crypto.createHash('sha256').update(String(projectId)).digest('hex').slice(0, 6)
}

/**
 * The deterministic distilled-skill id: slug(name) + '-' + hash(projectId).
 * Re-distilling the SAME project (same name) yields the SAME id → writeStyleSkill
 * overwrites instead of duplicating. A different project with a colliding name
 * gets a different hash suffix → disambiguated. Pure.
 */
export function styleSkillId(name: string, projectId: string): string {
  return `${slug(name)}-${shortHash(projectId)}`
}

/**
 * Render an observation + prose into a `{ id, markdown }` style skill. PURE.
 *
 * Frontmatter is PRIMITIVES ONLY — every value is a scalar or a flat string
 * array, so parseFrontmatter (a naive YAML subset) round-trips it. ALL prose
 * (name aside) lives in the BODY, where a stray `:`/`[`/`#` can't corrupt the
 * frontmatter. The body also records the observed FACTS so a reader (and the
 * auto-load injector) sees the concrete palette/fonts/renderer to honour.
 */
export function renderStyleSkill(obs: StyleObservation, prose: StyleProse): { id: string; markdown: string } {
  const id = styleSkillId(prose.name, obs.projectId)
  const timestamp = new Date().toISOString()

  // Description is a single-line primitive — strip newlines/colons-as-structure
  // hazards by collapsing whitespace; the rich prose lives in the body.
  const description = `${prose.evokes}`.replace(/\s+/g, ' ').trim().slice(0, 200)

  // Tags are MODEL OUTPUT inside a flat YAML array. An unsanitized tag carrying
  // `]`/`[`/`:`/`#`/`,`/`{`/`}` corrupts the array shape → parseFrontmatter
  // returns null → the just-written skill is un-loadable while the distill
  // still reports SUCCESS. Sanitize each tag down to a bare scalar token first.
  const tags = sanitizeTags(prose.tags)
  const tagsLine = `[${tags.join(', ')}]`

  const frontmatter = [
    '---',
    `id: ${id}`,
    `name: ${sanitizeScalar(prose.name)}`,
    'type: skill',
    'category: style',
    'tier: on-demand',
    'origin: distilled',
    `enrichment: ${prose.enrichment}`,
    'sceneType: any',
    'complexity: medium',
    `tags: ${tagsLine}`,
    `description: ${sanitizeScalar(description)}`,
    `timestamp: ${timestamp}`,
    '---',
  ].join('\n')

  const facts: string[] = []
  if (obs.palette.length) facts.push(`- **Palette:** ${obs.palette.join(', ')}`)
  if (obs.background) facts.push(`- **Background:** ${obs.background}`)
  if (obs.fonts.length) facts.push(`- **Fonts:** ${obs.fonts.join(', ')}`)
  if (obs.dominantSceneType) facts.push(`- **Renderer:** ${obs.dominantSceneType}`)
  if (obs.cameraMoves.length) facts.push(`- **Camera moves:** ${obs.cameraMoves.join(', ')}`)
  if (obs.motionPersonality) facts.push(`- **Motion personality:** ${obs.motionPersonality}`)
  if (obs.presetId) facts.push(`- **Style preset:** ${obs.presetId}`)
  if (obs.roughness != null) facts.push(`- **Roughness:** ${obs.roughness}`)

  const body = [
    `# ${prose.name}`,
    '',
    `> Distilled style skill — learned from a finished project (${obs.sceneCount} scene${obs.sceneCount === 1 ? '' : 's'}).`,
    '',
    '## Evokes',
    prose.evokes,
    '',
    '## Reach for it when',
    prose.reachForWhen,
    '',
    '## Skipping it risks',
    prose.skipRisks,
    '',
    '## Observed style facts (honour these)',
    facts.length ? facts.join('\n') : '- (sparse project — few concrete facts observed)',
    '',
  ].join('\n')

  const markdown = `${frontmatter}\n${body}`

  // ── INVARIANT GUARD ───────────────────────────────────────────────────────
  // A SUCCESSFUL render must ALWAYS produce loadable frontmatter. Re-parse with
  // the SAME yaml the loader (registry.parseFrontmatter) uses; if the frontmatter
  // fails to parse OR is missing the load-bearing id, fall back to a fully-
  // sanitized MINIMAL frontmatter so we never write a file that won't load.
  if (frontmatterIsLoadable(markdown, id)) return { id, markdown }

  const minimalFrontmatter = [
    '---',
    `id: ${id}`,
    `name: ${sanitizeScalar(prose.name) || JSON.stringify(id)}`,
    'type: skill',
    'category: style',
    'tier: on-demand',
    'origin: distilled',
    `enrichment: ${prose.enrichment}`,
    'sceneType: any',
    'complexity: medium',
    'tags: [distilled]',
    'description: A distilled project style.',
    `timestamp: ${timestamp}`,
    '---',
  ].join('\n')
  return { id, markdown: `${minimalFrontmatter}\n${body}` }
}

/** Same frontmatter regex the registry loader uses (registry.FRONTMATTER_RE). */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Verify that the rendered markdown's frontmatter parses through the SAME yaml
 * the loader uses AND carries the expected id, so a SUCCESSFUL render always
 * implies loadSkill(id) ≠ null. Pure (no fs); mirrors registry.parseFrontmatter.
 */
function frontmatterIsLoadable(markdown: string, expectedId: string): boolean {
  const m = markdown.match(FRONTMATTER_RE)
  if (!m) return false
  let parsed: unknown
  try {
    parsed = parseYaml(m[1])
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  // The loader falls back id→filename, but a corrupt id field would still
  // mis-key the skill; require the id to round-trip to the file's id.
  return typeof obj.id === 'string' && obj.id === expectedId
}

/** Collapse anything that would break the naive frontmatter parser when used as
 *  a scalar value: strip newlines and leading/trailing structural characters. */
function sanitizeScalar(v: string): string {
  const cleaned = v.replace(/\s+/g, ' ').trim()
  // A bare leading `[`/`{`/`#`/`>` or an embedded `:` would change the YAML
  // shape; wrap in double quotes when risky so the value stays a plain string.
  if (/[:#[\]{}>]/.test(cleaned)) return JSON.stringify(cleaned)
  return cleaned
}

/** Max tags kept in frontmatter, and the per-tag length cap. */
const MAX_TAGS = 8
const MAX_TAG_LEN = 32

/**
 * Sanitize model-authored tags into bare YAML-array-safe scalar tokens. Strips
 * every frontmatter-hostile char (`[ ] { } : # ,` + quotes), collapses
 * whitespace to hyphens, lowercases, drops empties, dedupes, and caps count +
 * length. A tag like `a: b`, `ev]il`, or `#x` becomes `a-b` / `evil` / `x` —
 * never a char that could re-shape the `tags: [...]` array.
 */
export function sanitizeTags(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(tags) ? tags : []) {
    if (typeof raw !== 'string') continue
    const cleaned = raw
      .toLowerCase()
      // Strip frontmatter-array-hostile chars and quotes outright.
      .replace(/["'`[\]{}:#,]/g, ' ')
      // Anything else non-alphanumeric collapses to a hyphen separator.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_TAG_LEN)
      .replace(/-+$/g, '')
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
    if (out.length >= MAX_TAGS) break
  }
  return out.length ? out : ['distilled']
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

// ── Write (path-guarded, upsert, cap 25) ────────────────────────────────

/** Max distilled style skills kept on disk; the oldest is evicted on write (#4). */
export const MAX_DISTILLED_STYLES = 25

export interface WriteStyleResult {
  id: string
  path: string
  /** Ids evicted to stay under the cap (oldest by mtime), if any. */
  evicted: string[]
}

/**
 * Persist a rendered style skill to the writable user dir. Path-guarded (the id
 * is slugged, but we still assert containment so a crafted id with `../` can't
 * escape), UPSERT (same id overwrites — no duplicate), and capped at
 * {@link MAX_DISTILLED_STYLES} (the oldest files by mtime are evicted BEFORE the
 * write so the dir never exceeds the cap). Invalidates the registry index so the
 * new skill is immediately searchable/loadable.
 *
 * Async (mirrors the path-guard's async API) and never throws on a benign
 * eviction failure — only a path escape or a failed write of the new file
 * rejects.
 */
export async function writeStyleSkill(id: string, markdown: string): Promise<WriteStyleResult> {
  const dir = getUserStylesDir()
  fs.mkdirSync(dir, { recursive: true })

  // Path-guard via the REALPATH-based guard so a symlinked styles dir (or a
  // crafted id with `../`) can't escape. safeResolve realpaths both the root and
  // the resolved target, so a symlink anywhere along the path is collapsed before
  // the containment check — the lexical resolve+isWithin this replaced could be
  // fooled by a symlink at the styles dir itself. We also pin the target to a
  // DIRECT child of the styles dir (one `<id>.md` file, no nested dirs).
  const target = await guardStyleFile(dir, id, 'write')

  // ── Cap enforcement (#4): evict oldest by mtime BEFORE writing the new one ──
  // Count entries that would exist after this write (UPSERT: an existing id
  // doesn't grow the count). Evict from oldest until at/under cap-1, leaving room.
  const evicted: string[] = []
  const existing = listStyleFiles(dir)
  const isUpsert = existing.some((e) => e.id === id)
  const projectedCount = isUpsert ? existing.length : existing.length + 1
  if (projectedCount > MAX_DISTILLED_STYLES) {
    // Sort oldest-first; never evict the id we're about to (over)write.
    const evictable = existing.filter((e) => e.id !== id).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let toRemove = projectedCount - MAX_DISTILLED_STYLES
    for (const e of evictable) {
      if (toRemove <= 0) break
      try {
        fs.unlinkSync(e.path)
        evicted.push(e.id)
        toRemove--
      } catch {
        // best-effort — a vanished file just doesn't count
      }
    }
  }

  // Atomic write: a cross-process reader (the registry's mtime-coherence rescan)
  // mid-write would otherwise read a TRUNCATED file that fails to parse. Write to
  // a temp sibling then rename (atomic on the same fs). Path-guard the temp path
  // too so the rename target stays inside the styles dir.
  // `target` is already realpath-validated to a direct child of the realDir, so a
  // sibling `.tmp` stays inside it; the rename is atomic on the same fs.
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, markdown, 'utf-8')
  fs.renameSync(tmp, target)

  // Invalidate the registry so the new skill is seen immediately (in-process).
  // Cross-process readers pick it up via the mtime coherence path (#1).
  reindexSkills()

  return { id, path: target, evicted }
}

/** List `<id>.md` files in the styles dir with their mtimes (oldest-eviction). */
function listStyleFiles(dir: string): Array<{ id: string; path: string; mtimeMs: number }> {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return [] // dir absent
  }
  const out: Array<{ id: string; path: string; mtimeMs: number }> = []
  for (const f of names) {
    const p = path.join(dir, f)
    try {
      out.push({ id: f.replace(/\.md$/, ''), path: p, mtimeMs: fs.statSync(p).mtimeMs })
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * Delete a distilled style skill. Removes the file and re-indexes.
 * Path-guarded. Returns true if a file was removed, false if absent. Throws on a
 * path escape. (Refusing to delete a curated id is the HANDLER's job — this
 * operates only on the user styles dir, so it can't reach a library file.)
 */
export async function deleteStyleSkill(id: string): Promise<boolean> {
  const dir = getUserStylesDir()
  // The styles dir may not exist yet (nothing distilled) — then there's nothing
  // to delete and the realpath-based guard's realpath(root) would throw.
  if (!fs.existsSync(dir)) return false
  // Realpath-based guard (parity with writeStyleSkill): collapses any symlink at
  // the styles dir before the containment check, and a crafted `../` id is
  // rejected. Pin to a direct child of the (real) styles dir.
  const target = await guardStyleFile(dir, id, 'delete')
  if (!fs.existsSync(target)) return false
  fs.unlinkSync(target)
  reindexSkills()
  return true
}

/**
 * Resolve `<id>.md` under the styles dir through the REALPATH-based path guard
 * (assertContained/safeResolve — symlink-collapsing, unlike a lexical resolve)
 * and assert it's a direct child of the real styles dir. Throws with the file's
 * stable "outside the styles dir" message on any escape (crafted id, or a
 * symlinked styles dir pointing elsewhere). Returns the realpath-validated
 * target so the atomic tmp+rename writes inside the real dir.
 */
async function guardStyleFile(dir: string, id: string, op: 'write' | 'delete'): Promise<string> {
  const verb = op === 'write' ? 'write style skill' : 'delete'
  try {
    const target = await safeResolve(dir, `${id}.md`)
    const realDir = await fs.promises.realpath(dir)
    if (path.dirname(target) !== realDir) {
      throw new Error(`Refusing to ${verb} outside the styles dir: "${id}"`)
    }
    return target
  } catch (e) {
    // Normalize the path-guard's taxonomy (PathEscapeError) to this module's
    // stable contract so callers/tests keep matching /outside the styles dir/.
    if (e instanceof Error && /outside the styles dir/.test(e.message)) throw e
    throw new Error(`Refusing to ${verb} outside the styles dir: "${id}" (${(e as Error).message})`, { cause: e })
  }
}

// ── Read path (auto-load the best distilled style for a build) ──────────

/**
 * Select the single best distilled style skill for a build's intent, or null.
 *
 * The READ arm of the loop : given the intent text of the
 * project being built (scenePlan title + styleNotes + per-scene purposes, or a
 * design brief), rank the distilled `category:'style'` skills by tag/intent
 * match and return the top one. Returns null when no style matches (or none
 * exist) — the caller then injects nothing.
 *
 * PURE (no model): reuses the registry's token scorer scoped to category:'style'
 * (which is excluded from every OTHER search, #4). A non-trivial match floor
 * keeps an unrelated build from pulling in a random style: we require the top
 * hit to actually score on the intent, not just be the only style on disk.
 */
export function selectProjectStyle(intent: string): SkillContent | null {
  const query = (intent || '').trim()
  if (!query) return null

  // searchSkills(category:'style') is a safe SUPERSET of candidates, but its
  // scorer's haystack includes category ('style') and sceneType ('any') — words
  // styleNotes/intent text routinely contain — so it would inject an unrelated
  // saved style into ANY build that merely mentions "style"/"any". Re-score the
  // candidates against name + tags + description ONLY, and require a MEANINGFUL
  // match (≥2 distinct intent tokens hit) so one incidental shared word never
  // force-applies a style.
  const candidates = searchSkills(query, { category: 'style' }, 25)
  if (candidates.length === 0) return null

  const tokens = styleIntentTokens(query)
  if (tokens.length === 0) return null

  let best: { id: string; hits: number } | null = null
  for (const c of candidates) {
    const hits = countStyleTokenHits(tokens, c.metadata)
    if (!best || hits > best.hits) best = { id: c.metadata.id, hits }
  }
  // Floor: a single incidental shared common word is NOT enough. Require ≥2
  // distinct intent tokens to land in name/tags/description.
  if (!best || best.hits < STYLE_MATCH_FLOOR) return null
  return loadSkill(best.id)
}

/**
 * The READ arm for the composer: select the single best saved style
 * for a build's intent (reusing {@link selectProjectStyle}'s top-1 + ≥2-token
 * floor) and return its facets projected from the on-disk body, so the composer
 * can read it as PER-FACET sources (palette here, fonts there) — NOT a wholesale
 * prose template. Returns null when no style matches the floor or the match
 * carries no recoverable facet (so the composer adds no saved-style source).
 */
export function selectProjectStyleFacets(intent: string): SavedStyleFacetSource | null {
  const query = (intent || '').trim()
  if (!query) return null

  // Blast radius: a matched saved style now LEADS palette / font
  // / motion values project-wide, not just a prose guide. So the prose-guide floor
  // (≥2 incidental description tokens) is too weak HERE — two common words shared
  // with the intent's description could front-run the whole look. Raise the bar for
  // THIS path only: require either a genuinely strong description match (≥3 distinct
  // tokens) OR at least one TAG/name hit (intentional, curated routing signal),
  // weighting tag matches over incidental description matches. selectProjectStyle
  // (the PR-E prose-guide path) is intentionally left at the looser ≥2 floor.
  const candidates = searchSkills(query, { category: 'style' }, 25)
  if (candidates.length === 0) return null

  const tokens = styleIntentTokens(query)
  if (tokens.length === 0) return null

  let best: { id: string; tagHits: number; allHits: number } | null = null
  for (const c of candidates) {
    const tagHits = countStyleTokenHits(tokens, { name: c.metadata.name, tags: c.metadata.tags, description: '' })
    const allHits = countStyleTokenHits(tokens, c.metadata)
    // Rank tag/name hits first (curated intent), then total hits as a tiebreak.
    if (!best || tagHits > best.tagHits || (tagHits === best.tagHits && allHits > best.allHits)) {
      best = { id: c.metadata.id, tagHits, allHits }
    }
  }
  if (!best) return null
  const qualifies = best.tagHits >= 1 || best.allHits >= STYLE_FACET_MATCH_FLOOR
  if (!qualifies) return null

  const skill = loadSkill(best.id)
  if (!skill) return null
  const facets = facetsFromSkillGuide(skill.guide)
  if (!hasAnyFacet(facets)) return null
  return { name: skill.metadata.name, facets }
}

/** Minimum distinct intent-token hits (name+tags+description) to auto-load a style. */
const STYLE_MATCH_FLOOR = 2

/**
 * Stricter floor for the FACET-INJECTING read path (selectProjectStyleFacets):
 * since a match now LEADS the project's palette/font/motion, an incidental
 * 2-description-word overlap must NOT lead the look. We require either ≥1 tag/name
 * hit (curated routing) or ≥3 distinct description-token hits. Deliberately higher
 * than STYLE_MATCH_FLOOR (the prose-guide path, which only suggests prose).
 */
const STYLE_FACET_MATCH_FLOOR = 3

/** Tokenize an intent string the same way the registry scorer does (≥2 chars). */
function styleIntentTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter((t) => t.length > 1),
    ),
  )
}

/**
 * Count DISTINCT intent tokens that hit a style skill's name, tags, or
 * description — deliberately EXCLUDING category ('style') and sceneType ('any'),
 * which every distilled style shares and which intent text routinely contains.
 */
function countStyleTokenHits(tokens: string[], meta: { name: string; tags: string[]; description: string }): number {
  const haystack = [meta.name, meta.tags.join(' '), meta.description].join(' ').toLowerCase()
  let hits = 0
  for (const t of tokens) {
    if (haystack.includes(t)) hits++
  }
  return hits
}

/**
 * Build the intent string a `selectProjectStyle` match scores against, from the
 * loose shape of a scenePlan (or a plain brief). Kept here (not in the
 * orchestrator) so the read-path heuristic lives next to the write path it
 * mirrors. Accepts `unknown`-ish fields defensively — callers pass a real
 * ScenePlan, but tests and the brief path pass partials.
 */
export function buildStyleIntent(input: {
  title?: string | null
  styleNotes?: string | null
  scenes?: Array<{ name?: string | null; purpose?: string | null }> | null
  brief?: string | null
}): string {
  const parts: string[] = []
  if (input.brief) parts.push(input.brief)
  if (input.title) parts.push(input.title)
  if (input.styleNotes) parts.push(input.styleNotes)
  for (const s of input.scenes ?? []) {
    if (s?.name) parts.push(s.name)
    if (s?.purpose) parts.push(s.purpose)
  }
  return parts.filter(Boolean).join(' ').trim()
}

// ── End-to-end convenience (used by the tool handler) ────────────────────

/**
 * Full write-path: observe → enrich → render → write. Returns the new skill id +
 * a summary, or null when the project has no distillable signal (the handler maps
 * null to an honest error). Mirrors the memory-extractor's post-artifact shape.
 */
export async function distillStyle(
  project: { id: string; scenes: Scene[]; globalStyle?: GlobalStyle | null },
  opts?: { nameHint?: string; notes?: string },
): Promise<{ id: string; path: string; name: string; enrichment: 'llm' | 'stub'; evicted: string[] } | null> {
  const obs = observeStyle(project)
  if (!observationHasSignal(obs)) return null
  const prose = await enrichStyle(obs, opts)
  const { id, markdown } = renderStyleSkill(obs, prose)
  const write = await writeStyleSkill(id, markdown)
  return { id: write.id, path: write.path, name: prose.name, enrichment: prose.enrichment, evicted: write.evicted }
}
