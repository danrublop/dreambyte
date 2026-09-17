import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import type { ToolCallRecord } from './types'

/**
 * Sandbox generation capture — the "review the prompts that would have been sent"
 * half of Sandbox mode.
 *
 * Sandbox already substitutes placeholders for paid generation (asset-gateway) so a
 * run costs nothing on the media keys. What it did NOT do is let you review the
 * generation-prompt QUALITY: the FINAL, enriched request each media tool would have
 * sent (image prompt + style/model/aspect, video provider+duration, TTS text+voice,
 * …) was never recorded anywhere reviewable — and the early sandbox forks even lost
 * the enriched prompt, keeping only the raw LLM arg.
 *
 * The mechanism is deliberately tiny: every media handler, in sandbox, stamps its
 * assembled request onto its ToolResult as `data.sandboxRequest` (a SandboxRequest).
 * Because ToolCallRecord.output IS that ToolResult, the request rides along in the
 * run's tool-call trace for free — no per-handler file I/O, no runId threading. At
 * run end (one call site in agent-runner) writeSandboxReview walks the trace and
 * emits a per-run review folder. No new subsystem, no DB, no hot-path writes.
 */

/** The final would-have-been-sent generation request, captured for review. */
export interface SandboxRequest {
  /** The tool that produced it, e.g. 'generate_image'. */
  tool: string
  /** The provider/model that WOULD have run it, e.g. 'flux-schnell', 'veo-3', 'heygen'. */
  provider?: string
  model?: string
  /** The FINAL, enriched prompt (post enrichPrompt/style clauses), not the raw arg. */
  prompt?: string
  /** Any other resolved request params worth reviewing (aspectRatio, duration, voiceId, …). */
  params?: Record<string, unknown>
  /** Optional human note, e.g. 'reference-style applied'. */
  note?: string
}

/** ~/.dreambyte/sandbox-runs — resolved lazily so tests can override $HOME (same
 *  convention as src/lib/memory/okf-view getMemoryBundleDir). */
export function getSandboxRunsDir(): string {
  return path.join(os.homedir(), '.dreambyte', 'sandbox-runs')
}

/** Pull the SandboxRequest off one tool call, if present. */
function requestOf(tc: ToolCallRecord): SandboxRequest | null {
  const data = tc.output?.data as { sandboxRequest?: SandboxRequest } | undefined
  const req = data?.sandboxRequest
  return req && typeof req === 'object' && typeof req.tool === 'string' ? req : null
}

/** Render the human-readable transcript. Full prompts, untruncated — the whole point
 *  is to review exactly what the model authored. */
export function renderSandboxTranscript(runId: string, reqs: SandboxRequest[]): string {
  const lines: string[] = [
    `# Sandbox run ${runId}`,
    ``,
    `${reqs.length} generation request(s) captured. No paid provider was called (placeholders substituted, $0).`,
    `Review the prompts below to judge generation-prompt quality.`,
    ``,
  ]
  reqs.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.tool}${r.provider ? ` → ${r.provider}` : ''}${r.model ? ` (${r.model})` : ''}`)
    if (r.note) lines.push(`_${r.note}_`)
    lines.push(``)
    if (r.prompt) {
      lines.push('**Prompt (would-have-been-sent):**', '', '```', r.prompt, '```', '')
    }
    if (r.params && Object.keys(r.params).length > 0) {
      lines.push('**Params:**', '', '```json', JSON.stringify(r.params, null, 2), '```', '')
    }
  })
  return lines.join('\n')
}

/**
 * Write the sandbox review folder for a finished run. Returns the count of captured
 * requests (0 → wrote nothing, so the caller can stay quiet) and the folder path.
 * Best-effort: a write failure never breaks the run — sandbox review is a
 * convenience, not a data path.
 */
export async function writeSandboxReview(
  runId: string,
  toolCalls: ToolCallRecord[],
): Promise<{ count: number; dir: string }> {
  const dir = path.join(getSandboxRunsDir(), runId)
  const reqs = toolCalls.map(requestOf).filter((r): r is SandboxRequest => r !== null)
  if (reqs.length === 0) return { count: 0, dir }
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'generations.json'), JSON.stringify(reqs, null, 2), 'utf8')
    await fs.writeFile(path.join(dir, 'transcript.md'), renderSandboxTranscript(runId, reqs), 'utf8')
  } catch {
    /* best-effort — never break a run over a review-artifact write */
  }
  return { count: reqs.length, dir }
}
