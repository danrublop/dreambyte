'use client'

import { useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { usePersistedState } from '@/lib/hooks/use-persisted-state'
import { SettingsSection, SettingRow, SettingsButton, Switch, SettingsCard } from './shared'
import { FeedbackModal } from '../FeedbackModal'

// Re-exported for external callers (ExportPanel, StudioTab, TextTab, AudioTabPanel).
export { SettingsButton } from './shared'

// App-level preferences. Appearance (theme, text size, font) lives in its own
// tab. The notification prefs persist to localStorage and are consumed by
// src/components/AgentRunNotifier.tsx when an agent run finishes.
export default function GeneralSettingsTab() {
  const currentUser = useVideoStore((s) => s.currentUser)
  const setCurrentUser = useVideoStore((s) => s.setCurrentUser)
  const [systemNotifications, setSystemNotifications] = usePersistedState(
    'dreambyte:settings:systemNotifications',
    true,
  )
  const [completionSound, setCompletionSound] = usePersistedState('dreambyte:settings:completionSound', false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const signedIn = !!currentUser
  const name = currentUser?.name ?? currentUser?.email ?? 'Guest'
  const sub = signedIn ? (currentUser?.email ?? 'Signed in') : 'Working locally — no account'
  const initial = (currentUser?.name ?? currentUser?.email ?? 'G').charAt(0).toUpperCase()

  return (
    <div className="space-y-6">
      {/* Account */}
      <SettingsCard>
        <div className="flex items-center gap-3 py-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[var(--panel)] text-[13px] font-semibold text-[var(--ink)]">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[13px] font-medium text-[var(--ink)]">{name}</p>
            <p className="mt-0.5 truncate text-[12px] text-[var(--mute)]">{sub}</p>
          </div>
          {signedIn && <SettingsButton onClick={() => setCurrentUser(null)}>Log out</SettingsButton>}
        </div>
      </SettingsCard>

      {/* Notifications */}
      <div>
        <SettingsSection>Notifications</SettingsSection>
        <SettingsCard>
          <SettingRow label="System notifications" description="Notify me when the agent finishes or needs input">
            <Switch checked={systemNotifications} onChange={setSystemNotifications} ariaLabel="System notifications" />
          </SettingRow>
          <SettingRow label="Completion sound" description="Play a sound when the agent finishes responding">
            <Switch checked={completionSound} onChange={setCompletionSound} ariaLabel="Completion sound" />
          </SettingRow>
        </SettingsCard>
      </div>

      {/* Feedback */}
      <div>
        <SettingsSection>Feedback</SettingsSection>
        <SettingsCard>
          <SettingRow label="Send feedback" description="Report a bug or share an idea — a screenshot is attached automatically">
            <SettingsButton onClick={() => setFeedbackOpen(true)}>
              <span className="flex items-center gap-1.5">
                <MessageSquare size={12} />
                Send feedback
              </span>
            </SettingsButton>
          </SettingRow>
        </SettingsCard>
      </div>

      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  )
}
