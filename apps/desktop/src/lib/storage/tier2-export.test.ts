// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { exportProjectToTier2, assertSafeTier2Root, Tier2DisabledError, Tier2PathError } from './tier2-export'
import type { Project } from '../types/project'
import type { Scene } from '../types/scene'

const ORIGINAL_FLAG = process.env.DREAMBYTE_TIER2_EXPORT

let tmpRoot: string

function makeProject(): Project {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Smoke Test',
    outputMode: 'mp4',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    mp4Settings: { resolution: '1080p', fps: 30, format: 'mp4', aspectRatio: '16:9' } as Project['mp4Settings'],
    interactiveSettings: {
      playerTheme: 'dark',
      showProgressBar: true,
      showSceneNav: false,
      allowFullscreen: true,
      brandColor: '#e84545',
      customDomain: null,
      password: null,
    },
    sceneGraph: { nodes: [], edges: [], startSceneId: '' } as unknown as Project['sceneGraph'],
    apiPermissions: {} as Project['apiPermissions'],
    audioSettings: {} as Project['audioSettings'],
    audioProviderEnabled: {},
    mediaGenEnabled: {},
    watermark: null,
    brandKit: null,
    timeline: null,
    tier2Path: null,
  }
}

function makeScene(id: string, name: string): Scene {
  return {
    id,
    name,
    prompt: '',
    summary: '',
    svgContent: '',
    usage: null,
    duration: 3,
    bgColor: '#000',
    thumbnail: null,
    videoLayer: { enabled: false, src: null, opacity: 1, trimStart: 0, trimEnd: null },
    audioLayer: {} as Scene['audioLayer'],
    textOverlays: [],
    svgObjects: [],
    primaryObjectId: null,
    svgBranches: [],
    activeBranchId: null,
    transition: 'cut' as Scene['transition'],
    sceneType: 'react',
    canvasCode: '',
    canvasBackgroundCode: '',
    sceneCode: '',
    reactCode: '',
    sceneHTML: '',
    sceneStyles: '',
    lottieSource: '',
    d3Data: null,
    interactions: [],
    variables: [],
    aiLayers: [],
    messages: [],
    styleOverride: {} as Scene['styleOverride'],
    cameraMotion: null,
    worldConfig: null,
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-tier2-test-'))
  process.env.DREAMBYTE_TIER2_EXPORT = 'true'
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  if (ORIGINAL_FLAG === undefined) delete process.env.DREAMBYTE_TIER2_EXPORT
  else process.env.DREAMBYTE_TIER2_EXPORT = ORIGINAL_FLAG
})

