import { describe, it, expect } from 'vitest'
import { migratePublishedBeacons, MIGRATION_MARKER, type PublishedMigrationFs } from './published-beacon-migration'
import { stripErrorBeacon, buildErrorCaptureScript } from './agents/error-capture-shared'

const SCENE_ID = '12345678-1234-1234-1234-123456789abc'

/** Legacy pre-marker scene HTML: plain <script> beacon, no marker attribute. */
function legacyHtml(): string {
  return `<!DOCTYPE html><html><head>\n  <script>${buildErrorCaptureScript(SCENE_ID)}</script>\n</head><body>content</body></html>`
}

/** Legacy inline jsx-error post (the pre-2026-06-05 React bootstrap shape). */
const LEGACY_JSX_POST = `window.parent.postMessage({ source: 'dreambyte-scene', type: 'dreambyte-jsx-error', sceneId: SCENE_ID, message: e.message }, '*');`

function memFs(files: Record<string, string>, dirs: string[]): PublishedMigrationFs & { files: Record<string, string> } {
  const dirSet = new Set(dirs)
  return {
    files,
    readdir: async (dir) => {
      const prefix = `${dir}/`
      const names = new Set<string>()
      for (const p of [...Object.keys(files), ...dirSet]) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
    readFile: async (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: async (p, c) => {
      files[p] = c
    },
    exists: async (p) => p in files || dirSet.has(p),
    isDirectory: async (p) => dirSet.has(p),
  }
}

describe('stripErrorBeacon — legacy generations', () => {
  it('strips the legacy UNMARKED beacon (pre-marker scene HTML)', () => {
    const html = legacyHtml()
    const out = stripErrorBeacon(html)
    expect(out).not.toContain('var posted = 0')
    expect(out).not.toContain('dreambyte-runtime-error')
    expect(out).toContain('content') // body untouched
  })

  it('strips a pre-rename cench-era beacon (structure-pinned, not name-pinned)', () => {
    const cench = buildErrorCaptureScript(SCENE_ID).replace(/dreambyte-runtime-error/g, 'cench-runtime-error')
    const html = `<head><script>${cench}</script></head><body>x</body>`
    const out = stripErrorBeacon(html)
    expect(out).not.toContain('cench-runtime-error')
  })

  it('strips the legacy inline jsx-error post (both naming eras)', () => {
    const html = `<script>try { ${LEGACY_JSX_POST} } catch(ignore) {}</script>`
    const out = stripErrorBeacon(html)
    expect(out).not.toContain('jsx-error')
    expect(out).toContain('catch(ignore)') // surrounding code intact
    const cench = stripErrorBeacon(html.replace(/dreambyte-/g, 'cench-'))
    expect(cench).not.toContain('jsx-error')
  })

  it('does NOT swallow scene content that merely resembles the beacon', () => {
    // A script with the prefix but missing the listener skeleton must survive.
    const lookalike = `<script>\n(function () {\n  var posted = 0;\n  doSomethingElse();\n})();</script><script>real()</script>`
    expect(stripErrorBeacon(lookalike)).toBe(lookalike)
  })
})

describe('migratePublishedBeacons', () => {
  const base = '/published'
  const scenePath = `${base}/proj-1/scenes/${SCENE_ID}.html`

  it('rewrites only files the strip changes, then stamps the marker', async () => {
    const clean = '<html><head></head><body>already clean</body></html>'
    const fs = memFs(
      {
        [scenePath]: legacyHtml(),
        [`${base}/proj-2/scenes/${SCENE_ID}.html`]: clean,
      },
      [base, `${base}/proj-1`, `${base}/proj-1/scenes`, `${base}/proj-2`, `${base}/proj-2/scenes`],
    )
    const result = await migratePublishedBeacons({ publishedDir: base, fs, join: (...p) => p.join('/') })
    expect(result).toMatchObject({ migrated: 1, scanned: 2, skipped: false, failed: 0 })
    expect(fs.files[scenePath]).not.toContain('var posted = 0')
    expect(fs.files[`${base}/proj-2/scenes/${SCENE_ID}.html`]).toBe(clean) // untouched
    expect(fs.files[`${base}/${MIGRATION_MARKER}`]).toBeTruthy()
  })

  it('is one-shot: the marker short-circuits the next run', async () => {
    const fs = memFs({ [`${base}/${MIGRATION_MARKER}`]: 'done', [scenePath]: legacyHtml() }, [
      base,
      `${base}/proj-1`,
      `${base}/proj-1/scenes`,
    ])
    const result = await migratePublishedBeacons({ publishedDir: base, fs, join: (...p) => p.join('/') })
    expect(result.skipped).toBe(true)
    expect(result.scanned).toBe(0)
    expect(fs.files[scenePath]).toContain('var posted = 0') // untouched
  })

  it('ignores non-scene-id files and missing published dir', async () => {
    const fs = memFs({ [`${base}/proj-1/scenes/index.html`]: legacyHtml() }, [
      base,
      `${base}/proj-1`,
      `${base}/proj-1/scenes`,
    ])
    const result = await migratePublishedBeacons({ publishedDir: base, fs, join: (...p) => p.join('/') })
    expect(result.scanned).toBe(0) // not scene-id shaped

    const empty = memFs({}, [])
    const r2 = await migratePublishedBeacons({ publishedDir: '/nope', fs: empty, join: (...p) => p.join('/') })
    expect(r2).toMatchObject({ migrated: 0, scanned: 0, skipped: false })
    expect(empty.files['/nope/' + MIGRATION_MARKER]).toBeUndefined() // no marker on absent dir
  })

  it('a per-file failure is swallowed and BLOCKS the marker (retry next boot)', async () => {
    const fs = memFs({ [scenePath]: legacyHtml() }, [base, `${base}/proj-1`, `${base}/proj-1/scenes`])
    const failingFs: PublishedMigrationFs = {
      ...fs,
      readFile: async () => {
        throw new Error('EACCES')
      },
    }
    const result = await migratePublishedBeacons({ publishedDir: base, fs: failingFs, join: (...p) => p.join('/') })
    expect(result.failed).toBe(1)
    expect(fs.files[`${base}/${MIGRATION_MARKER}`]).toBeUndefined()
  })
})
