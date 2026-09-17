// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { exportProjectToTier2 } from './tier2-export'
import {
  importProjectFromTier2,
  projectsAreByteIdentical,
  scenesAreByteIdentical,
  Tier2DisabledError,
  Tier2ImportError,
} from './tier2-import'
import type { Project } from '../types/project'
import type { Scene } from '../types/scene'

const ORIGINAL_FLAG = process.env.DREAMBYTE_TIER2_EXPORT
let tmpRoot: string

function makeProject(): Project {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Round Trip',
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

function makeScene(id: string, name: string, overrides: Partial<Scene> = {}): Scene {
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
    ...overrides,
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-tier2-import-test-'))
  process.env.DREAMBYTE_TIER2_EXPORT = 'true'
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  if (ORIGINAL_FLAG === undefined) delete process.env.DREAMBYTE_TIER2_EXPORT
  else process.env.DREAMBYTE_TIER2_EXPORT = ORIGINAL_FLAG
})

describe('importProjectFromTier2', () => {
  it('refuses to run when feature flag is off', async () => {
    delete process.env.DREAMBYTE_TIER2_EXPORT
    await expect(importProjectFromTier2({ tier2Path: tmpRoot })).rejects.toBeInstanceOf(Tier2DisabledError)
  })

  it('throws when project.json is missing', async () => {
    await expect(importProjectFromTier2({ tier2Path: tmpRoot })).rejects.toBeInstanceOf(Tier2ImportError)
  })

  it('throws on corrupt project.json', async () => {
    await fs.writeFile(path.join(tmpRoot, 'project.json'), '{not-json}')
    await expect(importProjectFromTier2({ tier2Path: tmpRoot })).rejects.toThrow(/Corrupt project.json/)
  })

  it('throws on unsupported format version', async () => {
    await fs.writeFile(
      path.join(tmpRoot, 'project.json'),
      JSON.stringify({ formatVersion: 999, project: {}, sceneOrder: [] }),
    )
    await expect(importProjectFromTier2({ tier2Path: tmpRoot })).rejects.toThrow(/Unsupported.*formatVersion 999/)
  })

  it('throws when sceneOrder is missing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'project.json'), JSON.stringify({ formatVersion: 1, project: { id: 'p' } }))
    await expect(importProjectFromTier2({ tier2Path: tmpRoot })).rejects.toThrow(/sceneOrder/)
  })

  it('warns (not errors) on a sceneOrder entry without a dreambyte.json file', async () => {
    const project = makeProject()
    const scenes = [makeScene('aaaaaaaa-1111-2222-3333-444444444444', 'Real')]
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })

    // Add a phantom scene to sceneOrder without a corresponding file
    const projJson = JSON.parse(await fs.readFile(path.join(tmpRoot, 'project.json'), 'utf-8'))
    projJson.sceneOrder.push('ghost-scene-id')
    await fs.writeFile(path.join(tmpRoot, 'project.json'), JSON.stringify(projJson))

    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(result.scenes).toHaveLength(1)
    expect(result.warnings.some((w) => w.includes('ghost-scene-id'))).toBe(true)
  })

  it('warns on orphan scene files not in sceneOrder', async () => {
    const project = makeProject()
    const scenes = [makeScene('aaaaaaaa-1111-2222-3333-444444444444', 'Real')]
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })

    // Drop an extra dreambyte.json file that's not in sceneOrder
    await fs.writeFile(
      path.join(tmpRoot, 'scenes', 'orphan-id.dreambyte.json'),
      JSON.stringify(makeScene('orphan-id', 'Orphan')),
    )

    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(result.warnings.some((w) => w.includes('orphan'))).toBe(true)
    // Orphan is NOT loaded — sceneOrder is authoritative
    expect(result.scenes.find((s) => s.id === 'orphan-id')).toBeUndefined()
  })

  it('warns when file id mismatches sceneOrder entry; folder id wins', async () => {
    const project = makeProject()
    const scenes = [makeScene('declared-id', 'Real')]
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })

    // Tamper: rewrite dreambyte.json with a different id field
    const tamperedScene = makeScene('declared-id', 'Tampered')
    tamperedScene.id = 'WRONG-ID-IN-FILE'
    await fs.writeFile(path.join(tmpRoot, 'scenes', 'declared-id.dreambyte.json'), JSON.stringify(tamperedScene))

    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(result.scenes[0].id).toBe('declared-id')
    expect(result.warnings.some((w) => w.includes('WRONG-ID-IN-FILE'))).toBe(true)
  })

  it('rejects path-traversal scene ids in sceneOrder without reading outside the root', async () => {
    const malicious = {
      formatVersion: 1,
      exportedAt: '2026-04-30T00:00:00.000Z',
      project: { id: 'p', name: 'Malicious', outputMode: 'mp4' },
      sceneOrder: ['../../../etc/passwd', 'normal-id'],
    }
    await fs.writeFile(path.join(tmpRoot, 'project.json'), JSON.stringify(malicious))
    await fs.mkdir(path.join(tmpRoot, 'scenes'), { recursive: true })

    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(result.warnings.some((w) => w.includes('rejected'))).toBe(true)
    expect(result.scenes.find((s) => String(s.id).includes('passwd'))).toBeUndefined()
    expect(result.scenes.find((s) => String(s.id).includes('..'))).toBeUndefined()
  })
})

