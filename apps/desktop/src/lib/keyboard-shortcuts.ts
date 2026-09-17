/**
 * Single source of truth for the keyboard shortcuts help sheet.
 *
 * Every entry here is VERIFIED against a live handler in the codebase — the
 * sheet must only advertise shortcuts that actually work. Citations:
 *   - Preview/transport: src/components/PreviewPlayer.tsx keydown (~:1265)
 *   - Timeline editing/tools/clipboard: src/components/timeline/Timeline.tsx keydown
 *     (~:694) + the TOOLS array in src/components/timeline/TimelineToolbar.tsx
 *   - Editor/global: src/components/Editor.tsx keydown (~:712)
 *
 * The help modal and the unit test both consume this list, so they can never
 * drift apart. `keys` is an ordered list of key chips (e.g. ['⌘', 'K']); on
 * non-mac the renderer can substitute Ctrl for ⌘ if desired.
 */

export interface KeyboardShortcut {
  /** Ordered key chips to render, e.g. ['⌘', 'Shift', 'Z']. */
  keys: string[]
  /** What the shortcut does. */
  label: string
}

export interface ShortcutGroup {
  /** Section heading, e.g. 'Playback'. */
  area: string
  shortcuts: KeyboardShortcut[]
}

export const KEYBOARD_SHORTCUTS: ShortcutGroup[] = [
  {
    area: 'Playback & navigation',
    shortcuts: [
      { keys: ['Space'], label: 'Play / pause' },
      { keys: ['←'], label: 'Step back one frame' },
      { keys: ['→'], label: 'Step forward one frame' },
      { keys: ['Shift', '←'], label: 'Jump back one second' },
      { keys: ['Shift', '→'], label: 'Jump forward one second' },
      { keys: ['Home'], label: 'Jump to start' },
      { keys: ['End'], label: 'Jump to end' },
      { keys: ['['], label: 'Previous scene boundary' },
      { keys: [']'], label: 'Next scene boundary' },
      { keys: ['I'], label: 'Mark in (range start at playhead)' },
      { keys: ['O'], label: 'Mark out (range end at playhead)' },
      { keys: ['G'], label: 'Toggle grid overlay' },
      { keys: ['⌘', '0'], label: 'Reset preview view (fit)' },
    ],
  },
  {
    area: 'Editing',
    shortcuts: [
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⌘', 'Shift', 'Z'], label: 'Redo' },
      { keys: ['⌘', 'S'], label: 'Save project' },
      { keys: ['⌘', 'A'], label: 'Select all clips' },
      { keys: ['⌘', 'C'], label: 'Copy selected clip(s)' },
      { keys: ['⌘', 'X'], label: 'Cut selected clip(s)' },
      { keys: ['⌘', 'V'], label: 'Paste at playhead' },
      { keys: ['⌘', 'Shift', 'V'], label: 'Paste (insert, ripple downstream)' },
      { keys: ['⌘', 'G'], label: 'Group selected clips' },
      { keys: ['⌘', 'Shift', 'G'], label: 'Ungroup clips' },
      { keys: ['⌘', 'D'], label: 'Default video transition' },
      { keys: ['⌘', 'Shift', 'D'], label: 'Default audio transition' },
      { keys: ['⌘', 'R'], label: 'Clip speed / duration…' },
      { keys: ['S'], label: 'Split clip at playhead' },
      { keys: ['Q'], label: 'Trim clip start to playhead' },
      { keys: ['W'], label: 'Trim clip end to playhead' },
      { keys: ['⌥', 'drag'], label: 'Duplicate clip' },
      { keys: ['Delete'], label: 'Delete selected clip(s)' },
      { keys: ['Shift', 'Delete'], label: 'Ripple delete selected clip(s)' },
    ],
  },
  {
    area: 'Timeline tools',
    shortcuts: [
      { keys: ['V'], label: 'Selection tool' },
      { keys: ['C'], label: 'Razor tool' },
      { keys: ['B'], label: 'Ripple edit tool' },
      { keys: ['Y'], label: 'Slip tool' },
      { keys: ['N'], label: 'Rolling edit tool' },
      { keys: ['U'], label: 'Slide tool' },
      { keys: ['H'], label: 'Hand tool' },
    ],
  },
  {
    area: 'Timeline zoom',
    shortcuts: [
      { keys: ['⌘', '='], label: 'Zoom in' },
      { keys: ['⌘', '-'], label: 'Zoom out' },
      { keys: ['⌘', '0'], label: 'Fit timeline to window' },
      { keys: ['⌥', 'scroll'], label: 'Zoom to cursor' },
      { keys: ['Shift', 'scroll'], label: 'Scroll timeline horizontally' },
    ],
  },
  {
    area: 'App',
    shortcuts: [
      { keys: ['⌘', 'K'], label: 'Command palette' },
      { keys: ['⌘', 'Shift', 'H'], label: 'Go to home' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
    ],
  },
]
