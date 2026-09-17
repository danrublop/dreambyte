// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-timeline-wire-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db/index'
import { projects } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { persistScenesFromAgentRun } from '@/lib/db/queries/projects'
import { readProjectSceneBlob, writeProjectSceneBlob } from '@/lib/db/project-scene-storage'
import { timelineCarryOut } from './runner'
import { summarizeWorldTimelineForEditorState } from './tool-executor'
import type { Timeline } from '@/lib/types'
import type { ToolCallRecord } from './types'

const migrationsFolder = path.resolve(__dirname, '../db/migrations')
const emptyGraph = { nodes: [], edges: [] }
const emptyStyle = { presetId: null } as any

const TL: Timeline = {
  tracks: [
    {
      id: 't1',
      name: 'Main',
      type: 'video',
      clips: [
        {
          id: 'c1',
          trackId: 't1',
          sourceType: 'scene',
          sourceId: 's1',
          label: 'Scene 1',
          startTime: 0,
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          speed: 1,
          opacity: 1,
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          filters: [],
          keyframes: [],
          transition: null,
        },
      ],
      muted: false,
      locked: false,
      position: 0,
    },
  ],
  markers: [{ id: 'm1', time: 2 }],
  inPoint: 1,
  outPoint: 4,
} as any

function tc(toolName: string): ToolCallRecord {
  return { id: crypto.randomUUID(), toolName, input: {}, output: { success: true } }
}

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
async function getDesc(id: string) {
  const [row] = await db
    .select({ version: projects.version, description: projects.description })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  return row
}

// ── B2 carry-out gate (parity with the MCP TIMELINE_TOOL_NAMES gate) ──────────
describe('timelineCarryOut — gate mirrors MCP (B2)', () => {
  it('returns the timeline when a timeline tool ran this run', () => {
    expect(timelineCarryOut([tc('write_scene_code'), tc('clip')], TL)).toBe(TL)
  })

  it('returns undefined (no field) when NO timeline tool ran — payload regression', () => {
    expect(timelineCarryOut([tc('write_scene_code'), tc('verify_scene')], TL)).toBeUndefined()
  })

  it('returns undefined when a timeline tool ran but world.timeline is null', () => {
    expect(timelineCarryOut([tc('init_timeline')], null)).toBeUndefined()
  })

  it('recognizes every TIMELINE_TOOL name (trim/remove/place/marker)', () => {
    for (const name of ['clip', 'clip', 'place_clip', 'marker', 'clip']) {
      expect(timelineCarryOut([tc(name)], TL)).toBe(TL)
    }
  })
})

// ── B1 read_editor_state live timeline (OV#4) ─────────────────────────────────
describe('summarizeWorldTimelineForEditorState — live world.timeline (B1/OV#4)', () => {
  it('derives the summary from world.timeline (tracks/clips/ids/trims)', () => {
    const s = summarizeWorldTimelineForEditorState(TL)!
    expect(s.trackCount).toBe(1)
    expect(s.clipCount).toBe(1)
    expect(s.markerCount).toBe(1)
    expect(s.tracks[0].clips[0]).toMatchObject({
      id: 'c1',
      sourceId: 's1',
      sourceType: 'scene',
      startTime: 0,
      duration: 5,
      trimStart: 0,
      trimEnd: null,
    })
  })

  it('returns null when no timeline exists (agent must init or scan, not read stale UI)', () => {
    expect(summarizeWorldTimelineForEditorState(null)).toBeNull()
    expect(summarizeWorldTimelineForEditorState(undefined)).toBeNull()
  })

  it('reflects a mutation made earlier in the run (no two-timeline contradiction)', () => {
    // Simulate a move_clip having shifted c1 to 3s on the SAME world.timeline.
    const mutated: Timeline = JSON.parse(JSON.stringify(TL))
    mutated.tracks[0].clips[0].startTime = 3
    expect(summarizeWorldTimelineForEditorState(mutated)!.tracks[0].clips[0].startTime).toBe(3)
  })
})

// ── B2 persist: timeline lands in the blob under the version check ────────────
describe('persistScenesFromAgentRun — timeline blob persist (B2)', () => {
  it('persists the timeline into the description blob when a timeline tool ran', async () => {
    const id = await seed()
    const ok = await persistScenesFromAgentRun(
      id,
      { scenes: [], sceneGraph: emptyGraph as any, globalStyle: emptyStyle, timeline: TL },
      null,
    )
    expect(ok).toBe(true)
    const row = await getDesc(id)
    expect(row!.version).toBe(2) // version bumped under the guarded write
    expect(readProjectSceneBlob(row!.description).timeline).toEqual(TL)
  })

  it('leaves a stored timeline UNTOUCHED when timeline is undefined (scene-only run)', async () => {
    const id = await seed(writeProjectSceneBlob(null, { timeline: TL }))
    const ok = await persistScenesFromAgentRun(
      id,
      { scenes: [{ id: 's9' }] as any, sceneGraph: emptyGraph as any, globalStyle: emptyStyle },
      null,
    )
    expect(ok).toBe(true)
    const blob = readProjectSceneBlob((await getDesc(id))!.description)
    // The scene-only write must not wipe the timeline that was already there.
    expect(blob.timeline).toEqual(TL)
    expect(blob.scenes.map((s: any) => s.id)).toEqual(['s9'])
  })

  it('preserves markers/inPoint/outPoint through the blob round-trip', async () => {
    const id = await seed()
    await persistScenesFromAgentRun(
      id,
      { scenes: [], sceneGraph: emptyGraph as any, globalStyle: emptyStyle, timeline: TL },
      null,
    )
    const blob = readProjectSceneBlob((await getDesc(id))!.description)
    expect(blob.timeline.markers).toEqual([{ id: 'm1', time: 2 }])
    expect(blob.timeline.inPoint).toBe(1)
    expect(blob.timeline.outPoint).toBe(4)
  })
})