describe('exportProjectToTier2', () => {
  it('refuses to run when feature flag is off', async () => {
    delete process.env.DREAMBYTE_TIER2_EXPORT
    await expect(
      exportProjectToTier2({ project: makeProject(), scenes: [], tier2Path: tmpRoot }),
    ).rejects.toBeInstanceOf(Tier2DisabledError)
  })

  it('writes project.json + scene files + folder skeleton', async () => {
    const project = makeProject()
    const scenes = [makeScene('aaaaaaaa-1111-2222-3333-444444444444', 'Opener')]

    const result = await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })

    expect(result.ok).toBe(true)
    expect(result.filesWritten).toBeGreaterThan(0)

    // project.json
    const projectJson = JSON.parse(await fs.readFile(path.join(tmpRoot, 'project.json'), 'utf-8'))
    expect(projectJson.formatVersion).toBe(1)
    expect(projectJson.project.id).toBe(project.id)
    expect(projectJson.sceneOrder).toEqual([scenes[0].id])

    // per-scene dreambyte.json + html
    const dreambyteJsonPath = path.join(tmpRoot, 'scenes', `${scenes[0].id}.dreambyte.json`)
    const htmlPath = path.join(tmpRoot, 'scenes', `${scenes[0].id}.html`)
    const sceneJson = JSON.parse(await fs.readFile(dreambyteJsonPath, 'utf-8'))
    expect(sceneJson.id).toBe(scenes[0].id)
    expect(sceneJson.name).toBe('Opener')
    const html = await fs.readFile(htmlPath, 'utf-8')
    expect(html).toContain('<!doctype html>')

    // skeleton dirs exist
    await expect(fs.stat(path.join(tmpRoot, 'assets'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmpRoot, 'motion-presets'))).resolves.toBeDefined()

    // .gitignore created with sane defaults
    const gi = await fs.readFile(path.join(tmpRoot, '.gitignore'), 'utf-8')
    expect(gi).toContain('assets/')
  })

  it('is idempotent — re-running on the same root overwrites cleanly', async () => {
    const project = makeProject()
    const scenes = [makeScene('aaaaaaaa-1111-2222-3333-444444444444', 'Opener')]

    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })
    const before = await fs.readFile(path.join(tmpRoot, 'project.json'), 'utf-8')

    // mutate project, re-export
    project.name = 'Renamed'
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })
    const after = await fs.readFile(path.join(tmpRoot, 'project.json'), 'utf-8')

    expect(after).not.toEqual(before)
    expect(JSON.parse(after).project.name).toBe('Renamed')
  })

  it('preserves an existing user-edited .gitignore', async () => {
    const project = makeProject()
    const customGitignore = '# user customised\n*.tmp\nassets/\n'
    await fs.writeFile(path.join(tmpRoot, '.gitignore'), customGitignore)

    await exportProjectToTier2({ project, scenes: [], tier2Path: tmpRoot })

    const after = await fs.readFile(path.join(tmpRoot, '.gitignore'), 'utf-8')
    expect(after).toBe(customGitignore)
  })

  it('copies an existing rendered scene HTML when publicScenesDir provides one', async () => {
    const project = makeProject()
    const scenes = [makeScene('bbbbbbbb-1111-2222-3333-555555555555', 'Hero')]

    const publicDir = path.join(tmpRoot, '__public-scenes')
    await fs.mkdir(publicDir, { recursive: true })
    const renderedHtml = `<!doctype html><body>RENDERED ${scenes[0].id}</body>`
    await fs.writeFile(path.join(publicDir, `${scenes[0].id}.html`), renderedHtml)

    await exportProjectToTier2({
      project,
      scenes,
      tier2Path: tmpRoot,
      publicScenesDir: publicDir,
    })

    const out = await fs.readFile(path.join(tmpRoot, 'scenes', `${scenes[0].id}.html`), 'utf-8')
    expect(out).toBe(renderedHtml)
  })

  it('refuses to write a scene with a path-traversal id', async () => {
    const project = makeProject()
    const evil = makeScene('../../etc/passwd', 'Evil')
    await expect(exportProjectToTier2({ project, scenes: [evil], tier2Path: tmpRoot })).rejects.toBeInstanceOf(
      Tier2PathError,
    )
    const escaped = path.resolve('/etc/passwd.dreambyte.json')
    await expect(fs.access(escaped)).rejects.toBeDefined()
  })

  it('refuses scene ids with separators or null bytes', async () => {
    const project = makeProject()
    for (const badId of ['scene/with/slash', 'scene\0null', 'scene with space']) {
      const scene = makeScene(badId, 'Bad')
      await expect(exportProjectToTier2({ project, scenes: [scene], tier2Path: tmpRoot })).rejects.toBeInstanceOf(
        Tier2PathError,
      )
    }
  })
})

describe('assertSafeTier2Root', () => {
  it('rejects empty path', async () => {
    await expect(assertSafeTier2Root('')).rejects.toBeInstanceOf(Tier2PathError)
  })

  it('refuses obviously dangerous roots', async () => {
    await expect(assertSafeTier2Root('/')).rejects.toBeInstanceOf(Tier2PathError)
    await expect(assertSafeTier2Root('/etc')).rejects.toBeInstanceOf(Tier2PathError)
  })

  it('returns realpath for valid existing folder', async () => {
    const real = await assertSafeTier2Root(tmpRoot)
    expect(path.isAbsolute(real)).toBe(true)
  })

  it('accepts non-existent paths (caller may create them)', async () => {
    const ghost = path.join(tmpRoot, 'does-not-exist-yet')
    const real = await assertSafeTier2Root(ghost)
    expect(real).toBe(ghost)
  })
})
