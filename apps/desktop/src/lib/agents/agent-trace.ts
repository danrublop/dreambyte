import os from 'os'
import path from 'path'
import fsSync from 'fs'
import { promises as fs } from 'fs'

/**
 * Agent-run audit trace — the "exactly what was said to the model, each turn"
 * capture that nothing else records.
 *
 * The Sandbox transcript (sandbox-capture.ts) only records MEDIA generation
 * prompts. `generation_logs.system_prompt_snapshot` is a dead column (no caller
 * fills it) and `run_trace` stores the system prompt's LENGTH but throws away the
 * text. So there was no way to review the actual assembled system prompt (with all
 * the injected OKF/craft mds, skill bodies, design-principles, mandate) or the
 * per-turn conversation.
 *
 * Mechanism, deliberately tiny and off the hot path: the runner pushes one
 * snapshot per turn — `{ iteration, systemPrompt, messages: [...messages] }` — at
 * iteration start (a shallow array copy, so later in-place compaction can't erase
 * an already-captured turn). Two writers, both to ~/.dreambyte/agent-runs/<runId>/:
 *
 *  1. createTraceAppender — the DURABLE one. Appends each turn's DELTA to
 *     transcript.md (and a new section to system-prompt.md only when the prompt
 *     changed) synchronously as the turn starts. A SIGKILL / force-quit / power
 *     loss keeps everything up to the last completed turn. This is the reason the
 *     trace exists at all: it is the primary audit source for a run, and a run
 *     that dies is exactly the one worth auditing.
 *  2. writeAgentTrace — the batch renderer, still called in the runner's
 *     `finally`. It rewrites both files in their canonical collapsed form
 *     (`## Turns 3–7`, which an append-only writer can't back-patch). Purely
 *     cosmetic now; the appender already has the content.
 *
 * Cost: ONE appendFileSync per turn per file, carrying only that turn's new
 * messages — not per token, and not the O(turns²) full rewrite the old
 * DREAMBYTE_TRACE_LIVE flag did. A few KB of sync IO on a boundary that just
 * finished a multi-second network round-trip. Best-effort throughout: a write
 * failure never breaks a run.
 */

/** One per-turn snapshot: the system prompt in force + the full conversation as of
 *  that turn's start. `messages` is the runner's internal message array (shape
 *  varies by provider); rendered generically, not typed, on purpose. */
export interface AgentTraceTurn {
  iteration: number
  systemPrompt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
}

/** ~/.dreambyte/agent-runs — resolved lazily so tests can override $HOME (same
 *  convention as sandbox-capture getSandboxRunsDir). */
export function getAgentRunsDir(): string {
  return path.join(os.homedir(), '.dreambyte', 'agent-runs')
}

const systemPromptHeader = (runId: string): string[] => [
  `# Agent run ${runId} — system prompts`,
  ``,
  `The FULL assembled system prompt handed to the model, including every injected`,
  `OKF/craft md, skill body, design-principle, and the mandate. One section per`,
  `DISTINCT prompt (collapsed when unchanged across turns).`,
  ``,
]

const transcriptHeader = (runId: string): string[] => [
  `# Agent run ${runId} — transcript`,
  ``,
  `Exactly what was exchanged with the model, in order. Snapshots are taken at each`,
  `turn's start, so a turn block contains the model's reply to the previous turn`,
  `(assistant text + tool calls) followed by the tool results fed back. See`,
  `system-prompt.md for the system prompt in force at each turn.`,
  ``,
]

/** system-prompt.md — every DISTINCT assembled system prompt, verbatim and
 *  untruncated, tagged with the turn range it applied to. Consecutive identical
 *  prompts are collapsed (the prompt is stable across most turns; it changes on a
 *  scenePlan/context refresh), so a rebuild shows up as a new section. */
export function renderSystemPrompts(runId: string, turns: AgentTraceTurn[]): string {
  const out: string[] = systemPromptHeader(runId)
  let prev: string | null = null
  let start = 0
  const flush = (endIter: number) => {
    if (prev == null) return
    out.push(`## Turns ${start}–${endIter} (${prev.length} chars)`, ``, '````````text', prev, '````````', ``)
  }
  for (const t of turns) {
    if (t.systemPrompt !== prev) {
      flush(turns[turns.indexOf(t) - 1]?.iteration ?? start)
      prev = t.systemPrompt
      start = t.iteration
    }
  }
  flush(turns[turns.length - 1]?.iteration ?? start)
  return out.join('\n')
}

