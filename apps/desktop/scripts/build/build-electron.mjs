#!/usr/bin/env node
/**
 * esbuild bundler for the Electron main + preload processes.
 *
 * Bundles `src/electron/main.ts` and `src/electron/preload.ts` with all their
 * transitive imports into single CJS files under `dist-electron/`. This is
 * is what lets an IPC handler in
 * `src/electron/ipc/<category>.ts` can import from `@/lib/db`, `@/lib/agents`,
 * `@/lib/audio/*` etc. and those files ship alongside `main.js` in the
 * packaged app.
 *
 * Rules:
 * - `electron` is always external (provided by the Electron runtime).
 * - Node built-ins (fs, path, etc.) are external.
 * - Everything under `node_modules/**` is external — electron-builder ships
 *   `node_modules/` inside `app.asar` so `require('pg')` still resolves at
 *   runtime. Bundling them would inline megabytes of third-party code for
 *   no gain. Native modules (`pg`) would also break if bundled.
 * - Application code (`src/electron/**`, `src/lib/**`, `src/app/**`) is bundled inline.
 *
 * Usage:
 *   node scripts/build/build-electron.mjs          # one-shot build
 *   node scripts/build/build-electron.mjs --watch  # rebuild on change (for dev)
 */
import { context, build } from 'esbuild'
import path from 'node:path'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')
const outDir = path.join(repoRoot, 'dist-electron')

/**
 * Plugin: externalize bare specifiers (node_modules + Node built-ins) but
 * keep `@/...` aliases bundled. The stock `packages: 'external'` option
 * treats anything that doesn't start with `.` or `/` as external, which
 * means `@/lib/db` gets externalized and esbuild tries to read
 * `dist-electron/main.js` as input instead of emitting it.
 */
// Specifiers that look like bare packages but should be bundled via the
// `alias` config below instead of left external. Add new stubs to this set
// when you alias them — otherwise externalize-bare-specifiers wins the
// race and `require()` fails at runtime.
const aliasedBareSpecifiers = new Set(['server-only'])

const externalBareSpecifiers = {
  name: 'externalize-bare-specifiers',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path
      // Relative imports: always bundle
      if (p.startsWith('.') || p.startsWith('/')) return null
      // Path aliases we control: bundle through the `alias` config
      if (p === '@' || p.startsWith('@/')) return null
      // Workspace package of plain-JS export helpers: bundle it like app code.
      if (p.startsWith('@dreambyte/render-server/')) return null
      // Aliased bare names (poison-pill markers, stubs): bundle so the alias resolves
      if (aliasedBareSpecifiers.has(p)) return null
      // Everything else (bare package names) stays external
      return { path: p, external: true }
    })
  },
}

/** @type {import('esbuild').BuildOptions} */
const sharedConfig = {
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  plugins: [externalBareSpecifiers],
  // Resolve `@/x/y` to `<repoRoot>/src/x/y` (matches the root tsconfig paths).
  // Also stub Next.js's `server-only` marker — it's a poison-pill that throws
  // when imported outside RSC, but the Electron main process IS the server,
  // so we want the require() to resolve to a no-op instead of crashing boot.
  alias: {
    '@': path.join(repoRoot, 'src'),
    'server-only': path.join(repoRoot, 'src', 'electron', 'stubs', 'server-only.js'),
  },
}

