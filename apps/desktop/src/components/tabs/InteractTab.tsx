'use client'

import { useVideoStore } from '@/lib/store'
import { v4 as uuidv4 } from 'uuid'
import { Trash2, Plus, X } from 'lucide-react'
import type {
  Scene,
  InteractionElement,
  InteractionStyle,
  InteractionStylePreset,
  HotspotElement,
  ChoiceElement,
  QuizElement,
  GateElement,
  TooltipElement,
  FormInputElement,
  ChoiceOption,
  QuizOption,
  FormField,
} from '@/lib/types'
import { STYLE_PRESETS, DEFAULT_INTERACTION_STYLE } from '@/lib/types'

const TYPE_COLORS: Record<string, string> = {
  hotspot: '#f59e0b',
  choice: '#3b82f6',
  quiz: '#8b5cf6',
  gate: '#10b981',
  tooltip: '#06b6d4',
  form: '#ec4899',
}

function createDefaultInteraction(type: InteractionElement['type']): InteractionElement {
  const base = {
    id: uuidv4(),
    x: 40,
    y: 40,
    width: 20,
    height: 10,
    appearsAt: 0,
    hidesAt: null as null,
    entranceAnimation: 'fade' as const,
  }

  switch (type) {
    case 'hotspot':
      return {
        ...base,
        type: 'hotspot',
        label: 'Click me',
        shape: 'circle',
        style: 'pulse',
        color: '#e84545',
        triggersEdgeId: null,
        jumpsToSceneId: null,
      } as HotspotElement
    case 'choice':
      return {
        ...base,
        type: 'choice',
        question: 'What would you like to do?',
        layout: 'horizontal',
        options: [
          { id: uuidv4(), label: 'Option A', icon: null, jumpsToSceneId: '', color: null },
          { id: uuidv4(), label: 'Option B', icon: null, jumpsToSceneId: '', color: null },
        ],
      } as ChoiceElement
    case 'quiz':
      const optA = uuidv4()
      const optB = uuidv4()
      return {
        ...base,
        type: 'quiz',
        question: 'Which answer is correct?',
        options: [
          { id: optA, label: 'Option A' },
          { id: optB, label: 'Option B' },
        ],
        correctOptionId: optA,
        onCorrect: 'continue',
        onCorrectSceneId: null,
        onWrong: 'retry',
        onWrongSceneId: null,
        explanation: null,
      } as QuizElement
    case 'gate':
      return {
        ...base,
        type: 'gate',
        buttonLabel: 'Continue →',
        buttonStyle: 'primary',
        minimumWatchTime: 0,
      } as GateElement
    case 'tooltip':
      return {
        ...base,
        width: 5,
        height: 5,
        type: 'tooltip',
        triggerShape: 'circle',
        triggerColor: '#3b82f6',
        triggerLabel: null,
        tooltipTitle: 'Tip',
        tooltipBody: 'Enter your tooltip text here.',
        tooltipPosition: 'top',
        tooltipMaxWidth: 240,
      } as TooltipElement
    case 'form':
      return {
        ...base,
        type: 'form',
        fields: [
          { id: uuidv4(), label: 'Your name', type: 'text', placeholder: 'Enter name...', options: [], required: true },
        ],
        submitLabel: 'Continue',
        setsVariables: [],
        jumpsToSceneId: null,
      } as FormInputElement
  }
  throw new Error(`Unknown interaction type: ${type as string}`)
}

// ── Shared layout rebuild (type switch) ───────────────────────────────────────

const INTERACTION_TYPE_OPTIONS: { type: InteractionElement['type']; label: string }[] = [
  { type: 'hotspot', label: 'Hotspot' },
  { type: 'choice', label: 'Choice' },
  { type: 'quiz', label: 'Quiz' },
  { type: 'gate', label: 'Gate' },
  { type: 'tooltip', label: 'Tooltip' },
  { type: 'form', label: 'Form' },
]

