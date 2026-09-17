'use client'

import { useVideoStore } from '@/lib/store'
import LayersTab from '../tabs/LayersTab'
import SceneLayersStackPanel from '../layers/SceneLayersStackPanel'
import LayerStackPropertiesPanel from '../layers/LayerStackPropertiesPanel'

/**
 * Scene + layer stack for the active project, shown in the editor-view sidebar
 * BELOW the nav (workspace switcher / New video / Library / Customize). Replaces
 * the projects list when in the editor, so the editor reuses one unified
 * HomeSidebar instead of a separate aside.
 */
export default function EditorLayersPanel() {
  const scenes = useVideoStore((s) => s.scenes)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? scenes[0]
  const layerStackPropertiesKey = useVideoStore((s) => s.layerStackPropertiesKey)
  // A scene-LESS project can still hold dropped media/audio CLIPS — show the
  // standalone-clip stack (+ clip inspector) so dropped footage is visible and
  // gradable instead of the "No scenes yet" placeholder.
  const hasStandaloneClips = useVideoStore((s) =>
    (s.project.timeline?.tracks ?? []).some((t) =>
      t.clips.some(
        (c) =>
          c.sourceType === 'video' ||
          c.sourceType === 'image' ||
          (c.sourceType === 'audio' && !/^(aud-|tts-|mus-)/.test(c.sourceId)),
      ),
    ),
  )

  if (!selectedScene) {
    if (hasStandaloneClips) {
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {layerStackPropertiesKey ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <LayerStackPropertiesPanel />
            </div>
          ) : (
            <SceneLayersStackPanel fillAvailableHeight />
          )}
        </div>
      )
    }
    return (
      <div className="px-1 py-6 text-[12px] text-[var(--mute)]">
        No scenes yet — describe one in chat or drop media on the timeline to get started.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <LayersTab scene={selectedScene} showScenesSection />
    </div>
  )
}
