import type { PermissionContext, PermissionEvalResult, PermissionRule, SpendState } from '../types/permissions'
import { SCOPE_PRECEDENCE } from '../types/permissions'
import { matchSpecifier } from './specifier-matcher'

/** Pure evaluation — given a call context and the set of rules known to apply
 *  to this user/workspace/project/conversation, return the decision.
 *
 *  Caller is responsible for fetching matching rules from the DB (scope-filter
 *  query). This function does no IO so it's trivially unit-testable.
 *
 *  Decision order (Claude-Code-style deny-wins):
 *    1. Session/monthly spend caps → hard deny.
 *    2. Filter rules whose `specifier` matches the call.
 *    3. If any matching rule is `deny` → deny.
 *    4. If any matching rule has `costCapUsd` and the estimate exceeds → ask.
 *    5. If any matching rule is `allow` → allow (highest-scope precedence).
 *    6. If any matching rule is `ask` → ask (explicit escalation).
 *    7. Default → ask.
 */
export function evaluatePermission(
  ctx: PermissionContext,
  rules: PermissionRule[],
  spendState: SpendState,
): PermissionEvalResult {
  // 1. Spend caps — no rule can override these.
  if (spendState.sessionLimit !== null && spendState.sessionSpend >= spendState.sessionLimit) {
    return {
      action: 'deny',
      reason: `Session spend limit reached ($${spendState.sessionSpend.toFixed(2)} / $${spendState.sessionLimit.toFixed(2)})`,
      matchedRuleId: null,
    }
  }
  if (spendState.monthlyLimit !== null && spendState.monthlySpend >= spendState.monthlyLimit) {
    return {
      action: 'deny',
      reason: `Monthly spend limit reached ($${spendState.monthlySpend.toFixed(2)} / $${spendState.monthlyLimit.toFixed(2)})`,
      matchedRuleId: null,
    }
  }

  const now = Date.now()

  // 2. Keep only rules that (a) target this API (or *), (b) aren't expired,
  //    (c) match the specifier against the call details.
  const matching = rules.filter((r) => {
    if (r.api !== '*' && r.api !== ctx.api) return false
    if (r.expiresAt && r.expiresAt.getTime() <= now) return false
    return matchSpecifier(r.specifier, ctx.call)
  })

  // 3. Deny-wins.
  const deny = matching.find((r) => r.decision === 'deny')
  if (deny) {
    return {
      action: 'deny',
      reason: deny.notes ?? `Blocked by a ${deny.scope}-scope rule for ${deny.api === '*' ? 'all APIs' : deny.api}.`,
      matchedRuleId: deny.id,
    }
  }

  // 4. Cost-cap escalation. If a rule carries costCapUsd and the call exceeds
  //    it, force a prompt even if another rule would auto-allow.
  const estimate = ctx.call.estimatedCostUsd ?? 0
  const overCap = matching.find((r) => r.costCapUsd !== null && estimate > r.costCapUsd)
  if (overCap) {
    return {
      action: 'ask',
      reason: `Estimated $${estimate.toFixed(2)} exceeds the $${overCap.costCapUsd!.toFixed(2)} cap on a ${overCap.scope}-scope rule.`,
      costTriggered: true,
      matchedRuleId: overCap.id,
    }
  }

  // 5. Highest-precedence allow wins over ask. (Session scope = lowest number
  //    = highest priority in our convention.)
  const allow = pickHighestScope(matching.filter((r) => r.decision === 'allow'))
  if (allow) return { action: 'allow', matchedRuleId: allow.id }

  // 6. Explicit ask rule (user wants to always confirm this API even though
  //    a broader allow exists at a lower-priority scope).
  const ask = pickHighestScope(matching.filter((r) => r.decision === 'ask'))
  if (ask) {
    return {
      action: 'ask',
      reason: ask.notes ?? `A ${ask.scope}-scope rule requires confirmation.`,
      costTriggered: false,
      matchedRuleId: ask.id,
    }
  }

  // 7. No opinion → prompt.
  return {
    action: 'ask',
    reason: 'No matching permission rule — asking for approval.',
    costTriggered: false,
    matchedRuleId: null,
  }
}

function pickHighestScope(rules: PermissionRule[]): PermissionRule | null {
  if (rules.length === 0) return null
  return rules.reduce((best, r) => (SCOPE_PRECEDENCE[r.scope] < SCOPE_PRECEDENCE[best.scope] ? r : best))
}
