'use client'

import { useCallback } from 'react'
import { useVideoStore } from '@/lib/store'
import type { AvatarLayer, MediaTimingPolicy, Scene } from '@/lib/types'
import { REMOVED_LOCAL_AVATAR_MESSAGE, usesRemovedLocalAvatar } from '@/lib/avatar/removed-local-avatar'
import type { LayersTabSectionId } from '@/lib/layers-tab-header'
import { Section, HRow, NumberCell, SelectCell, SliderCell } from '@/components/layers/property-panel-primitives'

// A4 — what export does when the generated clip outruns the scene duration.
const TIMING_POLICY_OPTIONS: { value: MediaTimingPolicy; label: string }[] = [
  { value: 'extend-scene', label: 'Extend scene to fit clip' },
  { value: 'trim', label: 'Trim clip at scene end' },
  { value: 'hold-last-frame', label: 'Hold last frame' },
]

interface Props {
  scene: Scene
  layerId: string
  onCommit: () => void
  // Unused by this panel; callers still pass it through.
  openLayersSection?: (id: LayersTabSectionId, opts?: { avatarLayerId?: string }) => void
}

export default function AvatarLayerPropertiesForm({ scene, layerId, onCommit }: Props) {
  const { updateAILayer } = useVideoStore()
  const layer = (scene.aiLayers ?? []).find((l) => l.id === layerId) as AvatarLayer | undefined

  const patch = useCallback(
    (updates: Partial<AvatarLayer>) => {
      updateAILayer(scene.id, layerId, updates)
    },
    [scene.id, layerId, updateAILayer],
  )

  if (!layer || layer.type !== 'avatar') {
    return <p className="px-5 py-4 text-[11px] text-[var(--color-text-muted)]">Avatar layer not found.</p>
  }

  return (
    <div>
      <Section title="Source">
        <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {usesRemovedLocalAvatar(layer)
            ? `${REMOVED_LOCAL_AVATAR_MESSAGE}. Delete this layer or generate a new avatar with another provider.`
            : 'This avatar plays a video file (e.g. HeyGen). Replace the source from the Setup tab.'}
        </p>
      </Section>

      <Section title="Layer" defaultOpen={false}>
        <HRow label="Opacity">
          <SliderCell value={layer.opacity} onChange={(v) => patch({ opacity: v })} onCommit={onCommit} />
        </HRow>
        <HRow label="Z-index">
          <NumberCell
            value={layer.zIndex}
            onChange={(v) => patch({ zIndex: Math.round(v) })}
            onCommit={onCommit}
            step={1}
          />
        </HRow>
        <HRow label="Start at">
          <NumberCell
            value={layer.startAt ?? 0}
            onChange={(v) => patch({ startAt: Math.max(0, v) })}
            onCommit={onCommit}
            step={0.1}
            min={0}
            suffix="s"
          />
        </HRow>
        <HRow label="If clip runs long">
          <SelectCell
            value={layer.timingPolicy ?? 'extend-scene'}
            options={TIMING_POLICY_OPTIONS}
            onChange={(v) => patch({ timingPolicy: v as MediaTimingPolicy })}
          />
        </HRow>
      </Section>
    </div>
  )
}
