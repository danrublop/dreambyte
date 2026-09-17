'use client'

import { STYLE_PRESETS, type StylePresetId } from '@/lib/styles/presets'

interface Props {
  currentPresetId: StylePresetId | null
  onChange: (id: StylePresetId | null) => void
}

export default function StylePresetPicker({ currentPresetId, onChange }: Props) {
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 6,
        }}
      >
        {/* None / Custom tile */}
        <span
          onClick={() => onChange(null)}
          title="No preset — agent has full style autonomy"
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: currentPresetId === null ? '2px solid var(--color-accent)' : '2px dashed var(--color-border)',
            background: 'var(--color-surface)',
            cursor: 'pointer',
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            transition: 'border-color 0.15s',
          }}
        >
          <div style={{ display: 'flex', gap: 2, marginBottom: 2 }}>
            {['#374151', '#6b7280', '#9ca3af', '#d1d5db'].map((color, i) => (
              <div
                key={i}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: color,
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              lineHeight: 1,
            }}
          >
            None / Custom
          </div>
          <div
            style={{
              fontSize: 9,
              color: 'var(--color-text-muted)',
              opacity: 0.6,
            }}
          >
            Full agent autonomy
          </div>
        </span>

        {Object.values(STYLE_PRESETS).map((preset) => (
          <span
            key={preset.id}
            onClick={() => onChange(preset.id)}
            title={preset.description}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              border: currentPresetId === preset.id ? '2px solid var(--color-accent)' : '2px solid var(--color-border)',
              background: preset.bgColor,
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              transition: 'border-color 0.15s',
            }}
          >
            {/* Mini palette strip */}
            <div style={{ display: 'flex', gap: 2, marginBottom: 2 }}>
              {preset.palette.map((color, i) => (
                <div
                  key={i}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: color,
                  }}
                />
              ))}
            </div>

            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: preset.strokeColorOverride ?? preset.palette[0],
                fontFamily:
                  preset.font === 'Caveat'
                    ? 'Caveat, cursive'
                    : preset.font === 'Space Mono'
                      ? 'Space Mono, monospace'
                      : preset.font === 'Nunito'
                        ? 'Nunito, sans-serif'
                        : 'Georgia, serif',
                lineHeight: 1,
              }}
            >
              {preset.name}
            </div>

            <div
              style={{
                fontSize: 9,
                color: preset.strokeColorOverride ?? preset.palette[0],
                opacity: 0.6,
              }}
            >
              {preset.description.split('.')[0]}
            </div>
          </span>
        ))}
      </div>

      {/* Show what the preset does */}
      <div
        style={{
          marginTop: 10,
          padding: '8px 10px',
          background: 'var(--color-surface)',
          borderRadius: 6,
          fontSize: 10,
          color: 'var(--color-text-muted)',
          lineHeight: 1.6,
        }}
      >
        {currentPresetId && STYLE_PRESETS[currentPresetId] ? (
          (() => {
            const p = STYLE_PRESETS[currentPresetId]
            return (
              <>
                <div>Renderer: {p.preferredRenderer}</div>
                <div>Roughness: {p.roughnessLevel} / 3</div>
                <div>Tool: {p.defaultTool}</div>
                <div>
                  Texture: {p.textureStyle}
                  {p.textureStyle !== 'none' ? ` (${Math.round(p.textureIntensity * 100)}%)` : ''}
                </div>
              </>
            )
          })()
        ) : (
          <div>No preset active. Agent has full style autonomy.</div>
        )}
      </div>
    </div>
  )
}
