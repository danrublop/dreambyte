// @vitest-environment node
//
// PR-D (D2) — reference tokens flow into create_design_brief AND persist as
// PROJECT-SCOPED memory. Integration: a real SQLite DB so the upsertMemory +
// getMemoriesScoped path (PR-B) is exercised end-to-end.
//   - reference tokens append a "Reference Match" section to the brief
//   - the brief's own explicit token value is NOT overridden by a reference
//   - salient tokens persist as project-scoped style memory (db assertion)

import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dreambyte-designmatch-test-'))
const tmpDb = path.join(tmpDir, 'test.db')
process.env.DATABASE_URL = `file:${tmpDb}`

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { users, projects } from '@/lib/db/schema'
import { getMemoriesScoped } from '@/lib/db/queries/user-memory'
import { createDesignToolHandler } from './design-tools'
import type { WorldStateMutable } from '@/lib/agents/world-state'
import type { StyleTokens } from '@/lib/agents/services/style-tokens'
import type { GlobalStyle, SceneGraph } from '@/lib/types'

const migrationsFolder = path.resolve(__dirname, '../../db/migrations')
const USER = '00000000-0000-4000-8000-0000000000d2'
let PROJECT_ID = ''

const handler = createDesignToolHandler()

// A complete, lint-passing DESIGN.md. The Colors section explicitly declares
// '#0f172a' — a reference palette that conflicts must NOT override it (D2
// precedence: the brief's explicit value wins).
const VALID_BRIEF = `---
title: Test Brief
---

## Overview
A test brief used by vitest to validate reference-token seeding into the brief.

\`\`\`yaml
colors:
  primary: '#0f172a'
typography:
  fontFamily: 'Satoshi'
spacing:
  base: 8
rounded:
  base: 4
\`\`\`

## Colors
Primary near-black #0f172a.

## Typography
fontFamily: 'Satoshi'

## Layout
Single column.

## Elevation
Flat.

## Shapes
Rounded 4px.

## Components
Card, button, input.

## Do's and Don'ts
Do use spacing tokens. Don't hard-code values.
`

function makeWorld(refTokens?: StyleTokens): WorldStateMutable {
  return {
    scenes: [],
    globalStyle: {
      presetId: null,
      paletteOverride: null,
      bgColorOverride: null,
      fontOverride: null,
      bodyFontOverride: null,
      strokeColorOverride: null,
    } as GlobalStyle,
    projectName: 'p',
    projectId: PROJECT_ID,
    authUserId: USER,
    currentRunId: 'run-designmatch',
    referenceStyleTokens: refTokens,
    outputMode: 'mp4',
    sceneGraph: { nodes: [], edges: [], startSceneId: null } as unknown as SceneGraph,
  } as unknown as WorldStateMutable
}

beforeAll(async () => {
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
  await db.insert(users).values({ id: USER, email: 'designmatch@dreambyte.local', name: 'DM Test' })
  PROJECT_ID = crypto.randomUUID()
  await db.insert(projects).values({ id: PROJECT_ID, userId: USER, name: 'DM Proj' })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('create_design_brief reference-token wiring (D2)', () => {
  it('augments the brief and persists tokens as project-scoped memory', async () => {
    const tokens: StyleTokens = {
      palette: ['#0f172a', '#c08457'], // #0f172a already in the brief; #c08457 is new
      fonts: ['condensed serif'],
      mood: 'warm archival',
      lighting: 'soft light',
      composition: 'centered composition',
      subjects: ['mug'],
    }
    const world = makeWorld(tokens)
    const result = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(result.success).toBe(true)

    const saved = world.globalStyle.designBrief as string
    // Reference appendix was added.
    expect(saved).toContain('## Reference Match')
    // A NEW token (palette color not in the brief) is appended.
    expect(saved).toContain('#c08457')
    expect(saved).toContain('warm archival')
    // Tool result reports what happened.
    const data = result.data as { referenceApplied: boolean; memoryKeysWritten: string[] }
    expect(data.referenceApplied).toBe(true)
    expect(data.memoryKeysWritten).toContain('reference_palette')
    expect(data.memoryKeysWritten).toContain('reference_mood')
    // Subjects are content, not durable taste → never persisted.
    expect(data.memoryKeysWritten).not.toContain('reference_subjects')

    // DB assertion: tokens persisted as PROJECT-SCOPED style memory.
    const scoped = await getMemoriesScoped(USER, PROJECT_ID)
    const palette = scoped.find((m) => m.key === 'reference_palette')
    expect(palette?.layer).toBe('project')
    expect(palette?.value).toBe('#0f172a, #c08457')
    expect(palette && palette.confidence).toBeCloseTo(0.45, 5)
    expect(scoped.some((m) => m.key === 'reference_mood' && m.value === 'warm archival')).toBe(true)
  })

  it('does NOT override a token the brief already declares explicitly', async () => {
    // Reference asserts a DIFFERENT primary palette than the brief's #0f172a.
    // The brief still declares #0f172a; the appendix only adds the new color,
    // and the brief body retains its explicit value untouched.
    const tokens: StyleTokens = { palette: ['#0f172a'] /* same as brief — fully present */ }
    const world = makeWorld(tokens)
    const result = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(result.success).toBe(true)
    const saved = world.globalStyle.designBrief as string
    // Every palette fragment already present → no Reference Match appendix for it.
    const data = result.data as { referenceApplied: boolean }
    expect(data.referenceApplied).toBe(false)
    expect(saved).not.toContain('## Reference Match')
    // The brief's explicit #0f172a is intact and the brief equals the input.
    expect(saved).toBe(VALID_BRIEF.trim())
  })

  it('saves a plain brief unchanged when no reference tokens exist', async () => {
    const world = makeWorld(undefined)
    const result = await handler('create_design_brief', { content: VALID_BRIEF }, world)
    expect(result.success).toBe(true)
    expect(world.globalStyle.designBrief).toBe(VALID_BRIEF.trim())
  })
})