function rebuildInteractionPreservingLayout(
  el: InteractionElement,
  newType: InteractionElement['type'],
): InteractionElement {
  const fresh = createDefaultInteraction(newType)
  return {
    ...fresh,
    id: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    appearsAt: el.appearsAt,
    hidesAt: el.hidesAt,
    entranceAnimation: el.entranceAnimation,
    visualStyle: el.visualStyle,
  } as InteractionElement
}

// ── Layer stack: all user-visible copy in one place ───────────────────────────

export function InteractionTextBulkForm({ scene, el }: { scene: Scene; el: InteractionElement }) {
  const { updateInteraction } = useVideoStore()
  const update = (updates: Partial<InteractionElement>) => updateInteraction(scene.id, el.id, updates)
  const fieldClass =
    'w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'
  const labelClass = 'text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block'

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Text & labels</p>
      {el.type === 'hotspot' && (
        <div>
          <label className={labelClass}>Label</label>
          <input className={fieldClass} value={el.label} onChange={(e) => update({ label: e.target.value })} />
        </div>
      )}
      {el.type === 'choice' && (
        <>
          <div>
            <label className={labelClass}>Question</label>
            <input
              className={fieldClass}
              value={el.question ?? ''}
              placeholder="Question"
              onChange={(e) => update({ question: e.target.value || null })}
            />
          </div>
          <div>
            <label className={labelClass}>Options</label>
            <div className="space-y-1">
              {el.options.map((opt) => (
                <input
                  key={opt.id}
                  className={fieldClass}
                  value={opt.label}
                  placeholder="Option label"
                  onChange={(e) => {
                    const options = el.options.map((o) => (o.id === opt.id ? { ...o, label: e.target.value } : o))
                    update({ options })
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}
      {el.type === 'quiz' && (
        <>
          <div>
            <label className={labelClass}>Question</label>
            <textarea
              className={`${fieldClass} h-14 resize-none`}
              value={el.question}
              onChange={(e) => update({ question: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Answers</label>
            <div className="space-y-1">
              {el.options.map((opt) => (
                <input
                  key={opt.id}
                  className={fieldClass}
                  value={opt.label}
                  onChange={(e) => {
                    const options = el.options.map((o) => (o.id === opt.id ? { ...o, label: e.target.value } : o))
                    update({ options })
                  }}
                />
              ))}
            </div>
          </div>
          <div>
            <label className={labelClass}>Explanation (after answer)</label>
            <input
              className={fieldClass}
              value={el.explanation ?? ''}
              onChange={(e) => update({ explanation: e.target.value || null })}
            />
          </div>
        </>
      )}
      {el.type === 'gate' && (
        <div>
          <label className={labelClass}>Button label</label>
          <input
            className={fieldClass}
            value={el.buttonLabel}
            onChange={(e) => update({ buttonLabel: e.target.value })}
          />
        </div>
      )}
      {el.type === 'tooltip' && (
        <>
          <div>
            <label className={labelClass}>Trigger label (optional)</label>
            <input
              className={fieldClass}
              value={el.triggerLabel ?? ''}
              onChange={(e) => update({ triggerLabel: e.target.value || null })}
            />
          </div>
          <div>
            <label className={labelClass}>Title</label>
            <input
              className={fieldClass}
              value={el.tooltipTitle}
              onChange={(e) => update({ tooltipTitle: e.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>Body</label>
            <textarea
              className={`${fieldClass} h-16 resize-none`}
              value={el.tooltipBody}
              onChange={(e) => update({ tooltipBody: e.target.value })}
            />
          </div>
        </>
      )}
      {el.type === 'form' && (
        <>
          <div>
            <label className={labelClass}>Submit button</label>
            <input
              className={fieldClass}
              value={el.submitLabel}
              onChange={(e) => update({ submitLabel: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <label className={labelClass}>Fields</label>
            {el.fields.map((field) => (
              <div key={field.id} className="rounded border border-[var(--color-border)] p-2 space-y-1">
                <input
                  className={fieldClass}
                  value={field.label}
                  placeholder="Field label"
                  onChange={(e) => {
                    const fields = el.fields.map((f) => (f.id === field.id ? { ...f, label: e.target.value } : f))
                    update({ fields })
                  }}
                />
                {field.type === 'text' && (
                  <input
                    className={fieldClass}
                    value={field.placeholder ?? ''}
                    placeholder="Placeholder"
                    onChange={(e) => {
                      const fields = el.fields.map((f) =>
                        f.id === field.id ? { ...f, placeholder: e.target.value || null } : f,
                      )
                      update({ fields })
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Full form (properties panel + Interact tab) ───────────────────────────────

export function InteractionFormBody({
  scene,
  el,
  showTypeSwitcher,
}: {
  scene: Scene
  el: InteractionElement
  showTypeSwitcher?: boolean
}) {
  const { updateInteraction, replaceInteraction } = useVideoStore()
  const update = (updates: Partial<InteractionElement>) => updateInteraction(scene.id, el.id, updates)

  const fieldClass =
    'w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'
  const labelClass = 'text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block'

  return (
    <div className="space-y-3">
      {showTypeSwitcher && (
        <div>
          <label className={labelClass}>Interaction type</label>
          <select
            className={fieldClass}
            value={el.type}
            onChange={(e) => {
              const t = e.target.value as InteractionElement['type']
              if (t === el.type) return
              replaceInteraction(scene.id, el.id, rebuildInteractionPreservingLayout(el, t))
            }}
          >
            {INTERACTION_TYPE_OPTIONS.map((o) => (
              <option key={o.type} value={o.type}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <InteractionTextBulkForm scene={scene} el={el} />

      {/* Common base fields */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>X (%)</label>
          <input
            type="number"
            className={fieldClass}
            value={Math.round(el.x)}
            min={0}
            max={100}
            onChange={(e) => update({ x: Number(e.target.value) } as any)}
          />
        </div>
        <div>
          <label className={labelClass}>Y (%)</label>
          <input
            type="number"
            className={fieldClass}
            value={Math.round(el.y)}
            min={0}
            max={100}
            onChange={(e) => update({ y: Number(e.target.value) } as any)}
          />
        </div>
        <div>
          <label className={labelClass}>Width (%)</label>
          <input
            type="number"
            className={fieldClass}
            value={Math.round(el.width)}
            min={1}
            max={100}
            onChange={(e) => update({ width: Number(e.target.value) } as any)}
          />
        </div>
        <div>
          <label className={labelClass}>Height (%)</label>
          <input
            type="number"
            className={fieldClass}
            value={Math.round(el.height)}
            min={1}
            max={100}
            onChange={(e) => update({ height: Number(e.target.value) } as any)}
          />
        </div>
        <div>
          <label className={labelClass}>Appears at (s)</label>
          <input
            type="number"
            className={fieldClass}
            value={el.appearsAt}
            min={0}
            step={0.5}
            onChange={(e) => update({ appearsAt: Number(e.target.value) } as any)}
          />
        </div>
        <div>
          <label className={labelClass}>Hides at (s)</label>
          <input
            type="number"
            className={fieldClass}
            value={el.hidesAt ?? ''}
            placeholder="never"
            min={0}
            step={0.5}
            onChange={(e) => update({ hidesAt: e.target.value ? Number(e.target.value) : null } as any)}
          />
        </div>
      </div>

      {/* Timing visual bar */}
      <div>
        <label className={labelClass}>Timing</label>
        <div className="relative h-3 bg-[var(--color-bg)] rounded border border-[var(--color-border)] overflow-hidden">
          {(() => {
            const dur = scene.duration || 10
            const start = (el.appearsAt / dur) * 100
            const end = el.hidesAt !== null ? (el.hidesAt / dur) * 100 : 100
            const width = Math.max(0, end - start)
            return (
              <div
                style={{
                  position: 'absolute',
                  left: `${start}%`,
                  width: `${width}%`,
                  top: 0,
                  bottom: 0,
                  background: TYPE_COLORS[el.type] ?? '#e84545',
                  opacity: 0.6,
                  borderRadius: 2,
                }}
              />
            )
          })()}
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="text-[10px] text-[var(--color-text-muted)]">0s</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">{scene.duration}s</span>
        </div>
      </div>

      <div>
        <label className={labelClass}>Entrance animation</label>
        <select
          className={fieldClass}
          value={el.entranceAnimation}
          onChange={(e) => update({ entranceAnimation: e.target.value as any })}
        >
          <option value="fade">Fade</option>
          <option value="slide-up">Slide up</option>
          <option value="pop">Pop</option>
          <option value="none">None</option>
        </select>
      </div>

      {/* Type-specific fields */}
      {el.type === 'hotspot' && (
        <HotspotFields el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
      )}
      {el.type === 'choice' && (
        <ChoiceFields scene={scene} el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
      )}
      {el.type === 'quiz' && (
        <QuizFields scene={scene} el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
      )}
      {el.type === 'gate' && <GateFields el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />}
      {el.type === 'tooltip' && (
        <TooltipFields el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
      )}
      {el.type === 'form' && (
        <FormFields scene={scene} el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
      )}

      {/* Visual style */}
      <InteractionStyleEditor el={el} update={update} fieldClass={fieldClass} labelClass={labelClass} />
    </div>
  )
}

const PRESET_LABELS: Record<InteractionStylePreset, string> = {
  glass: 'Glass',
  'glass-warm': 'Warm Glass',
  'glass-cool': 'Cool Glass',
  'glass-dark': 'Dark Glass',
  professional: 'Professional',
  solid: 'Solid',
  'solid-light': 'Light',
  'solid-dark': 'Dark',
  minimal: 'Minimal',
  outline: 'Outline',
  gradient: 'Gradient',
  neon: 'Neon',
  custom: 'Custom',
}

const PRESET_COLORS: Record<InteractionStylePreset, string> = {
  glass: '#ffffff',
  'glass-warm': '#f59e0b',
  'glass-cool': '#3b82f6',
  'glass-dark': '#374151',
  professional: '#2563eb',
  solid: '#1a1a2e',
  'solid-light': '#f5f5f5',
  'solid-dark': '#0f0f14',
  minimal: '#888888',
  outline: '#aaaaaa',
  gradient: '#6366f1',
  neon: '#e84545',
  custom: '#666666',
}

function InteractionStyleEditor({
  el,
  update,
  fieldClass,
  labelClass,
}: {
  el: InteractionElement
  update: (u: Partial<InteractionElement>) => void
  fieldClass: string
  labelClass: string
}) {
  const s: InteractionStyle = { ...DEFAULT_INTERACTION_STYLE, ...el.visualStyle }
  const set = (key: keyof InteractionStyle, value: any) => {
    update({ visualStyle: { ...el.visualStyle, [key]: value, preset: 'custom' } } as any)
  }
  const applyPreset = (preset: InteractionStylePreset) => {
    update({ visualStyle: { ...STYLE_PRESETS[preset] } } as any)
  }
  const colorInput = 'w-full h-6 rounded border border-[var(--color-border)] bg-transparent cursor-pointer'
  const rangeInput = 'w-full h-1.5 accent-[var(--color-accent)]'

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <details className="border-t border-[var(--color-border)] pt-1.5 mt-1.5">
      <summary className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider cursor-pointer select-none list-none flex items-center gap-1 [&::-webkit-details-marker]:hidden">
        <svg
          width="7"
          height="7"
          viewBox="0 0 8 8"
          fill="currentColor"
          className="transition-transform [details[open]>&]:rotate-90"
        >
          <path d="M2 1l4 3-4 3z" />
        </svg>
        {title}
      </summary>
      <div className="mt-1.5 space-y-1.5">{children}</div>
    </details>
  )

  return (
    <div className="border-t border-[var(--color-border)] pt-2 mt-2 space-y-2">
      <label className={labelClass}>Style Preset</label>
      <div className="grid grid-cols-4 gap-1">
        {(Object.keys(STYLE_PRESETS) as InteractionStylePreset[]).map((preset) => (
          <span
            key={preset}
            onClick={() => applyPreset(preset)}
            className={`text-[10px] text-center py-1 px-0.5 rounded cursor-pointer transition-all border ${s.preset === preset ? 'border-[var(--color-accent)] text-[var(--color-text-primary)] bg-[var(--color-accent)]/10' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]'}`}
          >
            <div
              className="w-3 h-3 rounded-sm mx-auto mb-0.5"
              style={{ background: PRESET_COLORS[preset], border: '1px solid rgba(255,255,255,0.1)' }}
            />
            {PRESET_LABELS[preset]}
          </span>
        ))}
      </div>

      <Section title="Background">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Color</label>
            <input
              type="color"
              className={colorInput}
              value={s.bgColor}
              onChange={(e) => set('bgColor', e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Opacity</label>
            <input
              type="range"
              className={rangeInput}
              min={0}
              max={1}
              step={0.05}
              value={s.bgOpacity}
              onChange={(e) => set('bgOpacity', Number(e.target.value))}
            />
            <span className="text-[10px] text-[var(--color-text-muted)]">{s.bgOpacity.toFixed(2)}</span>
          </div>
        </div>
        <div>
          <label className={labelClass}>Blur (px)</label>
          <input
            type="number"
            className={fieldClass}
            min={0}
            max={60}
            value={s.blur}
            onChange={(e) => set('blur', Number(e.target.value))}
          />
        </div>
      </Section>

      <Section title="Border">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Color</label>
            <input
              type="color"
              className={colorInput}
              value={s.borderColor}
              onChange={(e) => set('borderColor', e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Opacity</label>
            <input
              type="range"
              className={rangeInput}
              min={0}
              max={1}
              step={0.05}
              value={s.borderOpacity}
              onChange={(e) => set('borderOpacity', Number(e.target.value))}
            />
            <span className="text-[10px] text-[var(--color-text-muted)]">{s.borderOpacity.toFixed(2)}</span>
          </div>
          <div>
            <label className={labelClass}>Width (px)</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={6}
              value={s.borderWidth}
              onChange={(e) => set('borderWidth', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Radius (px)</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={50}
              value={s.borderRadius}
              onChange={(e) => set('borderRadius', Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section title="Shadow & Glow">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Shadow color</label>
            <input
              type="color"
              className={colorInput}
              value={s.shadowColor}
              onChange={(e) => set('shadowColor', e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Opacity</label>
            <input
              type="range"
              className={rangeInput}
              min={0}
              max={1}
              step={0.05}
              value={s.shadowOpacity}
              onChange={(e) => set('shadowOpacity', Number(e.target.value))}
            />
            <span className="text-[10px] text-[var(--color-text-muted)]">{s.shadowOpacity.toFixed(2)}</span>
          </div>
          <div>
            <label className={labelClass}>Spread (px)</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={64}
              value={s.shadowSpread}
              onChange={(e) => set('shadowSpread', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Inner glow</label>
            <input
              type="range"
              className={rangeInput}
              min={0}
              max={1}
              step={0.05}
              value={s.innerGlow}
              onChange={(e) => set('innerGlow', Number(e.target.value))}
            />
            <span className="text-[10px] text-[var(--color-text-muted)]">{s.innerGlow.toFixed(2)}</span>
          </div>
        </div>
      </Section>

      <Section title="Typography">
        <div>
          <label className={labelClass}>Font</label>
          <select className={fieldClass} value={s.fontFamily} onChange={(e) => set('fontFamily', e.target.value)}>
            <option value="system-ui, -apple-system, sans-serif">System UI</option>
            <option value="'Figtree', sans-serif">Figtree</option>
            <option value="'Sora', sans-serif">Sora</option>
            <option value="'JetBrains Mono', monospace">JetBrains Mono</option>
            <option value="monospace">Monospace</option>
            <option value="Georgia, serif">Georgia</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={labelClass}>Size</label>
            <input
              type="number"
              className={fieldClass}
              min={10}
              max={32}
              value={s.fontSize}
              onChange={(e) => set('fontSize', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Weight</label>
            <select
              className={fieldClass}
              value={s.fontWeight}
              onChange={(e) => set('fontWeight', Number(e.target.value))}
            >
              <option value={400}>Regular</option>
              <option value={500}>Medium</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
              <option value={800}>Extra Bold</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Align</label>
            <select className={fieldClass} value={s.textAlign} onChange={(e) => set('textAlign', e.target.value)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Text color</label>
            <input
              type="color"
              className={colorInput}
              value={s.textColor}
              onChange={(e) => set('textColor', e.target.value)}
            />
          </div>
          <div>
            <label className={labelClass}>Spacing (em)</label>
            <input
              type="number"
              className={fieldClass}
              min={-0.1}
              max={0.3}
              step={0.01}
              value={s.letterSpacing}
              onChange={(e) => set('letterSpacing', Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section title="Spacing">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={labelClass}>Pad X</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={60}
              value={s.paddingX}
              onChange={(e) => set('paddingX', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Pad Y</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={60}
              value={s.paddingY}
              onChange={(e) => set('paddingY', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Gap</label>
            <input
              type="number"
              className={fieldClass}
              min={0}
              max={30}
              value={s.gap}
              onChange={(e) => set('gap', Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section title="Effects">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Hover scale</label>
            <input
              type="number"
              className={fieldClass}
              min={1}
              max={1.2}
              step={0.01}
              value={s.hoverScale}
              onChange={(e) => set('hoverScale', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={labelClass}>Speed (ms)</label>
            <input
              type="number"
              className={fieldClass}
              min={50}
              max={600}
              step={50}
              value={s.transitionSpeed}
              onChange={(e) => set('transitionSpeed', Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section title="Accent">
        <div>
          <label className={labelClass}>Accent color</label>
          <input
            type="color"
            className={colorInput}
            value={s.accentColor}
            onChange={(e) => set('accentColor', e.target.value)}
          />
        </div>
      </Section>
    </div>
  )
}

function SceneSelector({
  value,
  onChange,
  fieldClass,
  labelClass,
  label = 'Jump to scene',
}: {
  value: string | null
  onChange: (sceneId: string | null) => void
  fieldClass: string
  labelClass: string
  label?: string
}) {
  const { scenes } = useVideoStore()
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <select className={fieldClass} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">None</option>
        {scenes.map((s, i) => (
          <option key={s.id} value={s.id}>
            {s.name || `Scene ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  )
}

function HotspotFields({ el, update, fieldClass, labelClass }: any) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Shape</label>
          <select className={fieldClass} value={el.shape} onChange={(e) => update({ shape: e.target.value })}>
            <option value="circle">Circle</option>
            <option value="rectangle">Rectangle</option>
            <option value="pill">Pill</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Style</label>
          <select className={fieldClass} value={el.style} onChange={(e) => update({ style: e.target.value })}>
            <option value="pulse">Pulse</option>
            <option value="glow">Glow</option>
            <option value="border">Border</option>
            <option value="filled">Filled</option>
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass}>Color</label>
        <input
          type="color"
          className="w-full h-7 rounded border border-[var(--color-border)] bg-transparent cursor-pointer"
          value={el.color}
          onChange={(e) => update({ color: e.target.value })}
        />
      </div>
      <SceneSelector
        value={el.jumpsToSceneId}
        onChange={(sceneId) => update({ jumpsToSceneId: sceneId })}
        fieldClass={fieldClass}
        labelClass={labelClass}
      />
    </>
  )
}

function ChoiceFields({ scene, el, update, fieldClass, labelClass }: any) {
  const { scenes } = useVideoStore()
  return (
    <>
      <div>
        <label className={labelClass}>Layout</label>
        <select className={fieldClass} value={el.layout} onChange={(e) => update({ layout: e.target.value })}>
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
          <option value="grid">Grid</option>
        </select>
      </div>
      <div>
        <label className={labelClass}>Branches (edit labels under Text)</label>
        <div className="space-y-2">
          {(el.options as ChoiceOption[]).map((opt) => (
            <div key={opt.id} className="border border-[var(--color-border)] rounded p-2 space-y-1">
              <div className="flex gap-1 items-center">
                <p className="text-[11px] text-[var(--color-text-primary)] truncate font-medium flex-1 min-w-0">
                  {opt.label || '(empty)'}
                </p>
                <button
                  type="button"
                  className="kbd w-6 h-6 p-0 flex items-center justify-center shrink-0"
                  onClick={() => update({ options: el.options.filter((o: ChoiceOption) => o.id !== opt.id) })}
                >
                  <Trash2 size={10} />
                </button>
              </div>
              <div>
                <label className={labelClass}>Jump to scene</label>
                <select
                  className={fieldClass}
                  value={opt.jumpsToSceneId ?? ''}
                  onChange={(e) => {
                    const options = el.options.map((o: ChoiceOption) =>
                      o.id === opt.id ? { ...o, jumpsToSceneId: e.target.value || '' } : o,
                    )
                    update({ options })
                  }}
                >
                  <option value="">None (continue)</option>
                  {scenes.map((s, si) => (
                    <option key={s.id} value={s.id}>
                      {s.name || `Scene ${si + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          <button
            className="kbd w-full h-6 text-[11px] flex items-center justify-center gap-1"
            onClick={() =>
              update({
                options: [
                  ...el.options,
                  { id: uuidv4(), label: 'New option', icon: null, jumpsToSceneId: '', color: null },
                ],
              })
            }
          >
            <Plus size={10} /> Add option
          </button>
        </div>
      </div>
    </>
  )
}

function QuizFields({ scene, el, update, fieldClass, labelClass }: any) {
  return (
    <>
      <div>
        <label className={labelClass}>Correct answer & options (edit wording under Text)</label>
        <div className="space-y-1.5">
          {(el.options as QuizOption[]).map((opt) => (
            <div key={opt.id} className="flex gap-1 items-center">
              <input
                type="radio"
                name={`quiz-correct-${el.id}`}
                checked={el.correctOptionId === opt.id}
                onChange={() => update({ correctOptionId: opt.id })}
                className="shrink-0 accent-green-500"
              />
              <span className={`${fieldClass} flex-1 flex items-center min-h-[28px] opacity-90`}>
                {opt.label || '(empty)'}
              </span>
              <button
                className="kbd w-6 h-6 p-0 flex items-center justify-center shrink-0"
                onClick={() => update({ options: el.options.filter((o: QuizOption) => o.id !== opt.id) })}
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
          <button
            className="kbd w-full h-6 text-[11px] flex items-center justify-center gap-1"
            onClick={() => update({ options: [...el.options, { id: uuidv4(), label: 'New option' }] })}
          >
            <Plus size={10} /> Add option
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>On correct</label>
          <select className={fieldClass} value={el.onCorrect} onChange={(e) => update({ onCorrect: e.target.value })}>
            <option value="continue">Continue</option>
            <option value="jump">Jump to scene</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>On wrong</label>
          <select className={fieldClass} value={el.onWrong} onChange={(e) => update({ onWrong: e.target.value })}>
            <option value="retry">Retry</option>
            <option value="continue">Continue</option>
            <option value="jump">Jump to scene</option>
          </select>
        </div>
      </div>
      {el.onCorrect === 'jump' && (
        <SceneSelector
          value={el.onCorrectSceneId}
          onChange={(sceneId) => update({ onCorrectSceneId: sceneId })}
          fieldClass={fieldClass}
          labelClass={labelClass}
          label="On correct → scene"
        />
      )}
      {el.onWrong === 'jump' && (
        <SceneSelector
          value={el.onWrongSceneId}
          onChange={(sceneId) => update({ onWrongSceneId: sceneId })}
          fieldClass={fieldClass}
          labelClass={labelClass}
          label="On wrong → scene"
        />
      )}
    </>
  )
}

function GateFields({ el, update, fieldClass, labelClass }: any) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Button style</label>
          <select
            className={fieldClass}
            value={el.buttonStyle}
            onChange={(e) => update({ buttonStyle: e.target.value })}
          >
            <option value="primary">Primary</option>
            <option value="outline">Outline</option>
            <option value="minimal">Minimal</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Min. watch time (s)</label>
          <input
            type="number"
            className={fieldClass}
            value={el.minimumWatchTime}
            min={0}
            onChange={(e) => update({ minimumWatchTime: Number(e.target.value) })}
          />
        </div>
      </div>
    </>
  )
}

function TooltipFields({ el, update, fieldClass, labelClass }: any) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Trigger shape</label>
          <select
            className={fieldClass}
            value={el.triggerShape}
            onChange={(e) => update({ triggerShape: e.target.value as TooltipElement['triggerShape'] })}
          >
            <option value="circle">Circle (default)</option>
            <option value="pill">Pill</option>
            <option value="rounded">Rounded</option>
            <option value="square">Square</option>
            <option value="rectangle">Rectangle</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Trigger color</label>
          <input
            type="color"
            className="w-full h-7 rounded border border-[var(--color-border)] bg-transparent cursor-pointer"
            value={el.triggerColor}
            onChange={(e) => update({ triggerColor: e.target.value })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Position</label>
          <select
            className={fieldClass}
            value={el.tooltipPosition}
            onChange={(e) => update({ tooltipPosition: e.target.value })}
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Max width (px)</label>
          <input
            type="number"
            className={fieldClass}
            value={el.tooltipMaxWidth}
            onChange={(e) => update({ tooltipMaxWidth: Number(e.target.value) })}
          />
        </div>
      </div>
    </>
  )
}

function FormFields({ scene, el, update, fieldClass, labelClass }: any) {
  const currentMappings: Record<string, string> = {}
  for (const m of el.setsVariables ?? []) {
    currentMappings[m.fieldId] = m.variableName
  }

  const updateVariableMapping = (fieldId: string, variableName: string) => {
    const updated = { ...currentMappings, [fieldId]: variableName }
    const setsVariables = Object.entries(updated)
      .filter(([, v]) => v.trim())
      .map(([fId, vName]) => ({ fieldId: fId, variableName: vName.trim() }))
    update({ setsVariables })
  }

  return (
    <>
      <div>
        <label className={labelClass}>Fields (labels in layer stack → Text)</label>
        <div className="space-y-2">
          {(el.fields as FormField[]).map((field, i) => (
            <div key={field.id} className="border border-[var(--color-border)] rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-[var(--color-text-muted)] truncate max-w-[140px]">
                  {field.label || `Field ${i + 1}`}
                </span>
                <button
                  className="kbd w-5 h-5 p-0 flex items-center justify-center"
                  onClick={() => update({ fields: el.fields.filter((f: FormField) => f.id !== field.id) })}
                >
                  <X size={9} />
                </button>
              </div>
              <select
                className={fieldClass}
                value={field.type}
                onChange={(e) => {
                  const fields = el.fields.map((f: FormField) =>
                    f.id === field.id ? { ...f, type: e.target.value } : f,
                  )
                  update({ fields })
                }}
              >
                <option value="text">Text input</option>
                <option value="select">Dropdown</option>
                <option value="radio">Radio</option>
              </select>
            </div>
          ))}
          <button
            className="kbd w-full h-6 text-[11px] flex items-center justify-center gap-1"
            onClick={() =>
              update({
                fields: [
                  ...el.fields,
                  { id: uuidv4(), label: 'New field', type: 'text', placeholder: null, options: [], required: false },
                ],
              })
            }
          >
            <Plus size={10} /> Add field
          </button>
        </div>
      </div>

      {/* Variable mapping */}
      {(el.fields as FormField[]).length > 0 && (
        <div>
          <label className={labelClass}>Variable Mapping</label>
          <p className="text-[11px] text-[var(--color-text-muted)] mb-1.5">
            Map fields to variables for use in later scenes via {'{'}
            <span>varName</span>
            {'}'}
          </p>
          <div className="space-y-1.5">
            {(el.fields as FormField[]).map((field) => (
              <div key={field.id} className="flex gap-1.5 items-center">
                <span className="text-[11px] text-[var(--color-text-muted)] shrink-0 w-20 truncate">{field.label}</span>
                <span className="text-[11px] text-[var(--color-text-muted)]">→</span>
                <input
                  className={`${fieldClass} flex-1`}
                  value={currentMappings[field.id] ?? ''}
                  placeholder="variableName"
                  onChange={(e) => updateVariableMapping(field.id, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <SceneSelector
        value={el.jumpsToSceneId}
        onChange={(sceneId) => update({ jumpsToSceneId: sceneId })}
        fieldClass={fieldClass}
        labelClass={labelClass}
        label="After submit → scene"
      />
    </>
  )
}
