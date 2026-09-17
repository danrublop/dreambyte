/**
 * Canonical sample payloads — the SINGLE fabrication source for fake agent
 * data.
 *
 * Three layers consume these builders so the shapes can never drift apart:
 *   1. `src/lib/dev/chat-ui-fixtures.ts` — the static chat UI showcase (terminal
 *      states, injected via the Dev tab's "Load chat UI showcase" button).
 *   2. `src/lib/agents/mock-agent-stream.ts` — the Mock Agent streaming scenarios
 *      (live/transition states, no API credits).
 *   3. Tests — `runner.fixtures.ts` keeps its SSE event constructors but
 *      sources payload bodies from here.
 *
 * When a type in `src/lib/agents/types.ts` gains a field, the compiler errors
 * HERE, in one file — not silently in three.
 *
 * DETERMINISM CONTRACT: every builder returns byte-identical
 * output on every call. Stable ids (`showcase-*`), fixed timestamps anchored
 * at BASE_TS. No Date.now(), no Math.random(), no uuid — this keeps the
 * showcase screenshot-diffable for the planned CI visual-regression job.
 */

import type {
  AgentPlan,
  AgentTodo,
  ChatMessage,
  ImageAttachment,
  PendingPermission,
  ResearchSource,
  StructuralCut,
  ToolCallRecord,
  ToolResult,
  UsageStats,
} from '../agents/types'

/** Fixed epoch anchor: 2026-06-01T12:00:00Z. All sample timestamps derive from it. */
export const BASE_TS = 1780315200000

// ── Usage ────────────────────────────────────────────────────────────────────

export function sampleUsage(overrides?: Partial<UsageStats>): UsageStats {
  return {
    inputTokens: 48213,
    outputTokens: 6120,
    apiCalls: 4,
    costUsd: 0.4135,
    totalDurationMs: 92_400,
    cacheCreationTokens: 12_000,
    cacheReadTokens: 31_400,
    ...overrides,
  }
}

// ── Tool calls ───────────────────────────────────────────────────────────────

export type SampleToolState = 'running' | 'done' | 'error'

const TOOL_SUCCESS: ToolResult = {
  success: true,
  affectedSceneId: 'showcase-scene-1',
  changes: [{ type: 'scene_created', sceneId: 'showcase-scene-1', description: 'Created scene "Opening title"' }],
}

const TOOL_FAILURE: ToolResult = {
  success: false,
  error: 'Scene HTML failed verification: <svg> root is missing a viewBox attribute.',
}

/**
 * One tool-call record. `state` controls the lifecycle the card renders:
 * 'running' = no output yet, 'done' = success output + duration,
 * 'error' = failure output + duration.
 */
export function sampleToolCall(
  opts: { id?: string; toolName?: string; state?: SampleToolState; input?: Record<string, unknown> } = {},
): ToolCallRecord {
  const { id = 'showcase-tool-1', toolName = 'write_scene_code', state = 'done' } = opts
  const input = opts.input ?? {
    name: 'Opening title',
    duration: 6,
    sceneType: 'react',
    sceneCode: 'function Scene() { return <Title text="Q3 results" /> }',
  }
  if (state === 'running') return { id, toolName, input }
  return {
    id,
    toolName,
    input,
    output: state === 'error' ? TOOL_FAILURE : TOOL_SUCCESS,
    durationMs: state === 'error' ? 2150 : 5840,
  }
}

/** A burst of tool calls — drives the multi-call ToolCallSummary collapse. */
export function sampleToolCallBurst(): ToolCallRecord[] {
  return [
    sampleToolCall({ id: 'showcase-tool-b1', toolName: 'plan_scenes', state: 'done' }),
    sampleToolCall({ id: 'showcase-tool-b2', toolName: 'write_scene_code', state: 'done' }),
    sampleToolCall({ id: 'showcase-tool-b3', toolName: 'verify_scene', state: 'done' }),
    sampleToolCall({ id: 'showcase-tool-b4', toolName: 'add_narration', state: 'done' }),
    sampleToolCall({ id: 'showcase-tool-b5', toolName: 'set_transition', state: 'error' }),
  ]
}

// ── Permissions (all four kinds) ─────────────────────────────────────────────

export type SamplePermissionKind = NonNullable<PendingPermission['kind']>

/**
 * One pending permission of the requested kind. Field sets mirror what the
 * real gates emit (tool-executor permissionNeeded → AgentChat pendingPermissions).
 */
