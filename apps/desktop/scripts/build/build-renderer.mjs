#!/usr/bin/env node
/**
 * Static-export the Next.js renderer for the packaged Electron app.
 *
 * Runs `next build` with BUILD_MODE=desktop (next.config.js switches to
 * `output: 'export'`), then strips dev fixtures Next mirrors from `public/`.
 *
 * Output: `out/` populated with a self-contained static site that the
 * `dreambyte://app/*` protocol handler in src/electron/main.ts loads.
 *
 * Usage:
 *   node scripts/build/build-renderer.mjs           # build once
 *   node scripts/build/build-renderer.mjs --watch   # rebuild on renderer source changes
 */
import { spawn } from 'node:child_process'
import { existsSync, watch as fsWatch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

/**
 * Dev fixture directories under `out/` that exist only because Next.js
 * mirrors `public/` during static export. Stripping drops the asar payload
 * from ~785MB to ~50MB. If a directory listed here ever needs to ship as
 * runtime data, move it out of `public/` to a path Next does not auto-mirror
 * (e.g., `src/lib/runtime-assets/`) and load it through a different mechanism.
 */
const STRIP_FROM_OUT = ['scenes', 'audio', 'uploads', 'published']

async function stripDevFixtures() {
  let removedBytes = 0
  for (const name of STRIP_FROM_OUT) {
    const target = path.join(repoRoot, 'out', name)
    if (!existsSync(target)) continue
    try {
      const before = await dirSize(target)
      await fs.rm(target, { recursive: true, force: true })
      removedBytes += before
      console.log(`  → stripped out/${name}/ (${formatBytes(before)})`)
    } catch (err) {
      // Refuse to ship a fat bundle silently if pruning fails — a 700MB
      // .dmg shouldn't sneak through because rm hit a permissions issue.
      throw new Error(`failed to strip out/${name}: ${(err).message}`)
    }
  }
  if (removedBytes > 0) {
    console.log(`[build-renderer] dev fixture strip total: ${formatBytes(removedBytes)}`)
  }
}

async function dirSize(dirPath) {
  let total = 0
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
      } else {
        try {
          const st = await fs.stat(child)
          total += st.size
        } catch {
          // best-effort — file may have been removed underneath us
        }
      }
    }
  }
  return total
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function spawnBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['next', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        BUILD_MODE: 'desktop',
        // Skip the predev/prebuild env validator's DATABASE_URL requirement.
        // The renderer build only needs the editor JS bundle; runtime DB
        // connectivity is provisioned at first launch via onboarding.
        SKIP_DB_ENV_CHECK: '1',
      },
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`next build exited with code ${code}`))
    })
  })
}

/** Run a single Next build + post-build strip. */
async function runBuild() {
  console.log('[build-renderer] running `next build` with BUILD_MODE=desktop...')
  await spawnBuild()
  console.log('[build-renderer] static export written to out/')

  // Strip dev fixtures that Next mirrors from `public/` into `out/`. Without
  // this the asar payload is ~785MB (1316 dev scene HTMLs, 236 TTS audio
  // fixtures, etc.) for what is functionally a 25MB app bundle.
  //
  // Runtime data lives in `<userData>/{scenes,audio,uploads}` via the dreambyte://
  // protocol mounts, NOT in the read-only static bundle.
  await stripDevFixtures()
}

/** One-shot build (the no-watch path). */
async function main() {
  await runBuild()
}

/**
 * Watch source dirs and re-run `runBuild()` on change.
 */
async function watchAndRebuild() {
  // Source directories whose changes should trigger a renderer rebuild. Kept
  // narrow on purpose — `next build` does its own dependency analysis, but the
  // file watcher only needs to know "did anything the renderer cares about
  // change?" and these cover ~all renderer source. `public/sdk` is included so
  // edits to the in-scene SDK (dreambyte-react runtime/bridges) get copied to
  // `out/sdk` — the static export's served copy — instead of going stale until a
  // manual copy + relaunch. We
  // do NOT watch all of `public/`: the app writes scenes/audio there at runtime,
  // which would trigger a rebuild storm.
  const WATCH_DIRS = ['src', 'public/sdk']
  // Exclude server/main-process-only lib subdirectories. Changes there only
  // affect dist-electron/main.js (rebuilt by esbuild watch), not the renderer.
  // Without this exclusion, editing src/lib/agents/mcp-handler.ts triggers a full
  // next build, clearing out/_next/ while the app is running and flooding the
  // logs with ERR_FILE_NOT_FOUND for JS chunk files.
  const IGNORE = /(^|\/)(\.next|node_modules|out|dist-electron)(\/|$)|(^|\/)lib\/(agents|db|generation)\//

  // Initial build.
  try {
    await runBuild()
    // Write the same signal the trigger() uses so Electron's fsSync.watch fires
    // a reload after the initial build. Without this, if Electron started before
    // next build finished (and got ERR_UNEXPECTED on the cleared out/), it never
    // recovers because trigger() only runs on source-file changes, not on startup.
    await fs.writeFile(path.join(repoRoot, 'out', '.renderer-watch-signal'), String(Date.now()))
    console.log('[build-renderer:watch] initial build ready.')
  } catch (err) {
    console.error('[build-renderer:watch] initial build failed:', err)
  }

  let pending = false
  let running = false
  let queued = false
  let lastChangePath = null

  const trigger = (changedPath) => {
    if (changedPath) lastChangePath = changedPath
    if (running) {
      queued = true
      return
    }
    if (pending) return
    pending = true
    setTimeout(async () => {
      pending = false
      running = true
      const reason = lastChangePath ? path.relative(repoRoot, lastChangePath) : 'change'
      lastChangePath = null
      console.log(`\n[build-renderer:watch] rebuilding (${reason})...`)
      try {
        await runBuild()
        // Signal Electron to reload the renderer window. The main process
        // watches this file in dev mode and calls webContents.reload() on change.
        await fs.writeFile(path.join(repoRoot, 'out', '.renderer-watch-signal'), String(Date.now()))
        console.log('[build-renderer:watch] ready.')
      } catch (err) {
        console.error('[build-renderer:watch] rebuild failed:', err)
      } finally {
        running = false
        if (queued) {
          queued = false
          trigger('queued change')
        }
      }
    }, 250) // debounce — editors can fire several events per save
  }

  for (const dir of WATCH_DIRS) {
    const abs = path.join(repoRoot, dir)
    if (!existsSync(abs)) continue
    try {
      // recursive: true is supported on macOS (Darwin) and Windows. On Linux
      // it falls back to non-recursive — acceptable for a dev convenience.
      const watcher = fsWatch(abs, { recursive: true }, (_evt, filename) => {
        if (!filename) return
        const full = path.join(abs, filename)
        if (IGNORE.test(full)) return
        trigger(full)
      })
      watcher.on('error', (err) => console.warn(`[build-renderer:watch] ${dir} watcher error:`, err.message))
    } catch (err) {
      console.warn(`[build-renderer:watch] could not watch ${dir}:`, err.message)
    }
  }

  console.log(`[build-renderer:watch] watching ${WATCH_DIRS.join(', ')} for changes…`)
  // Keep the process alive — concurrently expects this script to stay running
  // alongside the Electron + esbuild watchers.
  return new Promise(() => {})
}

const isWatch = process.argv.includes('--watch')

;(async () => {
  try {
    if (isWatch) {
      await watchAndRebuild()
    } else {
      await main()
    }
  } catch (err) {
    console.error('[build-renderer] failed:', err)
    process.exit(1)
  }
})()
