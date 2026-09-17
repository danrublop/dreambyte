// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-mcp-persist-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db/index'
import { projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { persistMcpSceneWrite, persistThenSideEffects, MCP_PERSIST_FAILED_MESSAGE } from './mcp-handler'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'

const migrationsFolder = path.resolve(__dirname, '../db/migrations')
const emptyGraph = { nodes: [], edges: [] }

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})
afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seed(description?: string | null): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(projects).values({ id, name: `P ${id.slice(0, 6)}`, description: description ?? null })
  return id
}
async function getProject(id: string) {
  const [row] = await db
    .select({
      version: projects.version,
      description: projects.description,
      watermark: projects.watermark,
      globalStyle: projects.globalStyle,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  return row
}

describe('persistMcpSceneWrite — optimistic concurrency (v4 #9)', () => {
  it('bumps version and persists the timeline into the description blob', async () => {
    const id = await seed()
    const timeline = { tracks: [{ id: 't1', type: 'video', clips: [], position: 0 }], inPoint: 1 }
    const ok = await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline,
    })
    expect(ok).toBe(true)
    const row = await getProject(id)
    // The old MCP write was versionless and left this at 1 — the autosave clobber bug.
    expect(row!.version).toBe(2)
    expect(readProjectSceneBlob(row!.description).timeline).toEqual(timeline)
  })

  it('reads the CURRENT version and bumps from it (not hardcoded)', async () => {
    const id = await seed()
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: { a: 1 },
    })
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: { a: 2 },
    })
    expect((await getProject(id))!.version).toBe(3) // 1 → 2 → 3
  })

  it("merges ONLY .timeline onto the FRESH blob — a concurrent writer's scenes survive", async () => {
    const id = await seed(writeProjectSceneBlob(null, { scenes: [{ id: 's1' }], sceneGraph: emptyGraph }))
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: { v: 'T1' },
    })
    // Simulate an in-app autosave adding a scene to the blob, out-of-band, between MCP writes.
    const cur = await getProject(id)
    await db
      .update(projects)
      .set({ description: writeProjectSceneBlob(cur!.description, { scenes: [{ id: 's1' }, { id: 's2' }] }) })
      .where(eq(projects.id, id))
    // The next MCP write must re-read the fresh blob and preserve s2 (merge only .timeline).
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: { v: 'T2' },
    })
    const blob = readProjectSceneBlob((await getProject(id))!.description)
    expect(blob.timeline).toEqual({ v: 'T2' })
    expect(blob.scenes).toEqual([{ id: 's1' }, { id: 's2' }]) // NOT clobbered back to [s1]
  })

  it('returns false (no retry storm) when the project does not exist', async () => {
    const ok = await persistMcpSceneWrite({
      projectId: 'does-not-exist',
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: { x: 1 },
    })
    expect(ok).toBe(false)
  })

  it('writes the watermark column under the version check when provided (v5 T9/E2)', async () => {
    const id = await seed()
    const wm = { assetId: 'a1', position: 'bottom-right', opacity: 0.8, sizePercent: 12 }
    const ok = await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: null,
      watermark: wm,
    })
    expect(ok).toBe(true)
    const row = await getProject(id)
    // Same guarded update as the scene write: one transaction, version bumped.
    expect(row!.version).toBe(2)
    expect(row!.watermark).toEqual(wm)
  })

  it('leaves the watermark column untouched when watermark is undefined (tool did not run)', async () => {
    const id = await seed()
    const wm = { assetId: 'a1', position: 'top-left', opacity: 0.5, sizePercent: 10 }
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: null,
      watermark: wm,
    })
    // A later write WITHOUT a watermark must not clobber the stored one.
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: null,
    })
    expect((await getProject(id))!.watermark).toEqual(wm)
  })

  it('leaves the description untouched when timeline is null (scene-only tools) but still bumps version', async () => {
    const id = await seed('untouched-when-no-timeline')
    const ok = await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: null,
    })
    expect(ok).toBe(true)
    const row = await getProject(id)
    expect(row!.version).toBe(2)
    expect(row!.description).toBe('untouched-when-no-timeline')
  })

  it('globalStyle rides the version-checked update — style + scenes in ONE transaction (v5 T10/E6)', async () => {
    const id = await seed()
    const style = { presetId: 'whiteboard', palette: ['#fff', '#000', '#f00', '#0f0', '#00f'] }
    const timeline = { tracks: [], inPoint: 0 }
    const ok = await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline,
      globalStyle: style,
    })
    expect(ok).toBe(true)
    const row = await getProject(id)
    // ONE call → ONE version bump: the style landed in the same guarded
    // transaction as the scene/timeline write, not via the old bare
    // versionless update that sat next to it.
    expect(row!.version).toBe(2)
    expect(row!.globalStyle).toEqual(style)
    expect(readProjectSceneBlob(row!.description).timeline).toEqual(timeline)
  })

  it('leaves globalStyle untouched when undefined (no global_updated change)', async () => {
    const id = await seed()
    const before = (await getProject(id))!.globalStyle
    await persistMcpSceneWrite({
      projectId: id,
      scenes: [],
      sceneGraph: emptyGraph,
      branchId: null,
      timeline: null,
    })
    expect((await getProject(id))!.globalStyle).toEqual(before)
  })
})