export function samplePermission(
  kind: SamplePermissionKind = 'paid_api',
  opts: { resolved?: 'allow' | 'deny' } = {},
): PendingPermission {
  const base: Record<SamplePermissionKind, PendingPermission> = {
    paid_api: {
      api: 'elevenlabs_tts',
      estimatedCost: '$0.05',
      toolName: 'add_narration',
      kind: 'paid_api',
      generationType: 'tts',
      prompt: 'Welcome to the quarterly review — three numbers tell the story.',
      provider: 'elevenlabs',
      // Two options so the confirmation card's provider dropdown renders.
      availableProviders: [
        { id: 'elevenlabs', name: 'ElevenLabs', cost: '$0.05', isFree: false },
        { id: 'openai-tts', name: 'OpenAI TTS', cost: '$0.02', isFree: false },
      ],
      toolArgs: { sceneId: 'showcase-scene-1', voice: 'narrator-m' },
    },
    mutation_preview: {
      api: 'mutation:delete_scene',
      estimatedCost: '$0.00',
      toolName: 'delete_scene',
      kind: 'mutation_preview',
      mutationScope: 'scene',
      reason: 'Removes scene "Old outro" and re-links its transitions.',
      toolArgs: { sceneId: 'showcase-scene-3', cascade: true },
    },
    web_search: {
      api: 'web_search',
      estimatedCost: '$0.01',
      toolName: 'request_web_search',
      kind: 'web_search',
      reason: 'Search the web for "Q3 2026 EV market share" to ground the chart data.',
    },
    biometric_consent: {
      api: 'voice_clone',
      estimatedCost: '$1.00',
      toolName: 'clone_voice',
      kind: 'biometric_consent',
      destination: 'ElevenLabs, Inc.',
      consentVersion: 'v2',
      voiceName: 'My narration voice',
      reason: 'Your 30s voice sample will be sent to ElevenLabs to create a reusable clone.',
    },
  }
  const perm = { ...base[kind] }
  if (opts.resolved) perm.resolved = opts.resolved
  return perm
}

// ── Plan (agentic plan surface) ──────────────────────────────────────

export function samplePlan(overrides?: Partial<AgentPlan>): AgentPlan {
  return {
    title: 'Build the Q3 recap video',
    createdAt: BASE_TS,
    body: [
      '## Approach',
      '',
      '1. **Opening title** — bold hook, 6s',
      '2. **Revenue chart** — animated bars with a Q3 callout, 10s',
      '3. **Outro CTA** — all-hands invite, 8s',
      '',
      'Narration throughout, light music bed, fade transitions.',
      'Total ~24s. Reply to revise anything before I build.',
    ].join('\n'),
    ...overrides,
  }
}

/** Todos in all four lifecycle states the plan card renders. */
export function samplePlanTodos(): AgentTodo[] {
  return [
    { id: 'showcase-todo-1', text: 'Write opening title scene', status: 'completed' },
    { id: 'showcase-todo-2', text: 'Build revenue bar chart', status: 'in_progress' },
    { id: 'showcase-todo-3', text: 'Add narration + music bed', status: 'pending' },
    { id: 'showcase-todo-4', text: 'Verify scene pedagogy', status: 'failed' },
  ]
}

// ── Structural cuts ──────────────────────────────────────────────────────────

export function sampleCuts(): StructuralCut[] {
  return [
    {
      sceneId: 'showcase-scene-2',
      sceneName: 'Revenue chart (duplicate)',
      detail: 'Repeats the same revenue figures as scene 1 with no new framing.',
      kind: 'redundancy',
    },
    {
      sceneId: 'showcase-scene-4',
      sceneName: 'Stats dump',
      detail: 'Eleven numbers on screen at once — none land. Scene 2 already carries the data story.',
      kind: 'redundancy',
    },
  ]
}

// ── Research sources ─────────────────────────────────────────────────────────

export function sampleSources(): ResearchSource[] {
  return [
    {
      url: 'https://example.com/ev-market-q3-2026',
      title: 'EV market share hits 31% in Q3 2026',
      snippet: 'Battery-electric vehicles accounted for 31% of new registrations…',
      provider: 'anthropic',
      toolUseId: 'showcase-tool-ws1',
    },
    {
      url: 'https://example.org/quarterly-auto-data',
      title: 'Quarterly auto registration data',
      provider: 'anthropic',
      toolUseId: 'showcase-tool-ws1',
    },
  ]
}

// ── Image attachment ─────────────────────────────────────────────────────────

/** 1×1 red PNG — the smallest valid attachment that exercises the lightbox path. */
export function sampleImageAttachment(): ImageAttachment {
  return {
    dataUri:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    mimeType: 'image/png',
    fileName: 'reference.png',
    width: 1,
    height: 1,
  }
}

// ── Message scaffolding ──────────────────────────────────────────────────────

let _msgCounter = 0

/**
 * Minimal deterministic ChatMessage scaffold. Callers layer card-driving
 * fields (toolCalls, pendingPermissions, flags) on top. The counter only
 * disambiguates ids WITHIN one fixture build; `resetSampleMessageIds()` makes
 * consecutive builds identical (determinism contract).
 */
export function sampleMessage(
  role: ChatMessage['role'],
  content: ChatMessage['content'],
  overrides?: Partial<ChatMessage>,
): ChatMessage {
  _msgCounter += 1
  return {
    id: `showcase-msg-${_msgCounter}`,
    role,
    content,
    timestamp: BASE_TS + _msgCounter * 60_000,
    ...overrides,
  }
}

export function resetSampleMessageIds(): void {
  _msgCounter = 0
}
