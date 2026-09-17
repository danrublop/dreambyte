'use client'

import { useVideoStore } from '@/lib/store'
import { FONT_CATALOG, CATEGORY_LABELS, type FontCategory } from '@/lib/fonts/catalog'
import { SettingsSection, SettingRow, SettingsCard, Stepper } from './shared'

// Editor chrome follows docs/EDITOR-DESIGN.md: Inter, neutral-grey surfaces,
// Signal Blue reserved for the selected/active state. Rows are grouped into
// elevated cards (the macOS/Cursor settings idiom) via SettingsCard.

const FONT_CATEGORY_ORDER: FontCategory[] = ['sans-serif', 'serif', 'handwritten', 'monospace', 'display', 'system']

// uiTextSize is a 0–3 scale mapped to the --ui-zoom variable in Editor.tsx.
const TEXT_SIZE_PERCENT = ['90%', '100%', '110%', '120%']

const SELECT_CLS =
  'h-8 cursor-pointer rounded-[var(--radius-md)] border border-[var(--border-input)] bg-[var(--color-input-bg)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]'

export default function AppearanceSettingsTab() {
  const { globalStyle, updateGlobalStyle } = useVideoStore()

  // The .blue-theme is retired — coerce any legacy 'blue' to 'dark' for display.
  const theme = globalStyle.theme === 'light' ? 'light' : 'dark'
  const uiTextSize = globalStyle.uiTextSize ?? 1
  const uiFont = globalStyle.uiFontFamily ?? 'Inter'

  return (
    <div className="space-y-6">
      {/* Theme */}
      <SettingsCard>
        <SettingRow label="Theme" description="Choose between light and dark themes">
          <select
            value={theme}
            onChange={(e) => updateGlobalStyle({ theme: e.target.value as 'dark' | 'light' })}
            className={SELECT_CLS}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </SettingRow>
      </SettingsCard>

      {/* Typography */}
      <div>
        <SettingsSection>Typography</SettingsSection>
        <SettingsCard>
          <SettingRow label="UI font size" description="Scale all UI text across the editor">
            <Stepper
              value={uiTextSize}
              min={0}
              max={3}
              onChange={(v) => updateGlobalStyle({ uiTextSize: v })}
              format={(v) => TEXT_SIZE_PERCENT[v] ?? '100%'}
              ariaLabel="UI font size"
            />
          </SettingRow>

          <SettingRow label="UI font family" description="Defaults to Inter. Pick another to override.">
            <select
              value={uiFont}
              onChange={(e) => updateGlobalStyle({ uiTypography: 'custom', uiFontFamily: e.target.value })}
              className={`${SELECT_CLS} max-w-[220px]`}
              style={{ fontFamily: `'${uiFont}', sans-serif` }}
            >
              <option value="Inter">Inter (default)</option>
              {FONT_CATEGORY_ORDER.map((cat) => {
                const fonts = FONT_CATALOG.filter((f) => f.category === cat)
                if (fonts.length === 0) return null
                return (
                  <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
                    {fonts.map((f) => (
                      <option key={f.id} value={f.family}>
                        {f.family}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
          </SettingRow>
        </SettingsCard>
      </div>
    </div>
  )
}