async function run() {
  const watch = process.argv.includes('--watch')

  const configs = [
    {
      ...sharedConfig,
      entryPoints: [path.join(repoRoot, 'src/electron/main.ts')],
      outfile: path.join(outDir, 'main.js'),
    },
    {
      ...sharedConfig,
      entryPoints: [path.join(repoRoot, 'src/electron/preload.ts')],
      outfile: path.join(outDir, 'preload.js'),
    },
    {
      ...sharedConfig,
      entryPoints: [path.join(repoRoot, 'src/electron/verifier-preload.ts')],
      outfile: path.join(outDir, 'verifier-preload.js'),
    },
    // MediaPipe detector page — browser-target IIFE bundle loaded by
    // dist-electron/mediapipe-detector.html inside the offscreen
    // BrowserWindow. Bundles @mediapipe/tasks-vision inline so the page
    // can run without network. The WASM artifacts and model are loaded
    // separately at runtime from local copies (dist-electron/mediapipe-wasm/
    // and dist-electron/mediapipe-models/, copied below).
    {
      // Don't inherit sharedConfig — that one targets node + externalizes
      // bare specifiers, which is wrong for browser code that imports
      // npm packages.
      entryPoints: [path.join(repoRoot, 'src/electron/mediapipe-detector-page.ts')],
      outfile: path.join(outDir, 'mediapipe-detector-bundle.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      sourcemap: true,
      logLevel: 'info',
      // The page is loaded via file:// inside the offscreen window. No
      // externals — every dep must be inlined.
      // Resolve @/... like the rest of the codebase.
      alias: {
        '@': path.join(repoRoot, 'src'),
      },
    },
    // MCP server — standalone CJS bundle spawned by the Claude Code / Codex
    // CLI subprocesses when the user routes an agent run through their
    // installed CLI. Packaged with the .app via electron-builder
    // `extraResources`; executed via `process.execPath` with
    // `ELECTRON_RUN_AS_NODE=1` so there's no `npx` / `tsx` dependency.
    //
    // Unlike main/preload, this bundle ships OUTSIDE `app.asar` (it's in
    // `extraResources` so Node's file system can locate it). Node's module
    // resolution then can't reach `app.asar/node_modules`, so every
    // dependency must be inlined — we can't externalize bare specifiers
    // here. Skipped: native `.node` addons (none reach this bundle; the
    // adapter only uses fetch + logger).
    {
      ...sharedConfig,
      // Drop the externalize-bare-specifiers plugin: we want every npm
      // dep (@modelcontextprotocol/sdk, uuid, etc.) inlined.
      plugins: [],
      // Bundle every `@/...` just like the shared config, but now
      // node_modules are also walked instead of left as `require()` stubs.
      entryPoints: [path.join(repoRoot, 'scripts/mcp/mcp-server.ts')],
      outfile: path.join(outDir, 'mcp-server.cjs'),
      // `import.meta.url` appears in some SDK deps under ESM; esbuild
      // would otherwise warn. Safe to stub because the bundle is CJS.
      banner: {
        js: "const __mcpSdkMeta={url:require('url').pathToFileURL(__filename).href};",
      },
    },
  ]

  // Copy static assets (HTML pages loaded into offscreen BrowserWindows).
  // Esbuild doesn't bundle .html — they're entry points for the browser
  // side. The MediaPipe detector page is one such asset.
  function copyStaticAssets() {
    const staticAssets = [
      { src: 'src/electron/mediapipe-detector.html', dest: 'mediapipe-detector.html' },
      // Native music composer ML workers + their shared harness. The workers spawn
      // as child processes and `require('./magenta-worker-base.cjs')` next to
      // themselves, so the base MUST ship alongside them. Copying here makes ml
      // melody/drums work in the PACKAGED app (shipped via the dist-electron/** files
      // glob), not just dev. Without these, ml silently falls back to the template.
      { src: 'src/lib/audio/composer/magenta-worker-base.cjs', dest: 'magenta-worker-base.cjs' },
      { src: 'src/lib/audio/composer/ml-melody-worker.cjs', dest: 'ml-melody-worker.cjs' },
      { src: 'src/lib/audio/composer/ml-drums-worker.cjs', dest: 'ml-drums-worker.cjs' },
    ]
    for (const asset of staticAssets) {
      copyFileSync(path.join(repoRoot, asset.src), path.join(outDir, asset.dest))
    }

    // MediaPipe WASM artifacts. The bundled detector page calls
    // FilesetResolver.forVisionTasks('./mediapipe-wasm') — we copy the
    // node_modules WASM dir to dist-electron/mediapipe-wasm/ so the
    // page can resolve it via the file:// origin without network.
    const wasmSrcDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@mediapipe/tasks-vision')), 'wasm')
    const wasmDestDir = path.join(outDir, 'mediapipe-wasm')
    try {
      mkdirSync(wasmDestDir, { recursive: true })
      for (const entry of readdirSync(wasmSrcDir)) {
        const srcPath = path.join(wasmSrcDir, entry)
        if (statSync(srcPath).isFile()) {
          copyFileSync(srcPath, path.join(wasmDestDir, entry))
        }
      }
    } catch (err) {
      console.warn(
        '[build-electron] could not copy MediaPipe WASM artifacts —',
        'auto_reframe will fail at runtime. Error:',
        err.message,
      )
    }

    // MediaPipe model files (offline-first). Copied from the repo's
    // resources/mediapipe/ to dist-electron/mediapipe-models/. The
    // detector page loads them via the relative path
    // './mediapipe-models/<file>' — no network round-trip.
    const modelSrcDir = path.join(repoRoot, 'resources/mediapipe')
    const modelDestDir = path.join(outDir, 'mediapipe-models')
    try {
      mkdirSync(modelDestDir, { recursive: true })
      for (const entry of readdirSync(modelSrcDir)) {
        if (entry.endsWith('.tflite') || entry.endsWith('.task')) {
          const srcPath = path.join(modelSrcDir, entry)
          if (statSync(srcPath).isFile()) {
            copyFileSync(srcPath, path.join(modelDestDir, entry))
          }
        }
      }
    } catch (err) {
      console.warn(
        '[build-electron] could not copy MediaPipe models —',
        'auto_reframe will fall back to network model download. Error:',
        err.message,
      )
    }
  }

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)))
    await Promise.all(ctxs.map((c) => c.watch()))
    copyStaticAssets()
    console.log('[build-electron] watching for changes...')
    // Keep the process alive
    await new Promise(() => {})
  } else {
    await Promise.all(configs.map((c) => build(c)))
    copyStaticAssets()
    console.log('[build-electron] done')
  }
}

run().catch((err) => {
  console.error('[build-electron] failed:', err)
  process.exit(1)
})
