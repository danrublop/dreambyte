import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/queries/projects', () => ({ getProjectSettingsRow: vi.fn(), getProjectDescription: vi.fn() }))
vi.mock('@/lib/db/queries/branches', () => ({ getDefaultBranch: vi.fn(), backfillProjectBranch: vi.fn() }))
vi.mock('@/lib/db/project-scene-table', () => ({ readProjectScenesFromTables: vi.fn() }))

import { loadTargetProjectRow } from './load-target-project-row'
import { getProjectSettingsRow, getProjectDescription } from '@/lib/db/queries/projects'
import { getDefaultBranch, backfillProjectBranch } from '@/lib/db/queries/branches'
import { readProjectScenesFromTables } from '@/lib/db/project-scene-table'

const mockSettings = vi.mocked(getProjectSettingsRow)
const mockDefaultBranch = vi.mocked(getDefaultBranch)
const mockReadScenes = vi.mocked(readProjectScenesFromTables)
const mockDescription = vi.mocked(getProjectDescription)
const mockBackfill = vi.mocked(backfillProjectBranch)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function settingsRow(overrides: Record<string, any> = {}): any {
  return {
    name: 'Project B',
    outputMode: 'interactive',
    globalStyle: { presetId: 'neon' },
    mp4Settings: { fps: 60 },
    apiPermissions: { elevenLabs: 'deny' },
    audioProviderEnabled: { elevenLabs: false },
    mediaGenEnabled: { fal: true },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadTargetProjectRow', () => {
  it('returns null when the project does not exist (no branch/scene reads)', async () => {
    mockSettings.mockResolvedValue(null)
    expect(await loadTargetProjectRow('proj-X')).toBeNull()
    expect(mockDefaultBranch).not.toHaveBeenCalled()
    expect(mockReadScenes).not.toHaveBeenCalled()
  })

  it('maps columns + default branch, reading the scene graph branch-scoped', async () => {
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    mockReadScenes.mockResolvedValue({
      scenes: [{ id: 'b' }],
      sceneGraph: { nodes: [{ id: 'b' }], edges: [], startSceneId: 'b' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const row = await loadTargetProjectRow('proj-B')
    expect(row).toMatchObject({
      projectName: 'Project B',
      outputMode: 'interactive',
      audioProviderEnabled: { elevenLabs: false },
      mediaGenEnabled: { fal: true },
      defaultBranchId: 'branch-B',
      sceneGraph: { nodes: [{ id: 'b' }], edges: [], startSceneId: 'b' },
      scenes: [{ id: 'b' }], // B's own branch-scoped scenes
    })
    // The scene graph MUST be read scoped to the target's default branch.
    expect(mockReadScenes).toHaveBeenCalledWith('proj-B', 'branch-B')
  })

  it('backfills null-branch rows onto the default branch BEFORE the scoped read (no empty-leg clobber)', async () => {
    // A legacy target with branch_id=NULL scene rows would otherwise read as
    // {scenes:[]} on the scoped read and run empty, clobbering its real scenes
    // on persist. backfillProjectBranch must run first to stamp those rows.
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadScenes.mockResolvedValue({
      scenes: [{ id: 'b' }],
      sceneGraph: { nodes: [], edges: [], startSceneId: '' },
    } as any)
    await loadTargetProjectRow('proj-B')
    expect(mockBackfill).toHaveBeenCalledWith('proj-B')
    // Ordering: backfill must precede the scene-table read.
    expect(mockBackfill.mock.invocationCallOrder[0]).toBeLessThan(mockReadScenes.mock.invocationCallOrder[0])
  })

  it('scopes the sceneGraph to the branch — drops other-branch nodes/edges (readProjectScenesFromTables is graph-blind)', async () => {
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    mockReadScenes.mockResolvedValue({
      scenes: [{ id: 'b1' }, { id: 'b2' }], // this branch's scenes
      sceneGraph: {
        // graph rows are PROJECT-wide: includes an other-branch scene 'x'
        nodes: [{ id: 'b1' }, { id: 'b2' }, { id: 'x' }],
        edges: [
          { id: 'e-keep', fromSceneId: 'b1', toSceneId: 'b2' },
          { id: 'e-drop', fromSceneId: 'b2', toSceneId: 'x' },
        ],
        startSceneId: 'b1',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const row = await loadTargetProjectRow('proj-B')
    expect(row?.sceneGraph?.nodes).toEqual([{ id: 'b1' }, { id: 'b2' }]) // 'x' dropped
    expect(row?.sceneGraph?.edges).toEqual([{ id: 'e-keep', fromSceneId: 'b1', toSceneId: 'b2' }]) // 'e-drop' dropped
  })

  it('fails closed (returns null) when the target has no default branch', async () => {
    mockSettings.mockResolvedValue(settingsRow())
    mockDefaultBranch.mockResolvedValue(null)
    expect(await loadTargetProjectRow('proj-B')).toBeNull()
    expect(mockReadScenes).not.toHaveBeenCalled()
  })

  it('propagates (does NOT swallow) a DB read error', async () => {
    mockSettings.mockRejectedValue(new Error('db down'))
    await expect(loadTargetProjectRow('proj-B')).rejects.toThrow('db down')
  })

  it('passes null apiPermissions through unchanged (resolveLegBody fails closed on it)', async () => {
    mockSettings.mockResolvedValue(settingsRow({ apiPermissions: null }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadScenes.mockResolvedValue({ scenes: [], sceneGraph: { nodes: [], edges: [], startSceneId: '' } } as any)
    const row = await loadTargetProjectRow('proj-B')
    expect(row?.apiPermissions).toBeNull()
  })

  it('falls back to the legacy scene blob when the project has NO scene-table rows (un-migrated)', async () => {
    // readProjectScenesFromTables returns null when the project has zero table
    // rows — its scenes still live in the legacy description blob. The leg must
    // run against those REAL scenes (not [], which would clobber them on persist).
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    mockReadScenes.mockResolvedValue(null)
    mockDescription.mockResolvedValue(
      JSON.stringify({
        scenes: [{ id: 'blob-1' }, { id: 'blob-2' }],
        sceneGraph: { nodes: [{ id: 'blob-1' }], edges: [], startSceneId: 'blob-1' },
      }),
    )
    const row = await loadTargetProjectRow('proj-B')
    expect(row?.scenes).toEqual([{ id: 'blob-1' }, { id: 'blob-2' }])
    expect(row?.sceneGraph?.nodes).toEqual([{ id: 'blob-1' }]) // scoped to blob scenes
  })

  it('runs a brand-new empty project (no table rows, empty blob) with scenes:[] — NOT fail-closed', async () => {
    // A freshly created project has no scene-table rows and an empty/absent blob.
    // It is a legitimate dispatch target — the leg builds from scratch.
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    mockReadScenes.mockResolvedValue(null)
    mockDescription.mockResolvedValue(null)
    const row = await loadTargetProjectRow('proj-B')
    expect(row).not.toBeNull()
    expect(row?.scenes).toEqual([])
  })

  it('runs a legitimately empty branch (non-null tables, scenes:[]) — scenes from tables, timeline from the blob', async () => {
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReadScenes.mockResolvedValue({ scenes: [], sceneGraph: { nodes: [], edges: [], startSceneId: '' } } as any)
    // v6 TIMELINE: the NLE timeline lives ONLY in the description blob (no
    // projects.timeline column), so the blob IS read for it even when scenes
    // come from the tables. Scenes still come from the tables, not the blob.
    mockDescription.mockResolvedValue(
      JSON.stringify({ timeline: { tracks: [{ id: 'tl-1', type: 'video', clips: [], position: 0 }] } }),
    )
    const row = await loadTargetProjectRow('proj-B')
    expect(row).not.toBeNull()
    expect(row?.scenes).toEqual([]) // from tables
    expect(row?.timeline?.tracks?.[0]?.id).toBe('tl-1') // from the blob
  })

  it("loads B's timeline from the blob when scenes are blob-backed too", async () => {
    mockSettings.mockResolvedValue(settingsRow())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDefaultBranch.mockResolvedValue({ id: 'branch-B' } as any)
    mockReadScenes.mockResolvedValue(null) // no table rows → blob path
    mockDescription.mockResolvedValue(
      JSON.stringify({
        scenes: [{ id: 'blob-1' }],
        timeline: { tracks: [{ id: 'tl-9', type: 'video', clips: [], position: 0 }] },
      }),
    )
    const row = await loadTargetProjectRow('proj-B')
    expect(row?.timeline?.tracks?.[0]?.id).toBe('tl-9')
  })
})
