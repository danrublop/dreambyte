import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guard for the scenePlan system-prompt refresh latch.
 *
 * THE BUG THIS EXISTS FOR: the Anthropic loop used to gate its prompt refresh on
 *
 *     world.scenePlan && allToolCalls.some((tc) => tc.toolName === 'plan_scenes')
 *
 * `allToolCalls` never shrinks, so once plan_scenes ran that test stayed true for
 * every remaining turn — rebuilding and re-sending a ~30k-token system prefix on
 * each one, busting the prompt cache to deliver a delta that was sometimes a few
 * characters. The OpenAI loop had always used the `scenePlanContextInjected` latch
 * correctly; only the Anthropic twin diverged, which is why it survived review.
 *
 * WHY THIS IS A SOURCE ASSERTION AND NOT A BEHAVIORAL TEST: the refresh lives deep
 * inside runAgent's ~5.8k-line closure with no exported seam, and discriminating the
 * two versions requires plan_scenes to actually store a plan mid-run — which needs
 * the real handler and its DB writes. runner.integration.test.ts deliberately does
 * not run real tool side effects. Seeding opts.initialScenePlan instead does not
 * discriminate: it sets the latch true at declaration, and the old monotonic
 * condition is equally false when plan_scenes never fires.
 *
 * So this asserts the shape instead: both provider loops latch, and the monotonic
 * pattern is gone. Replace it with a real assertion on refresh count if runAgent
 * ever grows a testable seam.
 * Shape assertion, upgrade to behavioral if runner.ts gets decomposed
 */
describe('scenePlan prompt-refresh latch', () => {
  const runnerSrc = readFileSync(join(__dirname, 'runner.ts'), 'utf8')

  it('never gates a prompt refresh on the monotonic allToolCalls scan', () => {
    // allToolCalls is append-only; any refresh keyed off it fires forever.
    const monotonic = /allToolCalls\.some\(\s*\(tc\)\s*=>\s*tc\.toolName === 'plan_scenes'\s*\)/g
    expect(runnerSrc.match(monotonic)).toBeNull()
  })

  it('latches the provider loop on scenePlanContextInjected', () => {
    // There is ONE provider loop (every provider goes through its adapter).
    const guarded = runnerSrc.match(/if \(world\.scenePlan && !scenePlanContextInjected\)/g) ?? []
    expect(guarded).toHaveLength(1)

    // A guard that never sets the flag would refresh every turn regardless.
    const setsLatch = runnerSrc.match(/^\s*scenePlanContextInjected = true$/gm) ?? []
    expect(setsLatch).toHaveLength(1)
  })

  it('still resets the latch so a re-plan refreshes again', () => {
    // Without this, a second plan_scenes would leave the prompt describing the
    // stale plan for the rest of the run — the opposite failure.
    expect(runnerSrc).toMatch(/^\s*scenePlanContextInjected = false$/m)
  })
})
