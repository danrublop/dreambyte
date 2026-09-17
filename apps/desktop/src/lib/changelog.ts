/**
 * Per-version "What's new" changelog data + the once-per-version selector.
 *
 * Contract:
 *   - Show the overlay only on a GENUINE version change.
 *   - NEVER show on a fresh install (no previously-seen version).
 *   - Show exactly once: the caller persists the current version the moment it
 *     shows, so a relaunch on the same version won't re-trigger it.
 *
 * The data lives here so the modal and its unit test share one source of truth.
 * Add a new entry (newest first) whenever you bump `package.json` version and
 * want users to see what changed after the auto-update lands.
 */

export interface ChangelogSection {
  heading: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  date?: string
  sections: ChangelogSection[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.7.16.0',
    date: '2026-06-24',
    sections: [
      {
        heading: 'Editor polish',
        items: [
          'New trim shortcuts: Q / [ trims a clip’s start to the playhead, W / ] trims its end.',
          'Hold Option while dragging a clip to duplicate it.',
          'Option-scroll now zooms the timeline to your cursor (matching ⌘-scroll).',
          'Esc deselects and snaps the active tool back to Select.',
        ],
      },
      {
        heading: 'Native niceties',
        items: [
          'Get a system notification when an export finishes while you’re in another window.',
          'One-click MCP setup for Claude Code, Cursor, Codex, and Claude Desktop in Settings → Agents.',
          'Send feedback (with an optional screenshot) right from the app.',
        ],
      },
    ],
  },
]

/**
 * Decide whether to show the "What's new" overlay.
 *
 * @param currentVersion  the running app version (e.g. app.getVersion())
 * @param lastSeenVersion the version the user last saw the overlay for, or
 *                        null/'' on a fresh install
 * @returns the entry to display, or null to show nothing
 */
export function getPendingChangelog(
  currentVersion: string | null | undefined,
  lastSeenVersion: string | null | undefined,
): ChangelogEntry | null {
  const current = (currentVersion ?? '').trim()
  if (!current) return null
  const lastSeen = (lastSeenVersion ?? '').trim()
  // Fresh install (never seen a version) — don't greet with a changelog.
  if (!lastSeen) return null
  // Already on this version — nothing new.
  if (lastSeen === current) return null
  // Genuine upgrade: show the entry matching the new version, if we have one.
  return CHANGELOG.find((e) => e.version === current) ?? null
}