describe('round-trip lossless contract', () => {
  // This is the critical regression test from MOTION_DSL_TEST_PLAN.md:
  // "Tier 2 round-trip is lossless — DB → files → DB produces byte-
  //  identical state." If this ever fails, the export and import sides
  // have drifted and we'll start losing data on app reload.

  it('preserves an empty project byte-identically', async () => {
    const project = makeProject()
    await exportProjectToTier2({ project, scenes: [], tier2Path: tmpRoot })
    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(scenesAreByteIdentical(result.scenes, [])).toBe(true)
  })

  it('preserves a single-scene project byte-identically', async () => {
    const project = makeProject()
    const scenes = [makeScene('aaaaaaaa-1111-2222-3333-444444444444', 'Hero')]
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })
    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(scenesAreByteIdentical(result.scenes, scenes)).toBe(true)
  })

  it('preserves multi-scene state with rich field content byte-identically', async () => {
    const project = makeProject()
    const scenes = [
      makeScene('s-1', 'Opener', { reactCode: 'export default () => <div>1</div>', duration: 5 }),
      makeScene('s-2', 'Middle', {
        reactCode: 'export default () => <div>2</div>',
        textOverlays: [
          {
            id: 't1',
            content: 'Hello',
            font: 'Inter',
            size: 48,
            color: '#fff',
            x: 50,
            y: 50,
            animation: 'fade-in',
            duration: 2,
            delay: 0,
          },
        ],
        aiLayers: [],
      }),
      makeScene('s-3', 'Closer', { duration: 8 }),
    ]
    await exportProjectToTier2({ project, scenes, tier2Path: tmpRoot })
    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(result.scenes).toHaveLength(scenes.length)
    expect(scenesAreByteIdentical(result.scenes, scenes)).toBe(true)
  })

  it('preserves PR4-era motion+burst+layoutTransition fields', async () => {
    // Forward-compat with the W1 PR4 type extensions. These fields should
    // round-trip through Tier 2 unchanged so a round-trip never strips
    // motion the agent set.
    const project = makeProject()
    const sceneWithMotion = makeScene('s-motion', 'Motion', {
      aiLayers: [
        {
          id: 'L1',
          type: 'image',
          motion: { kind: 'preset', preset: 'fadeInUp', durationFrames: 18 },
          burst: { count: 12, radius: 80, durationFrames: 18 },
        } as unknown as Scene['aiLayers'][number],
      ],
      layoutTransition: { kind: 'flip', durationFrames: 12 },
    })
    await exportProjectToTier2({ project, scenes: [sceneWithMotion], tier2Path: tmpRoot })
    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    expect(scenesAreByteIdentical(result.scenes, [sceneWithMotion])).toBe(true)
  })

  it('preserves project.json subset byte-identically', async () => {
    const project = makeProject()
    await exportProjectToTier2({ project, scenes: [], tier2Path: tmpRoot })
    const result = await importProjectFromTier2({ tier2Path: tmpRoot })
    // Compare only the fields the export side persists — the export
    // intentionally drops apiPermissions and tier2Path, so we expect
    // the imported project to omit those fields.
    const exported = (await import('node:fs/promises')).readFile(path.join(tmpRoot, 'project.json'), 'utf-8')
    const fileContent = JSON.parse(await exported)
    expect(projectsAreByteIdentical(result.project, fileContent.project)).toBe(true)
  })
})
