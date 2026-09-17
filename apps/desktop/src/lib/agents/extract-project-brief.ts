/**
 * OKF Layer 0 — extract a ProjectBrief (the "compass") from a user prompt.
 *
 * This is Mace's whiteboard / log-line phase, encoded: take the user's request
 * and distil it into INTENT — video type, the log line (problem → intention →
 * obstacle → solution), audience, who drives the voice, and the media strategy.
 * The brief becomes durable project-level memory (persisted on the project row)
 * and is injected into every agent turn.
 *
 * The brief itself is advisory; routing off it happens in okf/intent-router.ts.
 *
 * Provider-agnostic: routes through completeText (the same single-shot completion
 * Anthropic / OpenAI / Google / DeepSeek / Qwen / Kimi / local Ollama all share),
 * so extraction uses whatever provider the user configured — NOT hardcoded
 * Anthropic. resolveTextModel maps the run's model to that provider's budget tier
 * (extraction is a cheap task). Flow: completeText → strip code fences →
 * JSON.parse → normalize/validate → one repair retry. The normalizer is pure and
 * exported so the field logic is unit-tested without an API call.
 */

import { completeText, resolveTextModel } from '../generation/generate'
import { logSpend } from '../db'
import type { ModelConfig } from './model-config'
import type { AspectRatio } from '../dimensions'
import type { ProjectBrief, MediaStrategy, VideoType, VoiceDriver } from '../types'
import { createLogger } from '../logger'

const log = createLogger('agents.extract-project-brief')

const VIDEO_TYPES: VideoType[] = [
  'film',
  'marketing',
  'explainer',
  'educational',
  'professional',
  'podcast',
  'shortform',
  'other',
]
const VOICE_DRIVERS: VoiceDriver[] = ['narration-led', 'visual-led', 'dialogue-led']
const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:5']

export interface ExtractBriefInput {
  /** The user's request / first prompt. */
  prompt: string
  /** The project's actual aspect ratio (from mp4Settings) — format is a project
   *  setting, not something the model should guess. */
  aspectRatio: AspectRatio
  /** The run's model id, so extraction uses the SAME provider the user configured
   *  (DeepSeek / Kimi / Qwen / Anthropic / local). Resolved to that provider's
   *  budget tier. When omitted, the first provider with a configured key wins. */
  model?: string
  /** Model registry — needed to resolve local/OpenAI-compat provider routing. */
  modelConfigs?: ModelConfig[]
  /** Project id — when set, extraction spend is written to the cost ledger so it
   *  isn't an off-ledger charge. */
  projectId?: string
}

/**
 * shortform vs longform — the REGIME that decides the shortform pacing profile +
 * single-act-fast pacing vs the longform 3-act arcs.
 *
 * FORMAT and TYPE decide the regime, NOT runtime. Vertical/portrait feed formats
 * (9:16, 4:5) and an explicit `shortform` videoType are the shortform regime;
 * landscape and square (16:9, 1:1) use the longform arc — COMPRESSED when the
 * runtime is short, but still the proper arc, never vertical shortform
 * packaging. A 30–60s 16:9 educational / film / marketing is a SHORT LONGFORM
 * piece, not a TikTok.
 *
 * Runtime must not override the format (a `runtimeTargetSec ≤ 60 → shortform`
 * rule would mis-route 16:9 educational/film/professional requests into the
 * vertical shortform regime), so runtime only breaks ties when the aspect ratio
 * is unknown.
 */
export function deriveLengthClass(
  aspectRatio: AspectRatio,
  runtimeTargetSec: number | null,
  videoType?: VideoType,
): 'shortform' | 'longform' {
  if (videoType === 'shortform') return 'shortform'
  if (aspectRatio === '9:16' || aspectRatio === '4:5') return 'shortform'
  if (aspectRatio === '16:9' || aspectRatio === '1:1') return 'longform'
  // Aspect unknown — fall back to runtime, then default longform.
  if (runtimeTargetSec != null && Number.isFinite(runtimeTargetSec)) {
    return runtimeTargetSec <= 30 ? 'shortform' : 'longform'
  }
  return 'longform'
}