describe('persistThenSideEffects — persist failure must fail the tool, BOTH exits (v5 T10/E5)', () => {
  function makeSpies() {
    return {
      notify: vi.fn(),
      writeHtml: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    }
  }

  it('persist returns false → no HTML write, no renderer notify, returns false', async () => {
    const { notify, writeHtml, onError } = makeSpies()
    const persisted = await persistThenSideEffects({
      persist: async () => false, // lock exhausted OR project row gone
      notifyRenderer: notify,
      writeSceneHtml: writeHtml,
      onPersistError: onError,
    })
    expect(persisted).toBe(false)
    expect(writeHtml).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('persist THROWS → same honest failure (the old catch swallowed this and wrote HTML anyway)', async () => {
    const { notify, writeHtml, onError } = makeSpies()
    const boom = new Error('db locked')
    const persisted = await persistThenSideEffects({
      persist: async () => {
        throw boom
      },
      notifyRenderer: notify,
      writeSceneHtml: writeHtml,
      onPersistError: onError,
    })
    expect(persisted).toBe(false)
    expect(writeHtml).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('[REGRESSION] success path unchanged: notify + HTML write both fire', async () => {
    const { notify, writeHtml, onError } = makeSpies()
    const persisted = await persistThenSideEffects({
      persist: async () => true,
      notifyRenderer: notify,
      writeSceneHtml: writeHtml,
      onPersistError: onError,
    })
    expect(persisted).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(writeHtml).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('executeMcpTool surfaces the failure as an explicit error response (source pin)', () => {
    // The response override can't be exercised without the full project-load/
    // lock pipeline, so pin the wiring: persistFailed → success:false with
    // MCP_PERSIST_FAILED_MESSAGE, and the bare versionless globalStyle update
    // next to the guarded write is GONE (E6).
    const src = readFileSync(path.resolve(process.cwd(), 'src/lib/agents/mcp-handler.ts'), 'utf8')
    expect(src).toMatch(/if \(persistFailed\) \{[\s\S]{0,600}?content: MCP_PERSIST_FAILED_MESSAGE/)
    expect(src).toMatch(/error: 'persist_failed'/)
    expect(src).not.toMatch(/\.set\(\{ globalStyle: world\.globalStyle \}/)
    expect(MCP_PERSIST_FAILED_MESSAGE).toMatch(/did not persist/)
    expect(MCP_PERSIST_FAILED_MESSAGE).toMatch(/Re-read the scene and retry/)
  })
})
