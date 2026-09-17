#!/usr/bin/env node
// Smoke test for the published @dreambyte/motion-dsl package.
//
// Imports from dist/ via the package's exports map, exercises the public
// surface with one preset MotionRef end-to-end through the React adapter,
// and asserts the output looks right. If this fails, the published bundle
// is broken — independent of the in-tree vitest suite.
//
// Run via: npm run motion-dsl:smoke (root) or `node scripts/smoke-test.mjs`.

import { compileMotionRefToStyleAt } from '../dist/compiler/react.js'
import { getMotionPreset, listMotionPresets, MOTION_PRESET_IDS } from '../dist/index.js'
import { validateMotionRef } from '../dist/index.js'

function ok(label, cond) {
  if (!cond) {
    console.error(`FAIL ${label}`)
    process.exit(1)
  }
  console.log(`OK   ${label}`)
}

ok(`MOTION_PRESET_IDS has 56 presets`, MOTION_PRESET_IDS.length === 56)

const fadeInUp = getMotionPreset('fadeInUp')
ok(`getMotionPreset('fadeInUp') resolves`, fadeInUp != null)
ok(`getMotionPreset returns matching id`, fadeInUp?.id === 'fadeInUp')

const entrance = listMotionPresets({ category: 'entrance' })
ok(`listMotionPresets({category:'entrance'}) returns 28+`, entrance.length >= 28)

const validation = validateMotionRef({ kind: 'preset', preset: 'fadeInUp' })
ok(`validateMotionRef accepts a known preset`, validation.ok === true)

const bad = validateMotionRef({ kind: 'preset', preset: 'fadInUp' })
ok(`validateMotionRef rejects a typo`, bad.ok === false)
ok(
  `validateMotionRef returns close-match suggestions`,
  Array.isArray(bad.suggestions) && bad.suggestions.includes('fadeInUp'),
)

const styleStart = compileMotionRefToStyleAt({ kind: 'preset', preset: 'fadeInUp', durationFrames: 30 }, undefined, 0)
ok(`compileMotionRefToStyleAt opacity at frame 0 is 0`, styleStart.opacity === 0)
ok(
  `compileMotionRefToStyleAt transform at frame 0 includes 60px`,
  typeof styleStart.transform === 'string' && styleStart.transform.includes('60px'),
)

const styleEnd = compileMotionRefToStyleAt({ kind: 'preset', preset: 'fadeInUp', durationFrames: 30 }, undefined, 60)
ok(`compileMotionRefToStyleAt opacity past end is 1`, styleEnd.opacity === 1)

console.log('\n@dreambyte/motion-dsl smoke test: all assertions passed.')
