import type { IpcMain } from 'electron'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import type { PublishedProject, PublishedScene } from '@/lib/types'
import { normalizeTransition } from '@/lib/transitions'
import { assertValidUuid, loadProjectOrThrow, IpcValidationError } from './_helpers'
import { resolveScenesDir } from '@/lib/scene-html-paths'
import { stripErrorBeacon } from '@/lib/agents/error-capture-shared'
import { rewriteAnimeForEmbed } from '@/lib/scene-html/anime-head'
import { rebuildLegacySceneHtml } from '@/lib/sceneTemplate'
import { stripSceneCsp } from '@/lib/security/scene-csp'
import { buildPublishedIndexHtml } from './publish-index'

/**
 * Category: publish
 *
 * Writes a `published/<projectId>/` bundle
 * under `public/` (dev) or `<userData>/published/` (packaged). Copies
 * scene HTML files from the scenes dir, copies uploads, writes a
 * `manifest.json` for the published viewer.
 *
 * The desktop app does not serve the bundle — whatever HTTP host renders the
 * published viewer does. That's why this IPC just writes files.
 */


function publishBase(): string {
  const override = process.env.DREAMBYTE_PUBLISHED_DIR
  if (override) return override
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'published')
    : path.join(process.cwd(), 'public', 'published')
}

function uploadsDir(): string {
  const override = process.env.DREAMBYTE_UPLOADS_DIR
  if (override) return override
  return app.isPackaged ? path.join(app.getPath('userData'), 'uploads') : path.join(process.cwd(), 'public', 'uploads')
}

/** Built @dreambyte/player IIFE (`npm run build:player`); shipped as player/player.js in packaged builds. */
export function playerBundlePath(isPackaged = app.isPackaged): string {
  return isPackaged
    ? path.join(process.resourcesPath, 'player', 'player.js')
    : path.join(__dirname, '..', '..', '..', 'packages', 'player', 'dist', 'dreambyte-player.iife.js')
}

type PublishArgs = {
  project: {
    id: string
    name?: string
    interactiveSettings?: {
      playerTheme?: 'dark' | 'light'
      showProgressBar?: boolean
      showSceneNav?: boolean
      allowFullscreen?: boolean
      brandColor?: string
    }
    sceneGraph: PublishedProject['sceneGraph']
  }
  scenes: Array<{
    id: string
    sceneType?: string
    duration: number
    interactions?: unknown[]
    variables?: unknown[]
    transition?: unknown
  }>
  globalStyle?: unknown
}

