/**
 * Chat UI showcase fixtures.
 *
 * One deterministic fixture set that drives EVERY terminal chat-card state
 * through the real transcript render path — injected by
 * `src/lib/store/showcase-actions.ts` via the Dev tab's "Load chat UI showcase"
 * button. Zero API spend, zero DB writes (persist boundaries are fenced while
 * showcaseMode is on).
 *
 * ── STATE COVERAGE MAP (two-prong model) ─────────────────
 *
 * Prong 1 — THIS FILE (static fixtures, terminal states, instant):
 *   chatMessages-driven:
 *     • user message: plain text ............................ EditableUserMessage
 *     • user message: text + image attachment ............... EditableUserMessage + ImageLightbox
 *     • assistant: text + thinking + usage .................. StreamingMessage + ThinkingBlock
 *     • assistant: single tool call done / error / running .. ToolCallItem
 *     • assistant: 5-call burst (incl. one error) ........... ToolCallSummary collapse
 *     • assistant: interleaved text/tool contentSegments .... StreamingMessage segment renderer
 *     • assistant: pendingPermissions, all 4 kinds ×
 *       unresolved / allowed / denied ....................... GenerationConfirmCard
 *     • assistant: sources (citations) ...................... SourcesBlock
 *     • assistant: incomplete (interrupted-run banner)
 *     • assistant: rateLimited (rate-limit banner; countdown TEXT is mock-prong)
 *     • assistant: hasCheckpoint + reason + scenesBuilt ..... checkpoint banner
 *   separate store atoms (injected alongside messages):
 *     • pendingPlan + planTodos + planAwaitingApproval ...... PlanCard (awaiting-approval state)
 *     • structuralCutsProposed .............................. StructuralCutsReviewCard
 *
 * Prong 2 — MOCK AGENT STREAM (src/lib/agents/mock-agent-stream.ts, live states):
 *     • token streaming / StreamingMessage / activeToolName   (default scenario)
 *     • isGenerating plan-building PlanCard state ........... ("plan" scenario)
 *     • permission arriving mid-run, all kinds .............. ("permission…" scenarios)
 *     • mid-run tool failure ................................ ("error" scenario)
 *     • rate-limit countdown TEXT (local useState) .......... unreachable from store by design
 *     • BranchCard (local showBranchDropdown) ............... open via the Branches tab
 *
 * Adding a new card? Add its state here (or to a mock scenario), update this
 * map, and extend `chat-ui-fixtures.test.ts`'s completeness assertions —
 * states, not components.
 */

import type { AgentPlan, AgentTodo, ChatMessage, StructuralCut } from '../agents/types'
import {
  resetSampleMessageIds,
  sampleCuts,
  sampleImageAttachment,
  sampleMessage,
  samplePermission,
  samplePlan,
  samplePlanTodos,
  sampleSources,
  sampleToolCall,
  sampleToolCallBurst,
  sampleUsage,
} from './sample-payloads'

/** Everything `enterShowcase()` injects. */
export interface ShowcaseFixture {
  messages: ChatMessage[]
  pendingPlan: AgentPlan
  planTodos: AgentTodo[]
  planAwaitingApproval: boolean
  structuralCutsProposed: StructuralCut[]
}

export function buildShowcaseFixture(): ShowcaseFixture {
  resetSampleMessageIds()

  const singleTool = sampleToolCall({ id: 'showcase-tool-s1', state: 'done' })
  const burst = sampleToolCallBurst()

  const messages: ChatMessage[] = [
    // 1 — plain user message
    sampleMessage('user', 'Make me a 30-second video recapping our Q3 results.'),

    // 2 — assistant: thinking + interleaved text/tool + usage
    sampleMessage('assistant', 'Starting with the opening title scene, then the revenue chart.', {
      thinking:
        'The user wants a short recap. Three scenes: hook, the one chart that matters, CTA. Keep narration tight — ~2.5 words/sec.',
      toolCalls: [singleTool],
      contentSegments: [
        { type: 'text', text: 'Starting with the opening title scene,' },
        { type: 'tool', toolCallId: singleTool.id },
        { type: 'text', text: 'then the revenue chart.' },
      ],
      usage: sampleUsage(),
    }),

    // 3 — user message with image attachment (lightbox path)
    sampleMessage('user', [
      { type: 'text', text: 'Use this brand reference for the palette.' },
      { type: 'image', image: sampleImageAttachment() },
    ]),

    // 4 — assistant: multi-call burst incl. one error → ToolCallSummary collapse
    sampleMessage(
      'assistant',
      'Built the remaining scenes and wired transitions — one transition failed verification.',
      {
        toolCalls: burst,
        contentSegments: [
          {
            type: 'text',
            text: 'Built the remaining scenes and wired transitions — one transition failed verification.',
          },
          ...burst.map((t) => ({ type: 'tool' as const, toolCallId: t.id })),
        ],
      },
    ),

    // 5 — assistant: running tool call (spinner state, statically frozen)
    sampleMessage('assistant', 'Adding the narration track now.', {
      toolCalls: [sampleToolCall({ id: 'showcase-tool-run', toolName: 'add_narration', state: 'running' })],
    }),

    // 6 — assistant: all 4 permission kinds, unresolved (interactive Allow/Deny)
    sampleMessage('assistant', 'A few of these steps need your approval before I spend or mutate anything:', {
      pendingPermissions: [
        samplePermission('paid_api'),
        samplePermission('mutation_preview'),
        samplePermission('web_search'),
        samplePermission('biometric_consent'),
      ],
    }),

    // 7 — assistant: resolved permission states (allowed + denied)
    sampleMessage('assistant', 'Earlier approvals, for the resolved card styles:', {
      pendingPermissions: [
        samplePermission('paid_api', { resolved: 'allow' }),
        samplePermission('mutation_preview', { resolved: 'deny' }),
      ],
    }),

    // 8 — assistant: web-search citations
    sampleMessage('assistant', 'Grounded the chart in the latest market data.', {
      sources: sampleSources(),
    }),

    // 9 — assistant: interrupted-run banner
    sampleMessage('assistant', 'Halfway through building the outro scene when', {
      incomplete: true,
    }),

    // 10 — assistant: rate-limit banner (countdown text is mock-prong)
    sampleMessage('assistant', '', {
      rateLimited: true,
    }),

    // 11 — assistant: checkpoint banner (cost cap)
    sampleMessage('assistant', 'Paused after building 2 of 3 scenes — the run hit its cost cap.', {
      hasCheckpoint: true,
      checkpointReason: 'cost_cap',
      checkpointScenesBuilt: 2,
      usage: sampleUsage({ costUsd: 2.5, apiCalls: 9 }),
    }),
  ]

  return {
    messages,
    pendingPlan: samplePlan(),
    planTodos: samplePlanTodos(),
    planAwaitingApproval: true,
    structuralCutsProposed: sampleCuts(),
  }
}
