// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { buildExportPath } from './export-path'

const NOW = new Date('2026-06-06T12:34:56.789Z')

describe('buildExportPath', () => {
  it('slugs the project name and stamps the ISO time (colons/dots → dashes)', () => {
    expect(buildExportPath('My Cool Video!', '/Users/x/Downloads', NOW)).toBe(
      '/Users/x/Downloads/my-cool-video-2026-06-06T12-34-56-789Z.mp4',
    )
  })

  it('falls back to "dreambyte" for empty/missing/all-symbol names and caps at 40 chars', () => {
    expect(buildExportPath(null, '/d', NOW)).toContain('/d/dreambyte-')
    expect(buildExportPath('!!!', '/d', NOW)).toContain('/d/dreambyte-')
    const long = buildExportPath('x'.repeat(80), '/d', NOW)
    expect(long).toContain(`/d/${'x'.repeat(40)}-`)
  })

  it('is self-contained: its source is executable standalone (the main.ts toString injection contract)', () => {
    // src/electron/main.ts injects buildExportPath.toString() into the in-page
    // export script — if the function ever captures an import or closure,
    // the injected copy breaks at runtime. Pin it.
    // SECURITY NOTE: the only string entering new Function() is THIS MODULE'S
    // own compiled function source (buildExportPath.toString()) — a build-time
    // constant, never user/external input — mirroring exactly what main.ts
    // executes. No untrusted interpolation occurs here.
    // eslint-disable-next-line no-new-func
    const standalone = new Function(`return (${buildExportPath.toString()})`)() as typeof buildExportPath
    expect(standalone('Drift Check', '/tmp', NOW)).toBe(buildExportPath('Drift Check', '/tmp', NOW))
  })
})