function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1'
  return fallback
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function clampEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === 'string' && (allowed as string[]).includes(v) ? (v as T) : fallback
}

function normalizeMediaStrategy(v: unknown): MediaStrategy {
  const m = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const o = (m.overlays && typeof m.overlays === 'object' ? m.overlays : {}) as Record<string, unknown>
  return {
    research: asBool(m.research),
    stock: asBool(m.stock),
    generate: asBool(m.generate),
    userAssets: asBool(m.userAssets),
    branding: asBool(m.branding),
    overlays: {
      captions: asBool(o.captions),
      stickers: asBool(o.stickers),
      svgs: asBool(o.svgs),
      lowerThirds: asBool(o.lowerThirds),
    },
  }
}

/**
 * Coerce a raw parsed object into a valid ProjectBrief. Pure + total: never
 * throws, always returns a well-formed brief, so a sloppy LLM response degrades
 * to safe defaults rather than corrupting project state. aspectRatio comes from
 * the project (not the model); lengthClass is always derived, never trusted.
 */
export function normalizeProjectBrief(parsed: unknown, opts: { aspectRatio: AspectRatio }): ProjectBrief {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  const runtimeRaw = p.runtimeTargetSec
  const runtimeTargetSec =
    typeof runtimeRaw === 'number' && Number.isFinite(runtimeRaw) && runtimeRaw > 0 ? runtimeRaw : null

  const intentRaw = p.intent && typeof p.intent === 'object' ? (p.intent as Record<string, unknown>) : null
  const intent = intentRaw
    ? {
        problem: asString(intentRaw.problem),
        intention: asString(intentRaw.intention),
        obstacle: asString(intentRaw.obstacle),
        solution: asString(intentRaw.solution),
      }
    : null

  const confidenceRaw = p.confidence
  // A MISSING/invalid confidence means the model didn't tell us how sure it is —
  // which is exactly when we should treat the brief as low-confidence (it trips
  // the < 0.5 confirm directive). The old 0.5 default sat ON the threshold and
  // silently passed as "confident enough". Explicit numbers are honored as-is.
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.4

  // Prefer the format the user actually asked for ("vertical TikTok" → 9:16);
  // fall back to the project's current setting only when the prompt is silent.
  const aspectRatio = clampEnum<AspectRatio>(p.requestedAspectRatio, ASPECT_RATIOS, opts.aspectRatio)
  const videoType = clampEnum<VideoType>(p.videoType, VIDEO_TYPES, 'other')

  const brief: ProjectBrief = {
    aspectRatio,
    lengthClass: deriveLengthClass(aspectRatio, runtimeTargetSec, videoType),
    runtimeTargetSec,

    videoType,
    logLine: asString(p.logLine),
    intent,
    audience: asString(p.audience),
    voiceDriver: clampEnum<VoiceDriver>(p.voiceDriver, VOICE_DRIVERS, 'narration-led'),
    hasUploadedFootage: asBool(p.hasUploadedFootage),
    footageHasSpeech: asBool(p.footageHasSpeech),
    isAvatarCentric: asBool(p.isAvatarCentric),
    mediaStrategy: normalizeMediaStrategy(p.mediaStrategy),

    source: 'agent-inferred',
    confidence,
    version: 1,
  }

  if (typeof p.title === 'string' && p.title.trim()) brief.title = p.title.trim()
  if (typeof p.thumbnailConcept === 'string' && p.thumbnailConcept.trim()) {
    brief.thumbnailConcept = p.thumbnailConcept.trim()
  }

  // A brief that carries spoken-footage editing but no footage is incoherent —
  // reconcile (the footage-edit lane keys off both in later phases).
  if (brief.footageHasSpeech && !brief.hasUploadedFootage) brief.footageHasSpeech = false

  return brief
}

