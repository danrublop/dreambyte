// @vitest-environment node

// Stale-gate (P4): .agents/skills/dreambyte/rules MUST be a byte
// mirror of the canonical .claude bundle. (pipelines/ was deleted entirely.) If this fails, run `npm run gen:okf-mirror`.
// This is what keeps the .claude ↔ .agents drift (the "MCP worked but in-app
// didn't" root cause) from ever coming back.

import { describe, it, expect } from 'vitest'
import { allMirrorDrift } from '../../../../scripts/okf/gen-okf-mirror'

describe('OKF .agents mirror stale-gate', () => {
  it('.agents knowledge dirs match the canonical .claude bundle', () => {
    const drift = allMirrorDrift()
    expect(drift, `.agents is stale — run \`npm run gen:okf-mirror\`:\n${drift.join('\n')}`).toEqual([])
  })
})
