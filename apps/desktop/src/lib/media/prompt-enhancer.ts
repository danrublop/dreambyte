/**
 * Prompt enrichment for media generation.
 *
 * Why: raw user prompts like "fox on a hill" miss the quality/style cues that
 * separate amateur outputs from usable ones. Enrichment adds curated tags per
 * category so the agent (and the Generate panel) ship higher-quality prompts to
 * providers without the user having to be a prompt expert.
 *
 * Pattern adapted from open-gen-ai/src/lib/promptUtils.js (ENHANCE_TAGS), but
 * the tag registry is Dreambyte-specific.
 */

export type EnhanceCategory = 'quality' | 'lighting' | 'mood' | 'style' | 'medium' | 'camera'

export const ENHANCE_TAGS: Record<EnhanceCategory, string[]> = {
  quality: ['ultra detailed', '4k', 'sharp focus', 'masterpiece', 'crisp'],
  lighting: [
    'cinematic lighting',
    'soft natural light',
    'golden hour',
    'studio lighting',
    'rim light',
    'volumetric light',
  ],
  mood: ['vibrant', 'moody', 'dreamy', 'energetic', 'serene', 'dramatic'],
  style: ['photorealistic', 'illustration', 'flat design', 'oil painting', 'watercolor', 'cyberpunk', 'isometric'],
  medium: ['digital art', 'concept art', 'matte painting', 'pencil sketch', 'vector art'],
  camera: ['wide shot', 'close-up', 'overhead view', 'shallow depth of field', 'bokeh'],
}

/**
 * Enrich a prompt with selected tags.
 * Pure / deterministic so unit tests can snapshot it.
 */
export function enrichPrompt(
  rawPrompt: string,
  tags: string[] = [],
  model?: string,
): string {
  const base = rawPrompt.trim()
  const parts: string[] = [base]

  // Deduplicate tags while preserving order.
  const seen = new Set<string>()
  for (const t of tags) {
    const norm = t.trim().toLowerCase()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    parts.push(t.trim())
  }

  // Model-specific nudges — only when safe. Flux does well with explicit resolution cues.
  if (model === 'flux-1.1-pro' && !tags.some((t) => /4k|detailed|sharp/i.test(t))) {
    parts.push('ultra detailed, sharp focus')
  }

  return parts.join(', ')
}
