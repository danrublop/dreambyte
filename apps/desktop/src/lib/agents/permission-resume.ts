/**
 * Permission decision → resume instruction.
 *
 * When the user resolves a permission card, the paused run must RESUME (both on
 * approve AND deny). The approve path replays the gated tool call; the deny path
 * must NOT replay it — it resumes with a denial instruction that tells the model
 * to adapt (use a free alternative or explain the limitation). Pure + exported
 * so the exact wording (which the model keys on) is unit-testable.
 */

/** The resume `messageContent` after the user DENIES a permission. */
export function buildDenialResumeMessage(toolName: string, api: string): string {
  return (
    `The user DENIED permission for ${toolName} (${api}). ` +
    `Do not retry it — adapt: use a free alternative or explain to the user what can't be done without it.`
  )
}
