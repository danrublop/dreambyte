'use client'

import { useState, useRef, useCallback } from 'react'
import SidebarUserButton from './SidebarUserButton'
import { Settings, Palette, BarChart2, Box, Brain, Puzzle, ScrollText, Wrench, Code2 } from 'lucide-react'

import AgentsSettingsTab from './settings/AgentsSettingsTab'
import ModelsAndApiPanel from './settings/ModelsAndApiPanel'
import { MediaUnderstandingTab } from './settings/MediaUnderstandingTab'
import UsageSection from './settings/UsageSection'
import GeneralSettingsTab from './settings/GeneralSettingsTab'
import AppearanceSettingsTab from './settings/AppearanceSettingsTab'
import RulesSkillsSubagentsTab from './settings/RulesSkillsSubagentsTab'
import PermissionsPanel from './settings/PermissionsPanel'
import DevSettingsTab from './settings/DevSettingsTab'
import { SettingsSection, SettingsEmptyState } from './settings/shared'
import type { SettingsSection as SettingsSectionId } from '@/lib/store/types'

export type Section = SettingsSectionId

interface NavItem {
  id: Section
  label: string
  icon: React.ReactNode
}

// Dev tools are hidden in production. Set localStorage.dreambyte_dev = '1' to reveal them.
const SHOW_DEV =
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') ||
  (typeof window !== 'undefined' && window.localStorage?.getItem('dreambyte_dev') === '1')

// Grouped nav: app/account, then AI, then extensions; dev gated at the bottom.
const NAV_GROUPS: { items: NavItem[] }[] = [
  {
    items: [
      { id: 'general', label: 'General', icon: <Settings size={13} strokeWidth={1.5} /> },
      { id: 'appearance', label: 'Appearance', icon: <Palette size={13} strokeWidth={1.5} /> },
      { id: 'usage', label: 'Plan & Usage', icon: <BarChart2 size={13} strokeWidth={1.5} /> },
      { id: 'agents', label: 'Agents', icon: <Box size={13} strokeWidth={1.5} /> },
    ],
  },
  {
    items: [{ id: 'models', label: 'Models', icon: <Brain size={13} strokeWidth={1.5} /> }],
  },
  {
    // Plugins + Tools & MCP are stubs ("Coming soon"), so they're gated behind
    // the same Dev flag as the Dev tab. Rules/Skills/Subagents is a
    // real feature and stays visible.
    items: [
      ...(SHOW_DEV
        ? [{ id: 'plugins' as Section, label: 'Plugins', icon: <Puzzle size={13} strokeWidth={1.5} /> }]
        : []),
      { id: 'rules-skills', label: 'Rules, Skills, Subagents', icon: <ScrollText size={13} strokeWidth={1.5} /> },
      ...(SHOW_DEV
        ? [{ id: 'tools' as Section, label: 'Tools & MCP', icon: <Wrench size={13} strokeWidth={1.5} /> }]
        : []),
    ],
  },
  ...(SHOW_DEV
    ? [{ items: [{ id: 'dev' as Section, label: 'Dev', icon: <Code2 size={13} strokeWidth={1.5} /> }] }]
    : []),
]

const SECTION_TITLES: Record<Section, string> = {
  general: 'General',
  appearance: 'Appearance',
  usage: 'Plan & Usage',
  agents: 'Agents',
  models: 'Models',
  plugins: 'Plugins',
  'rules-skills': 'Rules, Skills, Subagents',
  tools: 'Tools & MCP',
  dev: 'Dev',
}

interface Props {
  onClose: () => void
}

/**
 * Settings tab list (grouped nav + user profile pinned at the bottom, matching
 * the regular sidebar). Rendered either inside SettingsPanel's own left column,
 * or — in the unified shell — directly in the docked sidebar slot, so settings
 * opens in the content area with its tab list inside the sidebar panel.
 */
export function SettingsNav({
  active,
  onSelect,
  onClose,
}: {
  active: Section
  onSelect: (s: Section) => void
  onClose?: () => void
}) {
  const navRef = useRef<HTMLElement>(null)
  const allItems = NAV_GROUPS.flatMap((g) => g.items)

  const handleNavKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const currentIndex = allItems.findIndex((item) => item.id === active)
      const next =
        e.key === 'ArrowDown' ? Math.min(currentIndex + 1, allItems.length - 1) : Math.max(currentIndex - 1, 0)
      onSelect(allItems[next].id)
    },
    [allItems, active, onSelect],
  )

  return (
    <div className="flex h-full flex-col">
      {/* Nav */}
      <nav ref={navRef} className="flex-1 overflow-y-auto pb-2 pt-1" onKeyDown={handleNavKeyDown}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi}>
            {gi > 0 && <div className="h-2" />}
            {group.items.map((item) => {
              const isActive = active === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    padding: '6px 12px',
                    color: 'var(--ink)',
                    opacity: isActive ? 1 : 0.78,
                    background: isActive ? 'var(--card)' : 'none',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ opacity: isActive ? 0.85 : 0.55, flexShrink: 0 }}>{item.icon}</span>
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Account row — the exact same component as the regular sidebar, so
          opening Settings never changes it. The gear closes Settings here. */}
      <div className="shrink-0">
        <SidebarUserButton onClick={onClose} />
      </div>
    </div>
  )
}

/** Settings content for the active section. */
export function SettingsContent({ active }: { active: Section }) {
  return (
    <div className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Models renders its own title (with count + filter inline). */}
        {active !== 'models' && (
          <h1 className="mb-6 text-[22px] font-semibold text-[var(--ink)]">{SECTION_TITLES[active]}</h1>
        )}

        {active === 'general' && <GeneralSettingsTab />}
        {active === 'appearance' && <AppearanceSettingsTab />}
        {active === 'usage' && <UsageSection />}
        {active === 'agents' && (
          <>
            <AgentsSettingsTab />
            <div className="mt-8 border-t border-[var(--hairline)] pt-6">
              <SettingsSection>Permissions</SettingsSection>
              <PermissionsPanel />
            </div>
            <div className="mt-8 border-t border-[var(--hairline)] pt-6">
              <SettingsSection>Media understanding</SettingsSection>
              <MediaUnderstandingTab />
            </div>
          </>
        )}
        {active === 'models' && <ModelsAndApiPanel />}
        {active === 'plugins' && SHOW_DEV && (
          <SettingsEmptyState
            icon={<Puzzle size={26} strokeWidth={1.5} />}
            title="Plugins"
            description="Install and manage plugins that extend Dreambyte. Coming soon."
          />
        )}
        {active === 'rules-skills' && <RulesSkillsSubagentsTab />}
        {active === 'tools' && SHOW_DEV && (
          <SettingsEmptyState
            icon={<Wrench size={26} strokeWidth={1.5} />}
            title="Tools & MCP"
            description="Connect Model Context Protocol servers and configure the tools available to agents. Coming soon."
          />
        )}
        {active === 'dev' && SHOW_DEV && <DevSettingsTab />}
      </div>
    </div>
  )
}

export default function SettingsPanel({ onClose: _onClose }: Props) {
  const [activeSection, setActiveSection] = useState<Section>('general')

  return (
    <div className="flex h-full text-[var(--ink)]">
      <div className="flex shrink-0 flex-col overflow-y-auto border-r border-[var(--hairline)]" style={{ width: 240 }}>
        <SettingsNav active={activeSection} onSelect={setActiveSection} />
      </div>
      <SettingsContent active={activeSection} />
    </div>
  )
}
