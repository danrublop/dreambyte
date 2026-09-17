'use client'

import { useCallback, useRef, useState } from 'react'
import { Mic, RefreshCw, Trash2, Upload, Volume2 } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'
import { normalizeAudioLayer } from '@/lib/audio/normalize'
import { SfxLibraryPanel } from '@/components/audio/SfxLibraryPanel'
import { uploadBlob } from '@/lib/upload'
import { SettingsButton } from '@/components/settings/GeneralSettingsTab'

async function uploadFile(file: File): Promise<string> {
  return uploadBlob(file, file.name)
}

// ── Design primitives (Cursor dark theme) ─────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: '11px',
        fontWeight: 500,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.048px',
        textTransform: 'uppercase',
        margin: '20px 0 4px',
      }}
    >
      {children}
    </p>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{label}</p>
        {description && (
          <p
            style={{
              fontSize: '11px',
              fontWeight: 500,
              color: 'var(--color-text-muted)',
              margin: '2px 0 0',
              lineHeight: 1.3,
              letterSpacing: '0.048px',
            }}
          >
            {description}
          </p>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

// ── Shared range slider row ────────────────────────────────────────────────

function VolumeRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <SettingRow label={label} description={`${Math.round(value * 100)}%`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ width: '96px', accentColor: 'var(--color-accent)' }}
        />
        <span
          style={{
            fontSize: '12px',
            fontFamily: 'monospace',
            color: 'var(--color-text-muted)',
            width: '36px',
            textAlign: 'right',
          }}
        >
          {Math.round(value * 100)}%
        </span>
      </div>
    </SettingRow>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// AudioTabPanel — master audio controls
// ──────────────────────────────────────────────────────────────────────────

type Props = { scene: Scene }

export default function AudioTabPanel({ scene }: Props) {
  const { updateScene, saveSceneHTML } = useVideoStore()

  // Inline error instead of a blocking alert() — matches the
  // banner pattern in GalleryPanel/LayersMediaTab.
  const [error, setError] = useState<string | null>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const raw = normalizeAudioLayer(scene.audioLayer)

  const commitLayer = useCallback(async () => {
    await saveSceneHTML(scene.id)
  }, [scene.id, saveSceneHTML])

  const commitLayerDebounced = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void saveSceneHTML(scene.id), 150)
  }, [scene.id, saveSceneHTML])

  const handleAudioUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      setError(null)
      try {
        const url = await uploadFile(file)
        updateScene(scene.id, { audioLayer: { ...scene.audioLayer, src: url, enabled: true } })
        await saveSceneHTML(scene.id)
      } catch (e: any) {
        setError(e?.message ?? 'Audio upload failed')
      }
      e.target.value = ''
    },
    [scene.audioLayer, scene.id, updateScene, saveSceneHTML],
  )

  const patchAudioLayer = useCallback(
    (partial: Partial<typeof scene.audioLayer>) => {
      updateScene(scene.id, { audioLayer: { ...scene.audioLayer, ...partial } })
    },
    [scene.audioLayer, scene.id, updateScene],
  )

  return (
    <div style={{ padding: '0 12px 24px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {error && (
        <div
          role="alert"
          style={{
            margin: '8px 0',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
            background: 'rgba(224,82,82,0.12)',
            color: '#e05252',
            border: '1px solid rgba(224,82,82,0.3)',
          }}
        >
          {error}
        </div>
      )}
      {/* ── Master ── */}
      <SectionHeader>Master</SectionHeader>

      <SettingRow label="Audio enabled">
        <SettingsButton
          variant={raw.enabled ? 'active' : 'default'}
          onClick={() => {
            patchAudioLayer({ enabled: !raw.enabled })
            void commitLayer()
          }}
        >
          {raw.enabled ? 'On' : 'Off'}
        </SettingsButton>
      </SettingRow>

      <VolumeRow
        label="Output volume"
        value={raw.volume}
        onChange={(v) => {
          patchAudioLayer({ volume: v })
          commitLayerDebounced()
        }}
      />

      <SettingRow label="Start offset" description="seconds">
        <input
          type="number"
          min={0}
          step={0.1}
          value={raw.startOffset ?? 0}
          onChange={(e) => {
            patchAudioLayer({ startOffset: parseFloat(e.target.value) || 0 })
            commitLayerDebounced()
          }}
          style={{
            padding: '4px 8px',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            background: 'var(--color-input-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            outline: 'none',
            width: '72px',
          }}
        />
      </SettingRow>

      <SettingRow label="Fade in">
        <SettingsButton
          variant={raw.fadeIn ? 'active' : 'default'}
          onClick={() => {
            patchAudioLayer({ fadeIn: !raw.fadeIn })
            void commitLayer()
          }}
        >
          {raw.fadeIn ? 'On' : 'Off'}
        </SettingsButton>
      </SettingRow>

      <SettingRow label="Fade out">
        <SettingsButton
          variant={raw.fadeOut ? 'active' : 'default'}
          onClick={() => {
            patchAudioLayer({ fadeOut: !raw.fadeOut })
            void commitLayer()
          }}
        >
          {raw.fadeOut ? 'On' : 'Off'}
        </SettingsButton>
      </SettingRow>

      {/* ── File ── */}
      <SectionHeader>File</SectionHeader>

      {raw.src ? (
        <SettingRow label="Audio file" description={raw.src.split('/').pop() ?? 'Uploaded file'}>
          <SettingsButton
            variant="danger"
            onClick={() => {
              patchAudioLayer({ src: null })
              void commitLayer()
            }}
          >
            Remove
          </SettingsButton>
        </SettingRow>
      ) : (
        <div style={{ paddingTop: '8px' }}>
          <SettingsButton onClick={() => audioInputRef.current?.click()}>
            <Upload size={12} style={{ marginRight: '4px' }} />
            Upload audio
          </SettingsButton>
        </div>
      )}

      <input
        ref={audioInputRef}
        type="file"
        accept="audio/mp3,audio/wav,audio/mpeg"
        onChange={handleAudioUpload}
        style={{ display: 'none' }}
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// SfxTabPanel — music + sound effects
// ──────────────────────────────────────────────────────────────────────────

export function SfxTabPanel({ scene }: Props) {
  const addSFXToScene = useVideoStore((s) => s.addSFXToScene)
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <SfxLibraryPanel
        onSelect={(r, at) => {
          addSFXToScene(scene.id, {
            id: r.id,
            name: r.name,
            provider: (r.provider ?? 'freesound') as never,
            src: r.previewUrl ?? r.audioUrl ?? '',
            triggerAt: at,
            volume: 1,
            duration: r.duration ?? null,
            license: r.license ?? null,
          })
        }}
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// NarrationPanel — rendered inside the Avatar tab
// ──────────────────────────────────────────────────────────────────────────

export function NarrationPanel({ scene }: Props) {
  const { updateScene, saveSceneHTML, generateNarration } = useVideoStore()

  const [generatingTTS, setGeneratingTTS] = useState(false)
  // Inline error instead of blocking alert().
  const [error, setError] = useState<string | null>(null)
  const audio = normalizeAudioLayer(scene.audioLayer)

  const clearNarrationAndFile = useCallback(() => {
    const al = normalizeAudioLayer(scene.audioLayer)
    updateScene(scene.id, { audioLayer: { ...al, src: null, tts: null } })
    void saveSceneHTML(scene.id)
  }, [scene.audioLayer, scene.id, updateScene, saveSceneHTML])

  const handleGenerateVoiceover = useCallback(async () => {
    const text = scene.prompt
    if (!text) {
      setError('Add a scene prompt first to generate narration.')
      return
    }
    setError(null)
    try {
      const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.tts : undefined
      if (!ipc) throw new Error('TTS requires the desktop runtime (window.dreambyteApi.tts unavailable).')
      const data = await ipc.synthesize({ text, sceneId: scene.id })
      const url = data.url as string | undefined
      if (!url) return
      updateScene(scene.id, { audioLayer: { ...scene.audioLayer, src: url, enabled: true } })
      await saveSceneHTML(scene.id)
    } catch (e: any) {
      setError(e?.message ?? 'TTS generation failed. Check your ElevenLabs API key.')
    }
  }, [scene, updateScene, saveSceneHTML])

  const hasTtsContent = !!(
    audio.tts &&
    (audio.tts.text?.trim() || audio.tts.src?.trim() || audio.tts.status === 'generating')
  )

  return (
    <div style={{ marginTop: '4px' }}>
      {error && (
        <div
          role="alert"
          style={{
            margin: '0 0 8px',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
            background: 'rgba(224,82,82,0.12)',
            color: '#e05252',
            border: '1px solid rgba(224,82,82,0.3)',
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '10px 0 8px',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <Mic size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--color-text-muted)',
            letterSpacing: '0.048px',
            textTransform: 'uppercase',
          }}
        >
          Narration & dialogue
        </span>
      </div>

      {!hasTtsContent && (
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--color-border)' }}>
          <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', margin: '0 0 10px' }}>
            No voice track yet. Generate narration from the scene prompt.
          </p>
          <SettingsButton onClick={() => void handleGenerateVoiceover()}>
            <Volume2 size={12} style={{ marginRight: '4px' }} />
            Narrate from prompt
          </SettingsButton>
        </div>
      )}

      {audio.tts && (
        <div style={{ paddingTop: '12px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <span
              style={{
                fontSize: '10px',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06px',
                color: 'var(--color-text-muted)',
              }}
            >
              Voice
            </span>
            <span
              style={{
                borderRadius: '9999px',
                padding: '2px 8px',
                fontSize: '10px',
                fontWeight: 500,
                background: 'var(--color-accent)',
                color: '#fff',
              }}
            >
              {audio.tts.provider}
            </span>
            {audio.tts.status === 'ready' && <span style={{ fontSize: '10px', color: '#4ade80' }}>Ready</span>}
            {audio.tts.status === 'generating' && (
              <span style={{ fontSize: '10px', color: '#fbbf24' }}>Generating...</span>
            )}
            {audio.tts.status === 'error' && <span style={{ fontSize: '10px', color: '#f87171' }}>Error</span>}
          </div>

          {audio.tts.text?.trim() ? (
            <textarea
              readOnly
              value={audio.tts.text}
              rows={3}
              style={{
                width: '100%',
                resize: 'none',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                padding: '8px 10px',
                fontSize: '11px',
                lineHeight: 1.5,
                background: 'var(--color-input-bg)',
                color: 'var(--color-text-muted)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          ) : audio.tts.src ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                background: 'rgba(255,255,255,0.03)',
                padding: '8px 12px',
              }}
            >
              <Volume2 size={12} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '11px',
                  color: 'var(--color-text-primary)',
                }}
              >
                {audio.tts.src.split('/').pop() || 'Audio file'}
              </span>
            </div>
          ) : (
            <p style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>No script or file yet.</p>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
            <SettingsButton
              disabled={generatingTTS || !audio.tts.text?.trim()}
              onClick={async () => {
                if (generatingTTS || !audio.tts?.text) return
                setGeneratingTTS(true)
                try {
                  await generateNarration(scene.id, audio.tts.text, audio.tts.provider, audio.tts.voiceId || undefined)
                } catch {
                  /* store sets error */
                }
                setGeneratingTTS(false)
              }}
            >
              <RefreshCw
                size={12}
                style={{ marginRight: '4px', animation: generatingTTS ? 'spin 1s linear infinite' : undefined }}
              />
              {generatingTTS ? 'Regenerating...' : 'Regenerate'}
            </SettingsButton>
            <SettingsButton variant="danger" onClick={clearNarrationAndFile}>
              <Trash2 size={12} style={{ marginRight: '4px' }} />
              Remove voice
            </SettingsButton>
          </div>
        </div>
      )}
    </div>
  )
}
