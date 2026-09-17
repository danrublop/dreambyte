import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Scan from the monorepo root so the workspace packages' tests run with the app's.
    dir: path.resolve(__dirname, '../..'),
    include: ['apps/desktop/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      // Agent worktrees live INSIDE the repo at .claude/worktrees/<id>. Their test
      // files match `include`, and the '@' alias below resolves to THIS root — so a
      // stale worktree's tests get collected and run against HEAD source, failing for
      // reasons that have nothing to do with your diff.
      '**/.claude/worktrees/**',
    ],
    // vitest's default 5s is too tight: the first test in a file pays for a large import
    // graph (runner.ts, tool-executor.ts and the handler barrels), and a first-test timeout
    // leaves mocks and process.env half-set so later tests fail with misleading assertions.
    // This does not catch a genuine hang (the timer runs inside the blocked worker); the
    // wall-clock limit is `timeout-minutes` in .github/workflows/ci.yml.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Next ships 'server-only' as a build-time import guard; stub it for vitest.
      'server-only': path.resolve(__dirname, 'src/lib/test-stubs/server-only.ts'),
    },
  },
})
