/**
 * Chat UI showcase mode.
 *
 * Dev-only harness: swaps the live transcript for a deterministic fixture set
 * that renders EVERY terminal chat-card state through the real render path —
 * zero API spend, zero DB writes. Activated from the Dev settings tab.
 *
 * ── State machine ────────────────────────────────────────────────────────────
 *
 *            enterShowcase()                    exitShowcase()
 *   ┌──────┐ snapshot 6 atoms ──► ┌──────────┐ restore snapshot ──► ┌──────┐
 *   │ live │                      │ showcase │                      │ live │
 *   └──────┘ ◄── (idempotent:     └──────────┘                      └──────┘
 *                re-enter is a         │ auto-exit: switchConversation /
 *                no-op — never         │ loadProject call exitShowcase()
 *                double-snapshots)     ▼ FIRST, so fixtures never bleed
 *                                  restore-then-switch
 *
 * Why snapshot/restore instead of "just reload the conversation": restore is
 * synchronous, works for unsaved drafts, and never touches the DB — the whole
 * point of the fence.
 *
 * The persistence fence itself lives at the persist boundaries in
 * `agent-actions.ts` (persistUserMessage / persistChatMessage /
 * persistStreamingChatMessage early-return while showcaseMode) — guard the
 * chokepoints, not the callers.
 */

import { buildShowcaseFixture } from '../dev/chat-ui-fixtures'
import type { Get, Set, ShowcaseSnapshot } from './types'
import { createLogger } from '../logger'

const log = createLogger('store.showcase')

export function createShowcaseActions(set: Set, get: Get) {
  return {
    showcaseMode: false,
    _showcaseSnapshot: null as ShowcaseSnapshot | null,

    enterShowcase: () => {
      const s = get()
      // Idempotent: a second enter must NOT re-snapshot (it would capture the
      // fixture as "the real transcript" and lose the actual one).
      if (s.showcaseMode) return
      // Never swap out a live run's transcript mid-stream.
      if (s.isGenerating) {
        log.warn('showcase: refused to enter while a run is generating')
        return
      }
      const snapshot: ShowcaseSnapshot = {
        chatMessages: s.chatMessages,
        pendingPlan: s.pendingPlan,
        planTodos: s.planTodos,
        planAwaitingApproval: s.planAwaitingApproval,
        structuralCutsProposed: s.structuralCutsProposed,
      }
      const fixture = buildShowcaseFixture()
      set({
        showcaseMode: true,
        _showcaseSnapshot: snapshot,
        chatMessages: fixture.messages,
        pendingPlan: fixture.pendingPlan,
        planTodos: fixture.planTodos,
        planAwaitingApproval: fixture.planAwaitingApproval,
        structuralCutsProposed: fixture.structuralCutsProposed,
      })
      log.info('showcase: entered', { extra: { messages: fixture.messages.length } })
    },

    exitShowcase: () => {
      const s = get()
      if (!s.showcaseMode) return // exit-without-enter is a no-op
      const snap = s._showcaseSnapshot
      set({
        showcaseMode: false,
        _showcaseSnapshot: null,
        // Restore the exact pre-showcase state. A missing snapshot (should be
        // impossible — set atomically with the flag) restores to empty rather
        // than leaving fixtures behind.
        chatMessages: snap?.chatMessages ?? [],
        pendingPlan: snap?.pendingPlan ?? null,
        planTodos: snap?.planTodos ?? [],
        planAwaitingApproval: snap?.planAwaitingApproval ?? false,
        structuralCutsProposed: snap?.structuralCutsProposed ?? null,
      })
      log.info('showcase: exited (transcript restored)')
    },
  }
}
