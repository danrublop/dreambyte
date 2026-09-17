'use client'

/**
 * Model/provider brand glyphs.
 *
 * Preference order, so logos stay recognizable and colored:
 *   1. A bundled colored brand SVG under /assets/*-logo.svg (Claude, Kling) —
 *      rendered as <img> so the brand colors survive.
 *   2. @lobehub/icons' colored glyph (Google for Google + Gemini, DeepSeek, …).
 *   3. @lobehub/icons' mono glyph (inherits the chrome's currentColor).
 *   4. The Hugging Face mark for anything we have no symbol for.
 *
 * We import lobehub icons by deep path (es/<Name>/components/<variant>) rather
 * than the package barrel: the barrel attaches .Avatar/.Combine variants that
 * pull in @lobehub/ui + antd (React 19) — this app is React 18. The bare
 * src/components/{Mono,Color} files are pure SVG with no such deps.
 */
import ClaudeCodeColor from '@lobehub/icons/es/ClaudeCode/components/Color'
import GoogleColor from '@lobehub/icons/es/Google/components/Color'
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color'
import QwenColor from '@lobehub/icons/es/Qwen/components/Color'
import FalColor from '@lobehub/icons/es/Fal/components/Color'
import HuggingFace from '@lobehub/icons/es/HuggingFace/components/Color'
// Dedicated frontier-model brand glyphs (colored, pure SVG by deep path) so each Settings card shows
// its real logo instead of a generic FAL/Google fallback.
import ByteDanceColor from '@lobehub/icons/es/ByteDance/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import NanoBananaColor from '@lobehub/icons/es/NanoBanana/components/Color'
import HailuoColor from '@lobehub/icons/es/Hailuo/components/Color'
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color'
import DalleColor from '@lobehub/icons/es/Dalle/components/Color'
import KlingColor from '@lobehub/icons/es/Kling/components/Color'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import Moonshot from '@lobehub/icons/es/Moonshot/components/Mono'
import Ollama from '@lobehub/icons/es/Ollama/components/Mono'
import ElevenLabs from '@lobehub/icons/es/ElevenLabs/components/Mono'
import Runway from '@lobehub/icons/es/Runway/components/Mono'
import Flux from '@lobehub/icons/es/Flux/components/Mono'
import Ideogram from '@lobehub/icons/es/Ideogram/components/Mono'
import Recraft from '@lobehub/icons/es/Recraft/components/Mono'
import { forwardRef } from 'react'
// Type-only — erased at build, so it does NOT pull in @lobehub/ui + antd.
import type { IconType } from '@lobehub/icons'

/** OpenAI Codex CLI mark. Uses currentColor so it inherits the chrome ink.
 *  Typed as IconType (forwardRef) so it sits in the same brand maps as the
 *  lobehub glyphs. */
const Codex: IconType = forwardRef(({ size = 20 }, ref) => {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      style={{ flex: 'none', lineHeight: 1 }}
      aria-hidden="true"
    >
      <title>Codex</title>
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  )
})

// Colored brand assets we bundle. Anthropic uses the Claude mark per design.
const ASSET_BY_BRAND: Record<string, string> = {
  anthropic: '/assets/claude-logo.svg',
  claude: '/assets/claude-logo.svg',
  kling: '/assets/kling-logo.svg',
}

// White-only marks we recolor: the asset's alpha drives a CSS mask, filled with
// `color`. Theme-independent — the chosen color shows on light and dark alike.
const TINTED_MARK: Record<string, { src: string; color: string }> = {
  // Theme-aware: light blue on dark, a readable blue on light (see globals.css).
  heygen: { src: '/assets/heygen-symbol-white.svg', color: 'var(--heygen-mark)' },
}

// Brands whose mark looks best on a dark chip (light-colored marks).
const WHITE_MARK_BRANDS = new Set(['heygen'])

/** True when the brand glyph is white-only and needs a dark backing chip. */
export function brandNeedsDarkChip(brand: string): boolean {
  return WHITE_MARK_BRANDS.has(brand)
}

// Colored lobehub glyphs.
const COLOR_BY_BRAND: Record<string, IconType> = {
  'claude-code': ClaudeCodeColor,
  google: GoogleColor,
  gemini: GeminiColor, // dedicated Gemini mark (was Google)
  deepseek: DeepSeekColor,
  qwen: QwenColor,
  fal: FalColor,
  // Frontier media brands — real product/maker logos for the model cards.
  bytedance: ByteDanceColor, // Seedream + Seedance (ByteDance)
  nanobanana: NanoBananaColor, // Nano Banana (Gemini 2.5 Flash Image)
  hailuo: HailuoColor, // Hailuo 02 (MiniMax)
  minimax: MinimaxColor,
  dalle: DalleColor, // DALL·E
  kling: KlingColor, // colored lobehub Kling (asset still wins via ASSET_BY_BRAND if present)
}

// Mono lobehub glyphs (inherit currentColor) for the rest.
const MONO_BY_BRAND: Record<string, IconType> = {
  openai: OpenAI,
  'codex-cli': Codex,
  kimi: Moonshot,
  moonshot: Moonshot,
  local: Ollama,
  ollama: Ollama,
  elevenlabs: ElevenLabs,
  runway: Runway,
  flux: Flux,
  ideogram: Ideogram,
  recraft: Recraft,
}

/** Brand glyph for a model/provider, colored where we have the artwork. */
export default function ModelBrandIcon({ provider, size = 20 }: { provider: string; size?: number }) {
  const tint = TINTED_MARK[provider]
  if (tint) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          backgroundColor: tint.color,
          WebkitMaskImage: `url(${tint.src})`,
          maskImage: `url(${tint.src})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    )
  }
  const asset = ASSET_BY_BRAND[provider]
  if (asset) {
    return (
      <img
        src={asset}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain' }}
        draggable={false}
      />
    )
  }
  const Color = COLOR_BY_BRAND[provider]
  if (Color) return <Color size={size} />
  const Mono = MONO_BY_BRAND[provider]
  if (Mono) return <Mono size={size} />
  // No symbol for this provider — fall back to the Hugging Face mark.
  return <HuggingFace size={size} />
}
