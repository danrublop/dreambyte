/**
 * Load the bundled SFX library manifest from disk (main process / Node) and resolve
 * its base path across dev + packaged Electron — so the agent can search the in-repo
 * library at runtime, $0/offline.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SfxLocalManifest } from './sfx-local-manifest'

let cached: { manifest: SfxLocalManifest | null; path: string | null } | null = null

/** Resolve <sfx-library>/manifest.json across public/ (dev), out/ (built), and the packaged asar. */
export function resolveSfxManifestPath(): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const rel = join('sfx-library', 'manifest.json')
  const candidates = [
    process.env.DREAMBYTE_SFX_MANIFEST,
    join(process.cwd(), 'public', rel),
    join(process.cwd(), 'out', rel),
    resourcesPath ? join(resourcesPath, 'app.asar', 'out', rel) : undefined,
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'out', rel) : undefined,
    resourcesPath ? join(resourcesPath, 'app', 'out', rel) : undefined,
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Load + cache the bundled SFX manifest. Returns null if it can't be found/parsed. */
export function loadLocalSfxManifest(): SfxLocalManifest | null {
  if (cached) return cached.manifest
  const path = resolveSfxManifestPath()
  let manifest: SfxLocalManifest | null = null
  if (path) {
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as SfxLocalManifest
    } catch {
      manifest = null
    }
  }
  cached = { manifest, path }
  return manifest
}
