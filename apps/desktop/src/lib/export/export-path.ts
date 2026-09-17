/**
 * Single source of truth for the agent-export output filename:
 * `<dir>/<slug(projectName)>-<ISO stamp>.mp4`.
 *
 * PURE + SELF-CONTAINED on purpose: src/electron/main.ts injects this function's
 * SOURCE (`buildExportPath.toString()`) into the in-page export script, so
 * the renderer-side copy is semantically identical to this one and cannot
 * drift. Therefore: no imports, no closures, no references to anything
 * outside the function body — `toString()` must yield a standalone
 * executable function (export-path.test.ts pins this), AND
 * scripts/build/build-electron.mjs must never enable `minify` or `keepNames` (esbuild's
 * keepNames injects __name() calls INTO function bodies, which would make
 * the serialized copy reference a helper that doesn't exist in the page).
 */
export function buildExportPath(projectName: string | null | undefined, dirPath: string, now: Date): string {
  const slug =
    (projectName || 'dreambyte')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'dreambyte'
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return dirPath + '/' + slug + '-' + stamp + '.mp4'
}
