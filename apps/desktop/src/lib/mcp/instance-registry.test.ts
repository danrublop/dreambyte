import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import nodePath from 'node:path'
import {
  instanceIdFor,
  instanceSocketPath,
  instanceManifestPath,
  writeInstanceManifest,
  removeInstanceDir,
  listLiveInstances,
  selectInstance,
  type InstanceManifest,
} from './instance-registry'

let base: string

function manifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  const userDataPath = overrides.userDataPath ?? '/tmp/profile-a'
  const instanceId = overrides.instanceId ?? instanceIdFor(userDataPath, overrides.repoPath ?? '/tmp/repo-a')
  return {
    v: 1,
    instanceId,
    pid: process.pid, // alive by construction
    userDataPath,
    repoPath: '/tmp/repo-a',
    socketPath: instanceSocketPath(instanceId, base),
    url: 'http://127.0.0.1:50000',
    token: 'tok',
    startedAt: 1000,
    ...overrides,
  }
}

/** Write the manifest AND touch its socket file — liveness requires both
 *  (pid alive + socket present; see hasLiveSocket). */
async function writeLive(m: InstanceManifest): Promise<void> {
  await writeInstanceManifest(m, base)
  await fsp.mkdir(nodePath.dirname(m.socketPath), { recursive: true })
  await fsp.writeFile(m.socketPath, '')
}

beforeEach(async () => {
  base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'mcp-registry-'))
})

afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('instanceIdFor', () => {
  it('is stable for the same inputs and distinct across userData paths', () => {
    expect(instanceIdFor('/a', '/r')).toBe(instanceIdFor('/a', '/r'))
    expect(instanceIdFor('/a', '/r')).not.toBe(instanceIdFor('/b', '/r'))
    expect(instanceIdFor('/a', '/r')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('is distinct across repoPaths even with a SHARED userData (the bare `electron .` dev case)', () => {
    // Dev scripts launch without --user-data-dir, so two worktrees share the
    // default userData; the repoPath component keeps their identities apart.
    expect(instanceIdFor('/shared-userdata', '/worktree-a')).not.toBe(instanceIdFor('/shared-userdata', '/worktree-b'))
    // Packaged (repoPath null) is its own stable identity.
    expect(instanceIdFor('/shared-userdata', null)).toBe(instanceIdFor('/shared-userdata', undefined))
  })
})

describe('write / list / remove', () => {
  it('round-trips a manifest and lists it as live', async () => {
    const m = manifest()
    await writeLive(m)
    const live = await listLiveInstances(base)
    expect(live).toHaveLength(1)
    expect(live[0]).toEqual(m)
    // 0600 — token-bearing file must not be world-readable.
    const mode = fs.statSync(instanceManifestPath(m.instanceId, base)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('sweeps dead-pid manifests out of the listing', async () => {
    const dead = manifest({ pid: 2 ** 22 + 12345 })
    await writeLive(dead) // socket present, but pid cannot exist
    expect(await listLiveInstances(base)).toHaveLength(0)
    // Swept: the dir is gone (sweep is fire-and-forget — poll briefly).
    const manifestPath = instanceManifestPath(dead.instanceId, base)
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      gone = await fsp.access(manifestPath).then(
        () => false,
        () => true,
      )
      if (!gone) await new Promise((r) => setTimeout(r, 10))
    }
    expect(gone).toBe(true)
  })

  it('skips a BOOTING instance (alive pid, no socket yet) WITHOUT sweeping it', async () => {
    const booting = manifest()
    await writeInstanceManifest(booting, base) // manifest only — daemon not bound yet
    expect(await listLiveInstances(base)).toHaveLength(0)
    // NOT swept — the manifest belongs to a live process mid-startup.
    await expect(fsp.access(instanceManifestPath(booting.instanceId, base))).resolves.toBeUndefined()
  })

  it('ignores malformed, non-loopback, and socket-escaping manifests', async () => {
    const m = manifest()
    await writeLive(m)
    const evil = manifest({
      userDataPath: '/tmp/profile-evil',
      url: 'http://evil.example.com:50000',
    })
    await writeLive(evil)
    // socketPath outside the registry base must be rejected (containment guard)
    const escape = manifest({ userDataPath: '/tmp/profile-escape', socketPath: '/tmp/elsewhere.sock' })
    await writeInstanceManifest(escape, base)
    await fsp.writeFile('/tmp/elsewhere.sock', '').catch(() => {})
    await fsp.mkdir(nodePath.join(base, 'instances', 'junk'), { recursive: true })
    await fsp.writeFile(nodePath.join(base, 'instances', 'junk', 'instance.json'), 'not json')
    const live = await listLiveInstances(base)
    expect(live.map((x) => x.instanceId)).toEqual([m.instanceId])
    await fsp.rm('/tmp/elsewhere.sock', { force: true })
  })

  it('removeInstanceDir removes manifest + socket dir', async () => {
    const m = manifest()
    await writeLive(m)
    await removeInstanceDir(m.instanceId, base)
    expect(await listLiveInstances(base)).toHaveLength(0)
  })
})

describe('selectInstance', () => {
  it('returns none with an empty registry', async () => {
    const r = await selectInstance({ base })
    expect(r.manifest).toBeNull()
    expect(r.reason).toBe('none')
  })

  it('pin (envId) wins over cwd match', async () => {
    const a = manifest({ userDataPath: '/p/a', repoPath: '/tmp/repo-a' })
    const b = manifest({ userDataPath: '/p/b', repoPath: '/tmp/repo-b' })
    await writeLive(a)
    await writeLive(b)
    const r = await selectInstance({ base, envId: b.instanceId, cwd: '/tmp/repo-a' })
    expect(r.manifest?.instanceId).toBe(b.instanceId)
    expect(r.reason).toBe('pin')
    expect(r.alternatives.map((m) => m.instanceId)).toEqual([a.instanceId])
  })

  it('matches the instance whose repoPath equals the cwd (the worktree contract)', async () => {
    const repoA = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'repo-a-'))
    const repoB = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'repo-b-'))
    try {
      const a = manifest({ userDataPath: '/p/a', repoPath: repoA, startedAt: 1 })
      const b = manifest({ userDataPath: '/p/b', repoPath: repoB, startedAt: 2 })
      await writeLive(a)
      await writeLive(b)
      const r = await selectInstance({ base, cwd: repoA })
      expect(r.manifest?.instanceId).toBe(a.instanceId)
      expect(r.reason).toBe('cwd')
    } finally {
      await fsp.rm(repoA, { recursive: true, force: true })
      await fsp.rm(repoB, { recursive: true, force: true })
    }
  })

  it('matches a cwd INSIDE the worktree (subdirectory terminals), deepest repoPath winning', async () => {
    const repoA = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'repo-a-'))
    const nested = nodePath.join(repoA, 'packages', 'inner')
    await fsp.mkdir(nested, { recursive: true })
    try {
      const outer = manifest({ userDataPath: '/p/a', repoPath: repoA, startedAt: 1 })
      const inner = manifest({ userDataPath: '/p/b', repoPath: nested, startedAt: 2 })
      await writeLive(outer)
      await writeLive(inner)
      // cwd two levels under the outer worktree → containment match
      const sub = nodePath.join(repoA, 'lib', 'audio')
      await fsp.mkdir(sub, { recursive: true })
      const r1 = await selectInstance({ base, cwd: sub })
      expect(r1.manifest?.instanceId).toBe(outer.instanceId)
      expect(r1.reason).toBe('cwd')
      // cwd inside the NESTED repoPath → the deeper (more specific) one wins
      const r2 = await selectInstance({ base, cwd: nested })
      expect(r2.manifest?.instanceId).toBe(inner.instanceId)
      // a sibling path that merely shares the prefix must NOT match
      const sibling = repoA + '-evil'
      await fsp.mkdir(sibling, { recursive: true })
      const r3 = await selectInstance({ base, cwd: sibling })
      expect(r3.reason).not.toBe('cwd')
      await fsp.rm(sibling, { recursive: true, force: true })
    } finally {
      await fsp.rm(repoA, { recursive: true, force: true })
    }
  })

  it('single live instance wins without a cwd match', async () => {
    const a = manifest()
    await writeLive(a)
    const r = await selectInstance({ base, cwd: '/nowhere' })
    expect(r.manifest?.instanceId).toBe(a.instanceId)
    expect(r.reason).toBe('only')
  })

  it('falls back to newest startedAt on ambiguity, reporting alternatives', async () => {
    const a = manifest({ userDataPath: '/p/a', startedAt: 1 })
    const b = manifest({ userDataPath: '/p/b', startedAt: 2 })
    await writeLive(a)
    await writeLive(b)
    const r = await selectInstance({ base, cwd: '/nowhere' })
    expect(r.manifest?.instanceId).toBe(b.instanceId)
    expect(r.reason).toBe('newest')
    expect(r.alternatives.map((m) => m.instanceId)).toEqual([a.instanceId])
  })
})

