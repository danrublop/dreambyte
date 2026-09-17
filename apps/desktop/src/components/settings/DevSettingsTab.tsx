'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { SettingsSection, SettingRow, SettingsButton, Switch } from './shared'
import { THREE_ENV_GALLERY_SCENE_COUNT } from '@/lib/threeEnvironmentShowcaseScenes'

export default function DevSettingsTab() {
  const {
    seedReactShowcaseScenes,
    seedCapabilityShowcaseScenes,
    seedThreeEnvironmentShowcaseScenes,
    scenes,
    setStructuralCutsProposed,
    project,
    deleteProjectFromDb,
  } = useVideoStore()
  const mockMode = useVideoStore((s) => s.mockMode)
  const showcaseMode = useVideoStore((s) => s.showcaseMode)
  const enterShowcase = useVideoStore((s) => s.enterShowcase)
  const exitShowcase = useVideoStore((s) => s.exitShowcase)

  // One loading flag for all seeds (was 13 separate useState booleans).
  const [loading, setLoading] = useState<string | null>(null)
  const [seedsOpen, setSeedsOpen] = useState(false)

  const run = async (label: string, fn: () => Promise<void>) => {
    setLoading(label)
    try {
      await fn()
    } finally {
      setLoading(null)
    }
  }

  const seeds: { label: string; fn: () => Promise<void> }[] = [
    { label: 'React showcase (6)', fn: seedReactShowcaseScenes },
    { label: 'Three.js showcase (6)', fn: seedCapabilityShowcaseScenes },
    { label: `Three env gallery (${THREE_ENV_GALLERY_SCENE_COUNT})`, fn: seedThreeEnvironmentShowcaseScenes },
  ]

  return (
    <div>
      <SettingsSection>Test scenes</SettingsSection>

      <button
        onClick={() => setSeedsOpen((o) => !o)}
        className="flex w-full items-center justify-between px-1 py-2.5 text-left"
        style={{ background: 'transparent', cursor: 'pointer' }}
      >
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-medium text-[var(--ink)]">Seed scene sets</p>
          <p className="mt-0.5 text-[12px] text-[var(--mute)]">{seeds.length} loaders for testing the renderer</p>
        </div>
        <ChevronRight
          size={16}
          className="text-[var(--graphite)] transition-transform"
          style={{ transform: seedsOpen ? 'rotate(90deg)' : 'none' }}
        />
      </button>

      {seedsOpen && (
        <div className="settings-list">
          {seeds.map(({ label, fn }) => (
            <div key={label} className="flex items-center justify-between px-1 py-2.5">
              <span className="text-[13px] text-[var(--ink-soft)]">{label}</span>
              <SettingsButton onClick={() => run(label, fn)} disabled={loading !== null}>
                {loading === label ? 'Loading…' : 'Load'}
              </SettingsButton>
            </div>
          ))}
        </div>
      )}

      <SettingsSection>Chat UI showcase</SettingsSection>

      <SettingRow
        label={showcaseMode ? 'Showcase active' : 'Load chat UI showcase'}
        description={
          showcaseMode
            ? 'Fixture transcript on screen. Nothing persists; the composer is blocked. Exit restores your real conversation.'
            : 'Swap in a fixture conversation rendering every chat card state (tool calls, permissions, plan, cuts, banners). No API credits, no DB writes. Close Settings to see it.'
        }
      >
        <SettingsButton onClick={() => (showcaseMode ? exitShowcase() : enterShowcase())}>
          {showcaseMode ? 'Exit' : 'Load'}
        </SettingsButton>
      </SettingRow>

      <SettingsSection>Mock mode</SettingsSection>

      <SettingRow
        label="Mock agent"
        description='Simulate agent responses with no API credits. Keywords: "multi", "error", "permission", "mutation", "websearch", "biometric", "plan".'
      >
        <Switch checked={mockMode} ariaLabel="Mock agent" onChange={(v) => useVideoStore.setState({ mockMode: v })} />
      </SettingRow>

      <SettingsSection>Cut review (Gap 3.1)</SettingsSection>

      <SettingRow
        label="Propose test cuts"
        description="Inject a fake structural-cuts proposal for this project's scenes so the review card renders in chat. No agent run or API credits. Close Settings to see it."
      >
        <SettingsButton
          onClick={() => {
            // Build a proposal from REAL scenes so the card's live re-read shows
            // survivors and the cascade-impact line computes against the timeline.
            // Require 2+ scenes: cut candidates are always scenes AFTER the first,
            // and we never propose cutting the only scene.
            if (scenes.length < 2) {
              alert('Load 2+ scenes to test cuts (the test keeps scene 1 and proposes cutting later scenes).')
              return
            }
            const picked = scenes.slice(1, 3)
            const cuts = picked.map((s, i) => ({
              sceneId: s.id,
              sceneName: s.name || 'Untitled scene',
              detail: i === 0 ? 'repeats scene 1 with no new information (test)' : 'overlaps an earlier scene (test)',
              kind: 'redundancy' as const,
            }))
            setStructuralCutsProposed(cuts)
            // Persist branch-scoped so it survives a reload, mirroring the real
            // arrival path (0015: the SSE event is persisted server-side now).
            void useVideoStore.getState().persistBranchProposalField('structuralCutsProposed', cuts)
          }}
        >
          Propose
        </SettingsButton>
      </SettingRow>

      <SettingsSection>Danger zone</SettingsSection>

      <SettingRow label="Delete project" description={`Permanently remove "${project.name}" and all its scenes`}>
        <SettingsButton
          variant="danger"
          onClick={async () => {
            if (confirm(`Delete project "${project.name}"?`)) await deleteProjectFromDb(project.id)
          }}
        >
          Delete
        </SettingsButton>
      </SettingRow>
    </div>
  )
}
