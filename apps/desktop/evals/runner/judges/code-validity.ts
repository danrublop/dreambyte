/**
 * Code-validity judge: reuses the same `quickValidateScene` the agent's
 * tool-executor calls after every generation tool. If a generation produces
 * code that the runtime would flag with EMPTY/MINIMAL/etc warnings, this
 * judge fails it.
 *
 * Pass criterion: zero warnings whose severity prefix is in HARD_FAIL_PREFIXES.
 * Soft warnings (e.g. MINIMAL) are reported but don't fail the case.
 */

import type { Scene } from '@/lib/types'
import { quickValidateScene } from '@/lib/agents/tool-executor'

export interface CodeValidityResult {
  passed: boolean
  warnings: string[]
  hardFailures: string[]
  softWarnings: string[]
}

const HARD_FAIL_PREFIXES = ['EMPTY:', 'INVALID:', 'BROKEN:'] as const

export function judgeCodeValidity(scene: Scene): CodeValidityResult {
  const warnings = quickValidateScene(scene)
  const hardFailures = warnings.filter((w) => HARD_FAIL_PREFIXES.some((p) => w.startsWith(p)))
  const softWarnings = warnings.filter((w) => !HARD_FAIL_PREFIXES.some((p) => w.startsWith(p)))
  return {
    passed: hardFailures.length === 0,
    warnings,
    hardFailures,
    softWarnings,
  }
}