/** Render one message generically: role header, text/JSON content, and any tool
 *  calls (name + args) — the model's OUTPUT rides in the assistant/tool messages. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMessage(m: any): string[] {
  const role = String(m?.role ?? 'unknown')
  const lines = [`### ${role}`]
  const content = m?.content
  if (typeof content === 'string') {
    if (content.trim()) lines.push('', content)
  } else if (content != null) {
    lines.push('', '```json', JSON.stringify(content, null, 2), '```')
  }
  // OpenAI-style tool calls on an assistant message.
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
    lines.push('', '**tool calls:**')
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name ?? tc?.name ?? 'tool'
      const args = tc?.function?.arguments ?? tc?.input ?? ''
      lines.push('', `- \`${name}\``, '```json', typeof args === 'string' ? args : JSON.stringify(args, null, 2), '```')
    }
  }
  lines.push('')
  return lines
}

/** transcript.md — the conversation as it actually grew, turn by turn. Snapshots
 *  are taken at each turn's START, so a turn block shows the messages that became
 *  present since the previous turn: that includes the PRIOR turn's model reply
 *  (assistant text + tool calls) and its tool results, plus any refresh message.
 *  When the array shrinks, an in-flight compaction happened — marked, and the new
 *  compacted baseline is rendered in full once. */
export function renderTranscript(runId: string, turns: AgentTraceTurn[]): string {
  const out: string[] = transcriptHeader(runId)
  let prevLen = 0
  for (const t of turns) {
    out.push(...transcriptTurnBlock(t, prevLen))
    prevLen = (t.messages ?? []).length
  }
  return out.join('\n')
}

/** One turn's transcript block, given how many messages the PREVIOUS turn had.
 *  Shared by the batch renderer and the incremental appender so the two can
 *  never drift. A shrinking array means an in-flight compaction happened — mark
 *  it and re-render the new baseline in full once. */
function transcriptTurnBlock(t: AgentTraceTurn, prevLen: number): string[] {
  const msgs = t.messages ?? []
  const out: string[] = []
  if (msgs.length < prevLen) {
    out.push(`\n> ⟪ in-flight compaction — history compressed ${prevLen} → ${msgs.length} messages ⟫\n`)
    out.push(`## Turn ${t.iteration} (post-compaction baseline)`, ``)
    for (const m of msgs) out.push(...renderMessage(m))
    return out
  }
  const delta = msgs.slice(prevLen)
  out.push(`## Turn ${t.iteration}`, ``)
  if (delta.length === 0) out.push('_(no new messages)_', '')
  for (const m of delta) out.push(...renderMessage(m))
  return out
}

/** Crash-safe incremental writer. `push` one snapshot per turn; each call appends
 *  only that turn's delta, synchronously, so a process death keeps everything up
 *  to the last completed turn. Header format differs slightly from the batch
 *  renderer: an append-only file can't back-patch a section's END turn, so the
 *  system-prompt sections are headed `## From turn N` instead of `## Turns N–M`.
 *  The finally-time writeAgentTrace rewrites both files in the canonical form. */
export interface AgentTraceAppender {
  push(turn: AgentTraceTurn): void
}

export function createTraceAppender(runId: string): AgentTraceAppender {
  const dir = path.join(getAgentRunsDir(), runId)
  const sysPath = path.join(dir, 'system-prompt.md')
  const txPath = path.join(dir, 'transcript.md')
  let started = false
  let prevPrompt: string | null = null
  let prevLen = 0
  return {
    push(t: AgentTraceTurn) {
      try {
        if (!started) {
          fsSync.mkdirSync(dir, { recursive: true })
          fsSync.writeFileSync(sysPath, systemPromptHeader(runId).join('\n'), 'utf8')
          fsSync.writeFileSync(txPath, transcriptHeader(runId).join('\n'), 'utf8')
          started = true
        }
        if (t.systemPrompt !== prevPrompt) {
          const section = [
            `## From turn ${t.iteration} (${t.systemPrompt.length} chars)`,
            ``,
            '````````text',
            t.systemPrompt,
            '````````',
            ``,
            ``,
          ]
          fsSync.appendFileSync(sysPath, section.join('\n'), 'utf8')
          prevPrompt = t.systemPrompt
        }
        fsSync.appendFileSync(txPath, transcriptTurnBlock(t, prevLen).join('\n') + '\n', 'utf8')
        prevLen = (t.messages ?? []).length
      } catch {
        /* best-effort — an audit-artifact write must never break a run */
      }
    },
  }
}

/**
 * Write the audit trace for a finished (or crashed) run. Returns the turn count and
 * folder path. Best-effort: never throws — an audit-artifact write must not break a
 * run. Full messages per snapshot means disk grows with (turns × history);
 * fine for local dev debugging, cap or gate behind an env flag if it ever bites.
 */
export async function writeAgentTrace(runId: string, turns: AgentTraceTurn[]): Promise<{ turns: number; dir: string }> {
  const dir = path.join(getAgentRunsDir(), runId)
  if (!turns || turns.length === 0) return { turns: 0, dir }
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'system-prompt.md'), renderSystemPrompts(runId, turns), 'utf8')
    await fs.writeFile(path.join(dir, 'transcript.md'), renderTranscript(runId, turns), 'utf8')
  } catch {
    /* best-effort — never break a run over an audit-artifact write */
  }
  return { turns: turns.length, dir }
}