export function buildSystemPrompt(): string {
  return `You are a film producer's assistant. Read the user's video request and distil it
into a structured INTENT brief — the "compass" the whole production follows.

Return JSON ONLY, no prose, with exactly these keys:
{
  "videoType": one of ${VIDEO_TYPES.map((t) => `"${t}"`).join(' | ')} — "educational" means the viewer wants to BE TAUGHT a concept or skill step-by-step, with checkpoints ("teach me gradient descent", "walk me through OAuth"). "explainer" means informational or NARRATIVE content ABOUT a topic for a general audience, INCLUDING documentary-style retrospectives and origin stories ("the rise of X", "the history of Y", "how X became Z"). When a topic is educational in the everyday sense but the request is to tell its story rather than tutor the viewer, pick "explainer",
  "requestedAspectRatio": "16:9" | "9:16" | "1:1" | "4:5" if the user implies a format (vertical/TikTok/Reel/Short/Stories → "9:16"; widescreen/YouTube/landscape/film → "16:9"; square → "1:1"), else null,
  "runtimeTargetSec": number of seconds the finished video should run, or null if unstated,
  "logLine": one sentence compressing the whole video (problem → intention → obstacle → solution),
  "intent": { "problem": "", "intention": "", "obstacle": "", "solution": "" } or null,
  "audience": who this is for,
  "title": working title or omit,
  "thumbnailConcept": only for shortform/marketing, else omit,
  "voiceDriver": "narration-led" (explainer/podcast) | "visual-led" | "dialogue-led",
  "hasUploadedFootage": true if the user mentions their own footage/clips,
  "footageHasSpeech": true if that footage has people talking,
  "isAvatarCentric": true if a presenter/avatar is the main focus,
  "mediaStrategy": {
    "research": bool, "stock": bool, "generate": bool, "userAssets": bool, "branding": bool,
    "overlays": { "captions": bool, "stickers": bool, "svgs": bool, "lowerThirds": bool }
  },   // stock/generate/research drive whether the video is GROUNDED IN IMAGERY — see the media rule below,
  "confidence": 0..1 — how sure you are given how much the user actually specified
}

Rules:
- Infer conservatively about what the USER OWNS (footage, branding). Do NOT invent uploaded footage, branding, or user assets they did not imply — leave userAssets/branding false unless implied.
- USER'S STATED STYLE WINS. If the user explicitly asks for a minimal, text-only, typographic, kinetic-typography, "no photos"/"no imagery", or purely abstract look, HONOR it — set stock/generate/research false even for a real subject. The user chose the style; do not override it with imagery. Only apply the "not conservative" default below when the user did NOT constrain the visual style.
- MEDIA IS NOT CONSERVATIVE (default when the user did not pin a minimal/abstract style). If the video is ABOUT real people, places, events, or organisations (explainer/documentary/marketing/educational about a real subject), set "stock":true and "research":true — such a story SHOULD be grounded in real photos/footage/archival, and stock+archival search is free. Set "generate":true when the subject needs imagery no stock library would have (invented scenes, stylised concepts). If the content is quantitative or comparative (rankings, counts, %, timelines, tallies, before/after), set overlays.svgs true — it wants charts/diagrams, not plain text. Leave media false for a genuinely abstract or text-only piece, OR when the user asked for that style (above). A pure-text video about a visual or data-rich subject is a DEFECT only when the user did NOT ask for text-only — an explicitly-requested minimal style is a choice, not a defect.
- The log line is a compass, not a summary — keep it to one tight sentence.`
}

async function completeOnce(
  model: string,
  system: string,
  userContent: string,
  modelConfigs?: ModelConfig[],
): Promise<{ raw: string; costUsd: number }> {
  // 1500 (not 1024): the brief asks for ~15 fields incl. 4 intent sub-fields;
  // a tight cap risks truncating valid JSON mid-object on a chatty model.
  const { raw, inputTokens, outputTokens, costUsd } = await completeText(model, system, userContent, 1500, modelConfigs)
  // debug (not info): the raw output can echo user content (audience, log line);
  // don't log it verbatim on every run.
  log.debug('brief extraction response', {
    extra: { model, costUsd, inTok: inputTokens, outTok: outputTokens, preview: raw.slice(0, 400) },
  })
  return { raw, costUsd }
}

