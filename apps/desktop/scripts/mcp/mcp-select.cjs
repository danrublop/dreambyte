/**
 * Instance selection for the dep-free MCP connector (scripts/mcp/mcp-connect.js).
 *
 * Mirrors src/lib/mcp/instance-registry.ts `selectInstance()` — same manifest
 * format, same precedence: pin → cwd-inside-repoPath (deepest wins) →
 * only-live → newest. Kept as plain synchronous CommonJS so the connector
 * stays a ~30ms node script with zero transpilation. The parity describe-
 * block in src/lib/mcp/instance-registry.test.ts pins both implementations to
 * the same answers; change them together.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

function instancesDir(base) {
  return path.join(
    base || process.env.DREAMBYTE_INSTANCES_BASE || path.join(os.homedir(), '.dreambyte'),
    'instances',
  )
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Second liveness witness alongside the pid check (pid reuse makes a crashed
// instance's manifest look live; the socket file is unlinked at quit). See
// instance-registry.ts hasLiveSocket for the full rationale.
function hasLiveSocket(m) {
  try {
    fs.statSync(m.socketPath)
    return true
  } catch {
    return false
  }
}

function isLoopback(url) {
  try {
    return new URL(url).hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function parseManifest(raw, base) {
  try {
    const data = JSON.parse(raw)
    if (
      data.v !== 1 ||
      typeof data.instanceId !== 'string' ||
      typeof data.socketPath !== 'string' ||
      typeof data.url !== 'string' ||
      typeof data.token !== 'string' ||
      !isLoopback(data.url)
    ) {
      return null
    }
    // Containment guard — we dial socketPath verbatim; a poisoned manifest
    // must not redirect the socket connection outside the registry.
    const baseDir = path.resolve(instancesDir(base))
    if (!path.resolve(data.socketPath).startsWith(baseDir + path.sep)) return null
    return data
  } catch {
    return null
  }
}

function listLiveInstances(base) {
  let entries
  try {
    entries = fs.readdirSync(instancesDir(base))
  } catch {
    return []
  }
  const live = []
  for (const id of entries) {
    let raw
    try {
      raw = fs.readFileSync(path.join(instancesDir(base), id, 'instance.json'), 'utf8')
    } catch {
      continue
    }
    const manifest = parseManifest(raw, base)
    if (!manifest) continue
    if (!isPidAlive(manifest.pid)) continue // sweep is the TS side's job
    if (!hasLiveSocket(manifest)) continue // booting or pid-reuse zombie
    live.push(manifest)
  }
  return live
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** @returns {{manifest: object|null, reason: string, alternatives: object[]}} */
function selectInstance(opts) {
  opts = opts || {}
  const live = listLiveInstances(opts.base)
  if (live.length === 0) return { manifest: null, reason: 'none', alternatives: [] }

  if (opts.envId) {
    const pinned = live.find((m) => m.instanceId === opts.envId)
    if (pinned) return { manifest: pinned, reason: 'pin', alternatives: live.filter((m) => m !== pinned) }
  }

  if (opts.cwd) {
    const cwdReal = safeRealpath(opts.cwd)
    // Containment, not equality: a terminal in a SUBDIRECTORY of the worktree
    // binds to that worktree's instance; deepest repoPath wins on nesting.
    let match = null
    let matchLen = -1
    for (const m of live) {
      if (!m.repoPath) continue
      const repoReal = safeRealpath(m.repoPath)
      if ((cwdReal === repoReal || cwdReal.startsWith(repoReal + path.sep)) && repoReal.length > matchLen) {
        match = m
        matchLen = repoReal.length
      }
    }
    if (match) {
      const found = match
      return { manifest: found, reason: 'cwd', alternatives: live.filter((m) => m !== found) }
    }
  }

  if (live.length === 1) return { manifest: live[0], reason: 'only', alternatives: [] }

  const newest = live.slice().sort((a, b) => b.startedAt - a.startedAt)[0]
  return { manifest: newest, reason: 'newest', alternatives: live.filter((m) => m !== newest) }
}

module.exports = { selectInstance, listLiveInstances, instancesDir }
