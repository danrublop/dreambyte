// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { listScenes, readProject, readScene, readSceneHtml, listAssets, DreambyteFsError } from './tools'

let scopeRoot: string
let outsideDir: string

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2))
}

beforeEach(async () => {
  scopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-fs-tools-scope-'))
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-fs-tools-out-'))
})

afterEach(async () => {
  await fs.rm(scopeRoot, { recursive: true, force: true })
  await fs.rm(outsideDir, { recursive: true, force: true })
})

describe('readProject', () => {
  it('returns the parsed project.json content', async () => {
    await writeJson(path.join(scopeRoot, 'project.json'), {
      formatVersion: 1,
      project: { id: 'p1', name: 'Demo' },
      sceneOrder: ['s1', 's2'],
    })
    const r = await readProject(scopeRoot)
    expect(r.formatVersion).toBe(1)
    expect((r.project as { name: string }).name).toBe('Demo')
  })

  it('throws NOT_FOUND when project.json is missing', async () => {
    try {
      await readProject(scopeRoot)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DreambyteFsError)
      expect((err as DreambyteFsError).code).toBe('NOT_FOUND')
    }
  })

  it('throws CORRUPT on malformed JSON', async () => {
    await fs.writeFile(path.join(scopeRoot, 'project.json'), '{broken')
    try {
      await readProject(scopeRoot)
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as DreambyteFsError).code).toBe('CORRUPT')
    }
  })
})

describe('listScenes', () => {
  it('returns one summary per scene file', async () => {
    await writeJson(path.join(scopeRoot, 'project.json'), {
      formatVersion: 1,
      project: { id: 'p1', name: 'D' },
      sceneOrder: ['s1', 's2'],
    })
    await writeJson(path.join(scopeRoot, 'scenes', 's1.dreambyte.json'), {
      id: 's1',
      name: 'Opener',
      duration: 5,
      sceneType: 'react',
    })
    await writeJson(path.join(scopeRoot, 'scenes', 's2.dreambyte.json'), {
      id: 's2',
      name: 'Closer',
      duration: 8,
      sceneType: 'three',
    })

    const summaries = await listScenes(scopeRoot)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toEqual({ id: 's1', name: 'Opener', durationSeconds: 5, sceneType: 'react' })
    expect(summaries[1].sceneType).toBe('three')
  })

  it('skips scenes whose dreambyte.json is missing', async () => {
    await writeJson(path.join(scopeRoot, 'project.json'), {
      formatVersion: 1,
      project: { id: 'p' },
      sceneOrder: ['present', 'ghost'],
    })
    await writeJson(path.join(scopeRoot, 'scenes', 'present.dreambyte.json'), { id: 'present', name: 'Present' })

    const summaries = await listScenes(scopeRoot)
    expect(summaries.map((s) => s.id)).toEqual(['present'])
  })

  it('throws CORRUPT when project.json has no sceneOrder', async () => {
    await writeJson(path.join(scopeRoot, 'project.json'), { formatVersion: 1, project: {} })
    try {
      await listScenes(scopeRoot)
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as DreambyteFsError).code).toBe('CORRUPT')
    }
  })
})

describe('readScene', () => {
  it('returns the parsed dreambyte.json', async () => {
    await writeJson(path.join(scopeRoot, 'scenes', 's1.dreambyte.json'), {
      id: 's1',
      name: 'Opener',
      reactCode: '<div/>',
    })
    const r = await readScene(scopeRoot, 's1')
    expect(r.name).toBe('Opener')
    expect(r.reactCode).toBe('<div/>')
  })

  it('rejects an out-of-scope sceneId via path traversal', async () => {
    // Even if a JSON file exists at a traversal target, the path guard
    // refuses it.
    await fs.writeFile(path.join(outsideDir, 'leak.dreambyte.json'), '{"id":"leak"}')
    try {
      await readScene(scopeRoot, '../../leak')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as DreambyteFsError).code).toBe('OUT_OF_SCOPE')
    }
  })

  it('rejects an empty sceneId', async () => {
    await expect(readScene(scopeRoot, '')).rejects.toBeInstanceOf(DreambyteFsError)
  })

  it('throws NOT_FOUND when the scene file is missing', async () => {
    try {
      await readScene(scopeRoot, 'never-existed')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as DreambyteFsError).code).toBe('NOT_FOUND')
    }
  })
})

describe('readSceneHtml', () => {
  it('returns the HTML when present', async () => {
    await fs.mkdir(path.join(scopeRoot, 'scenes'), { recursive: true })
    await fs.writeFile(path.join(scopeRoot, 'scenes', 's1.html'), '<!doctype html><body>x</body>')
    const html = await readSceneHtml(scopeRoot, 's1')
    expect(html).toContain('doctype')
  })

  it('returns null when no HTML exists', async () => {
    expect(await readSceneHtml(scopeRoot, 'no-html')).toBeNull()
  })

  it('rejects path-traversal sceneIds', async () => {
    await expect(readSceneHtml(scopeRoot, '../etc/passwd')).rejects.toBeInstanceOf(DreambyteFsError)
  })
})

describe('listAssets', () => {
  it('returns an empty array when assets/ is missing', async () => {
    expect(await listAssets(scopeRoot)).toEqual([])
  })

  it('walks files recursively and returns POSIX subpaths', async () => {
    await fs.mkdir(path.join(scopeRoot, 'assets', 'footage'), { recursive: true })
    await fs.writeFile(path.join(scopeRoot, 'assets', 'cover.png'), 'PNGDATA')
    await fs.writeFile(path.join(scopeRoot, 'assets', 'footage', 'a.mp4'), 'MP4DATA')

    const assets = await listAssets(scopeRoot)
    const sub = assets.map((a) => a.subpath).sort()
    expect(sub).toEqual(['assets/cover.png', 'assets/footage/a.mp4'])
    const cover = assets.find((a) => a.subpath === 'assets/cover.png')
    expect(cover?.sizeBytes).toBe('PNGDATA'.length)
  })

  it('skips symlinked entries that escape scope', async () => {
    await fs.mkdir(path.join(scopeRoot, 'assets'), { recursive: true })
    await fs.writeFile(path.join(outsideDir, 'secret.bin'), 'SECRET')
    await fs.symlink(path.join(outsideDir, 'secret.bin'), path.join(scopeRoot, 'assets', 'leak.bin'))
    await fs.writeFile(path.join(scopeRoot, 'assets', 'real.png'), 'OK')

    const assets = await listAssets(scopeRoot)
    expect(assets.map((a) => a.subpath)).toEqual(['assets/real.png'])
  })
})
