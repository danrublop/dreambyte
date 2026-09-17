// @vitest-environment node
//
// Smoke test for scripts/install-dreambyte-skill.mjs. Spawns the installer
// against a tmp target dir, then asserts the produced tree matches the
// repo's .claude/skills/dreambyte/ tree byte-for-byte. The installer is the
// skill distribution surface — if it stops copying SKILL.md / rules,
// external Claude Code users get a broken /dreambyte skill.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SOURCE = path.join(REPO_ROOT, '.claude', 'skills', 'dreambyte')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'mcp', 'install-dreambyte-skill.mjs')

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-install-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.push(path.relative(dir, abs))
    }
  }
  await walk(dir)
  return out.sort()
}

describe('install-dreambyte-skill.mjs', () => {
  it('--dry-run prints the file list and writes nothing', async () => {
    const result = spawnSync(
      'node',
      [SCRIPT, '--dry-run', '--target', tmpDir],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Dry run — nothing written.')
    expect(result.stdout).toContain('SKILL.md')
    // Target directory should still be empty after dry-run.
    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual([])
  })

  it('--yes performs the install and the result matches the source tree', async () => {
    const result = spawnSync(
      'node',
      [SCRIPT, '--yes', '--target', tmpDir],
      { encoding: 'utf8' },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Installed')

    const sourceFiles = await listFilesRel(SOURCE)
    const destFiles = await listFilesRel(path.join(tmpDir, 'dreambyte'))
    expect(destFiles).toEqual(sourceFiles)

    // Spot-check byte identity on the SKILL.md frontmatter.
    const srcSkill = await fs.readFile(path.join(SOURCE, 'SKILL.md'), 'utf8')
    const dstSkill = await fs.readFile(path.join(tmpDir, 'dreambyte', 'SKILL.md'), 'utf8')
    expect(dstSkill).toBe(srcSkill)
  })

  it('--help shows usage without writing files', async () => {
    const result = spawnSync('node', [SCRIPT, '--help', '--target', tmpDir], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Install the /dreambyte skill')
    expect(result.stdout).toContain('--target')
    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual([])
  })

  it('rejects unknown flags', async () => {
    const result = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Unknown flag')
  })

  it('is idempotent — running twice produces the same tree', async () => {
    const a = spawnSync('node', [SCRIPT, '--yes', '--target', tmpDir], { encoding: 'utf8', timeout: 30_000 })
    expect(a.status).toBe(0)
    const filesAfterFirst = await listFilesRel(path.join(tmpDir, 'dreambyte'))
    const b = spawnSync('node', [SCRIPT, '--yes', '--target', tmpDir], { encoding: 'utf8', timeout: 30_000 })
    expect(b.status).toBe(0)
    const filesAfterSecond = await listFilesRel(path.join(tmpDir, 'dreambyte'))
    expect(filesAfterSecond).toEqual(filesAfterFirst)
  })
})
