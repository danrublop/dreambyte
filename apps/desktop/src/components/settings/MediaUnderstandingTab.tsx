'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { SectionLabel, ListContainer, KeyInputRow } from './shared'

/**
 * Settings → Media Understanding (Phase 2 multimodal intake).
 *
 * Per-modality preference for which engine digests attached reference media.
 * This is a *preference*: the runner resolves the best available engine at run
 * time and falls back automatically when the chosen one isn't installed /
 * keyed, so picking "Local" with no Ollama model gracefully degrades to cloud.
 */

interface EngineOption {
  value: string
  label: string
}

const MODALITIES: { kind: string; label: string; hint: string; options: EngineOption[] }[] = [
  {
    kind: 'image',
    label: 'Images',
    hint: 'Caption, OCR and palette from reference images.',
    options: [
      { value: 'auto', label: 'Auto (best available)' },
      { value: 'local', label: 'Local — Ollama vision model' },
      { value: 'cloud:qwen', label: 'Cloud — Qwen-VL (cheaper)' },
      { value: 'cloud:kimi', label: 'Cloud — Kimi (cheaper)' },
      { value: 'cloud:gemini', label: 'Cloud — Gemini' },
      { value: 'cloud:anthropic', label: 'Cloud — Claude (Haiku)' },
    ],
  },
  {
    kind: 'audio',
    label: 'Audio',
    hint: 'Transcript plus sound/music understanding.',
    options: [
      { value: 'auto', label: 'Auto (best available)' },
      { value: 'local', label: 'Local — whisper.cpp' },
      { value: 'cloud:gemini', label: 'Cloud — Gemini (transcript + sound)' },
      { value: 'cloud:whisper', label: 'Cloud — Whisper API' },
    ],
  },
  {
    kind: 'video',
    label: 'Video',
    hint: 'Scene description and time-stamped events.',
    options: [
      { value: 'auto', label: 'Auto (best available)' },
      { value: 'local', label: 'Local — keyframes + Ollama vision' },
      { value: 'cloud:qwen', label: 'Cloud — keyframes + Qwen-VL (cheaper)' },
      { value: 'cloud:kimi', label: 'Cloud — keyframes + Kimi (cheaper)' },
      { value: 'cloud:gemini', label: 'Cloud — Gemini (native video)' },
      { value: 'cloud:anthropic', label: 'Cloud — keyframes + Claude' },
      { value: 'premium:marlin', label: 'Premium — Marlin-2B (needs NVIDIA GPU)' },
    ],
  },
  {
    kind: 'doc',
    label: 'Documents',
    hint: 'Text extraction from PDFs and notes.',
    options: [
      { value: 'auto', label: 'Auto (best available)' },
      { value: 'local', label: 'Local — pdf.js' },
    ],
  },
]

/** Cheap OpenAI-compat vision providers — keys map to provider-keys.ts env vars. */
// Vision-capable cheap providers only. DeepSeek's key lives in Models & APIs
// (it's a text/agent provider, no vision API).
const CHEAP_PROVIDER_KEYS = [
  { provider: 'dashscope', label: 'Qwen-VL (DashScope)', envVar: 'DASHSCOPE_API_KEY' },
  { provider: 'moonshot', label: 'Kimi (Moonshot)', envVar: 'MOONSHOT_API_KEY' },
]

export function MediaUnderstandingTab() {
  const { mediaUnderstandingEngines, setMediaUnderstandingEngine } = useVideoStore()
  const [keysOpen, setKeysOpen] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Reference media understanding</SectionLabel>
        <p className="text-[11px] px-1 mb-3" style={{ color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
          When you attach images, audio, video or documents to a prompt, the agent digests them into a brief before it
          builds. Pick which engine to use per type. <span className="font-semibold">Auto</span> uses the best available
          (local model if installed, else a cloud provider you have a key for) and always falls back gracefully.
        </p>
        <ListContainer>
          {MODALITIES.map((m) => (
            <div key={m.kind} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] font-medium text-[var(--color-text-primary)] leading-none">{m.label}</span>
                <span className="text-[11px] text-[var(--color-text-muted)] mt-1">{m.hint}</span>
              </div>
              <select
                value={mediaUnderstandingEngines[m.kind] ?? 'auto'}
                onChange={(e) => setMediaUnderstandingEngine(m.kind, e.target.value)}
                className="text-[12px] rounded-md px-2 py-1.5 border outline-none cursor-pointer"
                style={{
                  background: 'var(--color-bg)',
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-primary)',
                }}
              >
                {m.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </ListContainer>
      </div>

      {/* Cheap provider API keys — bare collapsible. */}
      <div>
        <div
          onClick={() => setKeysOpen((o) => !o)}
          className="flex items-center gap-2 py-2 text-[12px] font-medium text-[var(--color-text-primary)] cursor-pointer select-none"
        >
          <ChevronRight
            size={14}
            className={`text-[var(--color-text-muted)] transition-transform ${keysOpen ? 'rotate-90' : ''}`}
          />
          Cheaper provider API keys
        </div>
        {keysOpen && (
          <div className="pt-2 space-y-2">
            <p className="text-[11px] px-1 mb-1" style={{ color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
              Qwen-VL, Kimi, and DeepSeek are OpenAI-compatible vision models, typically ~10x cheaper than the frontier
              providers. Add a key to make them selectable above.
            </p>
            {CHEAP_PROVIDER_KEYS.map((k) => (
              <KeyInputRow key={k.provider} provider={k.provider} label={k.label} envVar={k.envVar} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
