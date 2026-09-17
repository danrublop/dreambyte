/**
 * v5 A3 source parity: the base/imported-file fallback must be gated ONLY on
 * the tts slot being empty — in BOTH track builders (the electron tier3 one
 * and the render-server web-fallback one). The old guard also required no
 * music/sfx, so a scene with a file PLUS music silently dropped the file at
 * export while preview and pixi both played it.
 *
 * Same source-parity style as cap-checkpoint.test.ts: read the source, pin the
 * guard's shape so a refactor can't quietly re-tighten it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8')

describe('v5 A3: file-audio fallback guard shape', () => {
  it.each([['src/electron/ipc/export-tier3.ts']])(
    '%s: the isFile fallback requires ONLY an empty tts slot',
    (file) => {
      const src = read(file)
      // The guard line that feeds the isFile tag: starts with the empty-slot
      // check and ends with the audioLayer.src condition.
      const guards = src.match(/if \(!audioTracks\.tts &&[^\n]*audioLayer\.src[^\n]*\) \{/g) ?? []
      expect(guards.length).toBe(1)
      // The v5 A3 fix: music/sfx presence must NOT suppress the file lane.
      expect(guards[0]).not.toContain('music')
      expect(guards[0]).not.toContain('sfx')
      // …and the tag itself is still applied inside that block.
      expect(src).toContain('isFile: true')
    },
  )

  it('the ducking gate excludes isFile sources (narration-only feature)', () => {
    const src = read('../../packages/render-server/audio-filter.js')
    const gateStart = src.indexOf('const hasDucking')
    const gate = src.slice(gateStart, src.indexOf(')', src.indexOf('!_drop(ttsMix)', gateStart)))
    expect(gate).toContain('!audioTracks.tts.isFile')
  })
})