function parseBrief(raw: string, model: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    log.warn('brief extraction JSON.parse failed', { extra: { model, cleanedPreview: cleaned.slice(0, 400) } })
    throw e
  }
}

/**
 * Extract a ProjectBrief from a prompt via the configured provider. Throws only
 * if BOTH the first call and the repair retry fail to produce parseable JSON (or
 * the provider errors); otherwise always returns a normalized brief
 * (low-confidence on a thin prompt). Callers wrap this best-effort. Spend across
 * both calls is written to the cost ledger (when projectId is set) even on a
 * total failure, so it's never an off-ledger charge.
 */
export async function extractProjectBrief(input: ExtractBriefInput): Promise<ProjectBrief> {
  // Budget tier of whatever provider the run uses — extraction is cheap and
  // should never spend a premium reasoning model.
  const model = resolveTextModel(input.model, 'budget', input.modelConfigs)
  const system = buildSystemPrompt()
  const userContent = `Video request:\n${input.prompt}`
  log.info('brief extraction start', { extra: { requested: input.model ?? null, resolved: model } })

  let totalCost = 0
  try {
    try {
      const first = await completeOnce(model, system, userContent, input.modelConfigs)
      totalCost += first.costUsd
      return normalizeProjectBrief(parseBrief(first.raw, model), { aspectRatio: input.aspectRatio })
    } catch (firstErr) {
      log.warn('first extraction parse failed, retrying', { error: firstErr })
      const repair = await completeOnce(
        model,
        system,
        `${userContent}\n\nYour previous response was not valid JSON. Return JSON ONLY, matching the shape above.`,
        input.modelConfigs,
      )
      totalCost += repair.costUsd
      return normalizeProjectBrief(parseBrief(repair.raw, model), { aspectRatio: input.aspectRatio })
    }
  } finally {
    if (input.projectId && totalCost > 0) {
      void logSpend(input.projectId, 'okf:brief-extraction', totalCost, input.prompt.slice(0, 200)).catch(() => {})
    }
  }
}

/**
 * Best-effort, time-boxed brief extraction with ONE retry.
 *
 * Brief extraction failing silently strips ALL OKF film craft from the run
 * (the craft injection is gated on a non-null projectBrief), so a transient
 * timeout / parse blip must not permanently blind the build. Runs `attempt`
 * under a hard timeout; on failure, retries once; returns null only when BOTH
 * attempts fail — the caller then logs loudly and proceeds craft-less rather
 * than pretending nothing happened.
 *
 * Exported so the retry contract is unit-testable without a live model.
 */
export async function extractBriefWithRetry(
  attempt: () => Promise<ProjectBrief>,
  opts: {
    /** Per-attempt timeout (clamped to the remaining overall budget). */
    timeoutMs: number
    attempts?: number
    /**
     * Overall wall-clock budget across ALL attempts. Without it, two sequential
     * `timeoutMs` attempts could add 2×timeoutMs to run start — a regression of
     * the original single time-boxed extraction. With it, a slow first attempt
     * that eats the budget does NOT trigger a second one; a retry only fits when
     * the first attempt FAILS FAST (parse error / quick rejection), leaving time.
     */
    deadlineMs?: number
    onAttemptFail?: (err: unknown, attemptNo: number) => void
  },
): Promise<ProjectBrief | null> {
  const total = Math.max(1, opts.attempts ?? 2)
  const start = Date.now()
  for (let n = 1; n <= total; n++) {
    const remaining = opts.deadlineMs != null ? opts.deadlineMs - (Date.now() - start) : opts.timeoutMs
    if (remaining <= 0) return null // overall budget exhausted — don't start another attempt
    const attemptTimeout = Math.min(opts.timeoutMs, remaining)
    try {
      return await new Promise<ProjectBrief>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('brief extraction timed out')), attemptTimeout)
        attempt().then(
          (brief) => {
            clearTimeout(timer)
            resolve(brief)
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          },
        )
      })
    } catch (err) {
      opts.onAttemptFail?.(err, n)
      if (n >= total) return null
    }
  }
  return null
}
