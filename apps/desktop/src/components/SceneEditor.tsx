'use client'

import { useVideoStore } from '@/lib/store'
import PromptTab from './tabs/PromptTab'
import LayersTab from './tabs/LayersTab'
import MediaLibrary from './MediaLibrary'
import { DreambyteLogo as AiIcon } from './icons/DreambyteLogo'
type Tab = 'prompt' | 'layers' | 'media' | 'inspector' | null

export default function SceneEditor() {
  const useElectronLayout = true
  const { scenes, selectedSceneId, rightPanelTab, setRightPanelTab } = useVideoStore()
  // Clip inspection moved to the LEFT panel's Layer tab (ClipDetailPanel in
  // the LayersTab master-detail). A persisted 'inspector' value from the old
  // layout falls back to the layers tab instead of rendering an empty panel.
  const activeTab: Tab = rightPanelTab === 'inspector' ? 'layers' : rightPanelTab
  const setActiveTab = (tab: Tab) => setRightPanelTab(tab)

  const selectedScene = scenes.find((s) => s.id === selectedSceneId)

  if (!selectedScene && activeTab !== 'media' && activeTab !== 'prompt') {
    return (
      <div className="flex items-center justify-center h-32 text-[#6b6b7a] text-sm p-4 text-center">
        Select or create a scene to edit
      </div>
    )
  }

  const tabs: { key: Tab; label: string; icon?: any }[] = [
    { key: 'layers', label: 'Layers' },
    { key: 'media', label: 'Media' },
    { key: 'prompt', label: 'Agent', icon: AiIcon },
  ]

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {!useElectronLayout && (
        <div className="flex shrink-0 gap-1 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-3 pb-2 pt-3">
          {tabs.map((tab) => {
            const isIconOnly = tab.key === 'prompt'
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(activeTab === tab.key ? null : tab.key)}
                className={`kbd h-7 transition-all duration-200 ${
                  isIconOnly ? 'w-7 px-0 flex-shrink-0' : 'flex-1 px-0 text-sm'
                } ${
                  activeTab === tab.key
                    ? 'bg-[#e84545] border-[#e84545] text-white shadow-[#800]'
                    : 'text-[#6b6b7a] hover:text-[#f0ece0] shadow-black/40'
                } relative`}
                data-tooltip={isIconOnly ? tab.label : undefined}
                data-tooltip-pos={isIconOnly ? 'bottom-left' : undefined}
              >
                {isIconOnly && Icon ? <Icon size={21} strokeWidth={2.5} /> : tab.label}
              </button>
            )
          })}
        </div>
      )}
      {/* Tab content: clip here; each tab (Layers, Agent, Media) scrolls inside its own panel */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* PromptTab stays mounted (hidden via CSS) so closing the chat panel
            doesn't unmount AgentChat and abort the active SSE stream. */}
        <div className={`flex min-h-0 flex-1 flex-col ${activeTab === 'prompt' ? '' : 'hidden'}`}>
          <PromptTab scene={selectedScene} />
        </div>
        {activeTab === 'layers' && selectedScene && <LayersTab scene={selectedScene} />}
        {activeTab === 'media' && <MediaLibrary />}
      </div>
    </div>
  )
}