describe('parity with scripts/mcp/mcp-select.cjs (the connector must agree)', () => {
  async function loadCjs() {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    return require('../../../scripts/mcp/mcp-select.cjs') as {
      selectInstance: (o: { base?: string; cwd?: string; envId?: string }) => {
        manifest: InstanceManifest | null
        reason: string
      }
    }
  }

  it('CJS selection returns the same answers on the same registry', async () => {
    const repoA = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'repo-a-'))
    try {
      const a = manifest({ userDataPath: '/p/a', repoPath: repoA, startedAt: 1 })
      const b = manifest({ userDataPath: '/p/b', repoPath: '/tmp/elsewhere', startedAt: 2 })
      await writeLive(a)
      await writeLive(b)
      const cjs = await loadCjs()

      // cwd match (exact)
      const ts1 = await selectInstance({ base, cwd: repoA })
      const js1 = cjs.selectInstance({ base, cwd: repoA })
      expect(js1.manifest?.instanceId).toBe(ts1.manifest?.instanceId)
      expect(js1.reason).toBe(ts1.reason)

      // cwd match (subdirectory containment)
      const sub = nodePath.join(repoA, 'src')
      await fsp.mkdir(sub, { recursive: true })
      const ts1b = await selectInstance({ base, cwd: sub })
      const js1b = cjs.selectInstance({ base, cwd: sub })
      expect(js1b.manifest?.instanceId).toBe(ts1b.manifest?.instanceId)
      expect(js1b.reason).toBe('cwd')

      // pin
      const ts2 = await selectInstance({ base, envId: b.instanceId, cwd: repoA })
      const js2 = cjs.selectInstance({ base, envId: b.instanceId, cwd: repoA })
      expect(js2.manifest?.instanceId).toBe(ts2.manifest?.instanceId)
      expect(js2.reason).toBe('pin')

      // ambiguity → newest
      const ts3 = await selectInstance({ base, cwd: '/nowhere' })
      const js3 = cjs.selectInstance({ base, cwd: '/nowhere' })
      expect(js3.manifest?.instanceId).toBe(ts3.manifest?.instanceId)
      expect(js3.reason).toBe('newest')
    } finally {
      await fsp.rm(repoA, { recursive: true, force: true })
    }
  })

  it('both implementations drop dead-pid and booting (no-socket) manifests identically', async () => {
    const dead = manifest({ userDataPath: '/p/dead', pid: 2 ** 22 + 23456 })
    await writeLive(dead)
    const booting = manifest({ userDataPath: '/p/boot' })
    await writeInstanceManifest(booting, base) // no socket
    const liveOne = manifest({ userDataPath: '/p/live' })
    await writeLive(liveOne)
    const cjs = await loadCjs()

    const js = cjs.selectInstance({ base, cwd: '/nowhere' })
    expect(js.manifest?.instanceId).toBe(liveOne.instanceId)
    expect(js.reason).toBe('only')
    const ts = await selectInstance({ base, cwd: '/nowhere' })
    expect(ts.manifest?.instanceId).toBe(liveOne.instanceId)
    expect(ts.reason).toBe('only')
  })
})
