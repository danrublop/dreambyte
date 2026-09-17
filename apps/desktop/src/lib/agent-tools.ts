// Agent tool filter chips (UI) — the MENU of toggleable capabilities. The live tool
// catalog lives in src/lib/agents/tools.ts.
//
// Which of these start ON is decided by ONE place: the `activeTools` default in
// src/lib/store/index.ts. Chips carry no default flag of their own, so there is a single
// source of truth for "what's enabled". See tool-defaults.test.ts.
/**
 * `group` decides whether a chip is REACHABLE. The panel UI maps over this list (via
 * panelToolChips) rather than a hand-written id list, so a gated tool always has a
 * switch.
 *
 *   'panel' — rendered as a toggle in the chat tool-filter panel.
 *   'auto'  — deliberately not rendered; driven by provider/key availability in
 *             filterToolsForAgent rather than by a manual switch.
 *
 * Every chip must declare one, and `agent-tool-chips.test.ts` fails the build if a new
 * chip is unreachable-by-accident.
 */
export type ToolFilterChip = { id: string; label: string; group: 'panel' | 'auto' }

export const TOOL_FILTER_CHIPS: ToolFilterChip[] = [
  { id: 'canvas2d', label: 'Canvas2D', group: 'panel' },
  { id: 'svg', label: 'SVG', group: 'panel' },
  { id: 'd3', label: 'D3', group: 'panel' },
  { id: 'three', label: 'Three.js', group: 'panel' },
  { id: 'motion', label: 'Motion', group: 'auto' },
  { id: 'lottie', label: 'Lottie', group: 'panel' },
  { id: 'zdog', label: 'Zdog', group: 'panel' },
  { id: 'assets', label: 'Assets', group: 'auto' },
  { id: 'html', label: 'HTML', group: 'panel' },
  { id: 'audio', label: 'Audio', group: 'auto' },
  { id: 'video', label: 'Video', group: 'auto' },
  { id: 'avatars', label: 'HeyGen', group: 'auto' },
  { id: 'ai-video', label: 'Veo3', group: 'auto' },
  { id: 'ai-images', label: 'AI Images', group: 'auto' },
  { id: 'stickers', label: 'Stickers', group: 'auto' },
  { id: 'eleven-labs', label: 'ElevenLabs', group: 'auto' },
  { id: 'unsplash', label: 'Unsplash', group: 'auto' },
  { id: 'interactions', label: 'Interactions', group: 'panel' },
  // OFF by default (absent from store activeTools). Turns on the NLE edit surface —
  // clips, tracks, colour grade, captions — for the agent. See NLE_EDIT_TOOL_NAMES.
  // MUST be 'panel': gating these tools is only defensible if the user can ungate them.
  { id: 'timeline', label: 'Timeline Editing', group: 'panel' },
]

/** The chips the tool-filter panel renders. The UI must map over THIS, never a
 *  hand-written id list. */
export const panelToolChips = (): ToolFilterChip[] => TOOL_FILTER_CHIPS.filter((c) => c.group === 'panel')