async function publish(args: PublishArgs) {
  if (!args.project?.id || !args.scenes?.length) {
    throw new IpcValidationError('Missing project or scenes')
  }
  await loadProjectOrThrow(args.project.id)

  const publishDir = path.join(publishBase(), args.project.id)
  const scenesDir = path.join(publishDir, 'scenes')
  const assetsDir = path.join(publishDir, 'assets')
  await fs.mkdir(scenesDir, { recursive: true })
  await fs.mkdir(assetsDir, { recursive: true })

  const publishedScenes: PublishedScene[] = []
  const missingSceneIds: string[] = []
  const srcScenesDir = resolveScenesDir()

  for (const scene of args.scenes) {
    // Block path traversal: scene.id reaches `path.join(srcScenesDir, ${scene.id}.html)`.
    // Without a UUID check, a renderer sending scene.id = "../../etc/passwd"
    // resolves to an arbitrary location and we'd happily `copyFile` it
    // under the published bundle. UUID-gate + prefix-check belt-and-suspenders.
    assertValidUuid(scene.id, 'scene.id')
    const srcPath = path.resolve(path.join(srcScenesDir, `${scene.id}.html`))
    const destPath = path.resolve(path.join(scenesDir, `${scene.id}.html`))
    if (!srcPath.startsWith(srcScenesDir + path.sep) || !destPath.startsWith(scenesDir + path.sep)) {
      throw new IpcValidationError('Invalid scene id (path escape)')
    }
    try {
      await fs.access(srcPath)
    } catch {
      console.warn(`[publish] Scene HTML missing: ${scene.id}.html`)
      missingSceneIds.push(scene.id)
      continue
    }
    try {
      // Published embeds run with a third-party parent page — strip the
      // error beacon (its postMessage('*') would broadcast scene error
      // strings to the host) instead of copying the editor HTML verbatim.
      // The editor HTML loads anime.js local-vendor-first (/vendor/animejs/*),
      // which 404s off the app server — rewrite it to CDN-first for the embed.
      // Strip the editor error beacon AND the desktop scene-CSP meta
      // (published embeds run on a third-party page with a different network/asset
      // model than the dreambyte:// desktop scheme — the desktop connect-src
      // allowlist would wrongly block the embed's own host/analytics).
      // Pre-anime.js HTML on disk becomes the regenerate placeholder (never a CDN runtime).
      const html = rebuildLegacySceneHtml(await fs.readFile(srcPath, 'utf8'))
      await fs.writeFile(destPath, rewriteAnimeForEmbed(stripSceneCsp(stripErrorBeacon(html))), 'utf8')
    } catch (e) {
      console.error(`[publish] Failed to copy scene HTML for ${scene.id}:`, e)
      missingSceneIds.push(scene.id)
      continue
    }
    publishedScenes.push({
      id: scene.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: (scene.sceneType ?? 'svg') as any,
      duration: scene.duration,
      htmlUrl: `/published/${args.project.id}/scenes/${scene.id}.html`,
      htmlContent: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interactions: (scene.interactions ?? []) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      variables: (scene.variables ?? []) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transition: normalizeTransition(scene.transition as any),
    })
  }

  if (missingSceneIds.length > 0) {
    throw new IpcValidationError(
      `Failed to publish: ${missingSceneIds.length} scene(s) are missing HTML files. Regenerate them and try again.`,
    )
  }

  // Copy flat upload files (best-effort; used to rewrite asset URLs to
  // `/published/<projectId>/assets/*` in the manifest consumer).
  const uploads = uploadsDir()
  if (fsSync.existsSync(uploads)) {
    try {
      const files = await fs.readdir(uploads)
      for (const file of files) {
        const src = path.join(uploads, file)
        const dest = path.join(assetsDir, file)
        try {
          const stat = await fs.stat(src)
          if (stat.isFile()) await fs.copyFile(src, dest)
        } catch {}
      }
    } catch (e) {
      console.warn('[publish] uploads copy failed:', e)
    }
  }

  // The script-embed snippet in PublishPanel loads player.js from the bundle.
  try {
    await fs.copyFile(playerBundlePath(), path.join(publishDir, 'player.js'))
  } catch (e) {
    console.warn('[publish] player.js not copied (run `npm run build:player`); the script embed will not load:', e)
  }

  // Read existing manifest to carry the version forward.
  const manifestPath = path.join(publishDir, 'manifest.json')
  let version = 1
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    version = (existing.version ?? 0) + 1
  } catch {
    // no prior publish, leave version at 1
  }

  const manifest: PublishedProject = {
    id: args.project.id,
    version,
    name: args.project.name || 'Untitled Project',
    playerOptions: {
      theme: args.project.interactiveSettings?.playerTheme ?? 'dark',
      showProgressBar: args.project.interactiveSettings?.showProgressBar ?? true,
      showSceneNav: args.project.interactiveSettings?.showSceneNav ?? false,
      allowFullscreen: args.project.interactiveSettings?.allowFullscreen ?? true,
      brandColor: args.project.interactiveSettings?.brandColor ?? '#e84545',
      autoplay: true,
    },
    sceneGraph: args.project.sceneGraph,
    scenes: publishedScenes,
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(publishDir, 'index.html'), buildPublishedIndexHtml(manifest.name), 'utf8')
  return { publishedUrl: `/published/${args.project.id}/`, version }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:publish.run', (_e, args: PublishArgs) => publish(args))
}
