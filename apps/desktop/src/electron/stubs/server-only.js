// `server-only` is a Next.js marker package that throws when imported in a
// React Server Components environment that isn't actually server-side. The
// Electron main process IS the server (it's the only place these modules
// run), so the marker is meaningless here. esbuild aliases this stub in
// place of the real package so the require() resolves to a no-op instead
// of crashing the app at startup.
//
// See scripts/build/build-electron.mjs > sharedConfig.alias.
module.exports = {}
