import type { PermissionCallDetails, RuleSpecifier } from '../types/permissions'

/** Does `specifier` apply to a call with `call` details?
 *  Null/empty specifier matches any call. Unset specifier fields match any value. */
export function matchSpecifier(specifier: RuleSpecifier | null, call: PermissionCallDetails): boolean {
  if (!specifier) return true

  if (specifier.provider !== undefined && specifier.provider !== call.provider) return false
  if (specifier.model !== undefined && specifier.model !== call.model) return false

  if (specifier.durationMax !== undefined) {
    if (call.duration === undefined || call.duration > specifier.durationMax) return false
  }
  if (specifier.durationMin !== undefined) {
    if (call.duration === undefined || call.duration < specifier.durationMin) return false
  }

  // costMax on specifier means "rule only applies to calls at or below this cost".
  // Costs above cap are handled by evaluator's cost-cap escalation, not by exclusion.
  if (specifier.costMax !== undefined) {
    if (call.estimatedCostUsd === undefined || call.estimatedCostUsd > specifier.costMax) {
      return false
    }
  }

  const prompt = (call.prompt ?? '').toLowerCase()
  if (specifier.promptContains?.length) {
    for (const needle of specifier.promptContains) {
      if (!prompt.includes(needle.toLowerCase())) return false
    }
  }
  if (specifier.promptNotContains?.length) {
    for (const needle of specifier.promptNotContains) {
      if (prompt.includes(needle.toLowerCase())) return false
    }
  }

  return true
}
