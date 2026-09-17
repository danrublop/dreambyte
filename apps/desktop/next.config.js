/** @type {import('next').NextConfig} */

// `scripts/build/build-renderer.mjs` sets BUILD_MODE=desktop so `next build` produces the
// static `out/` bundle the dreambyte:// protocol handler serves. Otherwise this is the
// `next dev` server used by `npm run dev` / `dev:electron:web`.
const path = require('path')
const isDesktopBuild = process.env.BUILD_MODE === 'desktop'

const nextConfig = {
  // npm workspaces: dependencies are hoisted to the monorepo root, two levels up.
  turbopack: { root: path.join(__dirname, '..', '..') },
  ...(isDesktopBuild
    ? {
        output: 'export',
        images: { unoptimized: true },
        trailingSlash: false,
      }
    : {
        async headers() {
          const securityHeaders = [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          ]
          return [
            {
              source: '/:path*',
              headers: securityHeaders,
            },
            {
              source: '/scenes/:path*',
              headers: [
                { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
                { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
              ],
            },
            {
              source: '/uploads/:path*',
              headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
            },
          ]
        },
      }),
}

module.exports = nextConfig
