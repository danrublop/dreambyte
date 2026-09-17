// Tier 2 file mirror — import/reconcile side.
//
// Read a `.dreambyte/` folder back into DB-shaped state. Pairs with
// `tier2-export.ts` to give round-trip portability:
//
//   exportProjectToTier2(...)       DB → files
//   importProjectFromTier2(...)     files → DB
//
// The regression contract is
// **lossless round-trip**: starting from any DB state, exporting then
// importing must produce byte-identical Project + Scene[]. The
// round-trip test in this module's spec file is the load-bearing check.
//
// There is no conflict modal: scene-level
// mutual exclusion makes "concurrent edit" impossible by construction.
// This module therefore does NOT do diffing or merging — it returns the
// reconciled state plus a `warnings` array. Callers (the IPC layer) are
// responsible for skipping scenes whose DB-side lock is held by another
// editor.
//
// Path safety: caller must pass a tier2Path validated by
// `assertSafeTier2Root` (export-side helper). We do not re-validate
// here, but we read with O_NOFOLLOW semantics by going through the
// already-resolved realpath.

import path from 'node:path'
import fs from 'node:fs/promises'
import type { Project } from '../types/project'
import type { Scene } from '../types/scene'
import { assertSafeTier2Root } from './tier2-export'

const FEATURE_FLAG = 'DREAMBYTE_TIER2_EXPORT'
const SUPPORTED_FORMAT_VERSION = 1

export class Tier2ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Tier2ImportError'
  }
}

export class Tier2DisabledError extends Error {
  constructor() {
    super(`Tier 2 import is disabled. Set ${FEATURE_FLAG}=true to enable.`)
    this.name = 'Tier2DisabledError'
  }
}

// A malicious .dreambyte/ folder could ship project.json with sceneOrder
// like ["../../../etc/passwd"] — path.join would resolve outside the
// root and read or (after re-export) write arbitrary files. Mirror the
// regex used by src/lib/agents/dreambyte-fs/tools.ts and src/lib/storage/tier2-export.ts.
const SAFE_SCENE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export interface ImportArgs {
  tier2Path: string
  /**
   * Defaults to the module-level supported version. Tests can override
   * to assert format-version mismatch handling without bumping the
   * production constant.
   */
  expectedFormatVersion?: number
}

export interface ImportResult {
  ok: true
  project: Project
  scenes: Scene[]
  /** Non-fatal issues — listed scene without a dreambyte.json, ignored extras, etc. */
  warnings: string[]
  rootRealPath: string
}

/**
 * Read a Tier 2 folder and reconstruct DB-shaped state.
 *
 * Throws Tier2DisabledError if the feature flag is off.
 * Throws Tier2ImportError on fatal issues (missing project.json,
 * corrupt JSON, unsupported format version).
 *
 * Non-fatal issues land in `warnings` so callers can surface them
 * without aborting the load.
 */
export async function importProjectFromTier2(args: ImportArgs): Promise<ImportResult> {
  if (process.env[FEATURE_FLAG] !== 'true') {
    throw new Tier2DisabledError()
  }
  const expectedVersion = args.expectedFormatVersion ?? SUPPORTED_FORMAT_VERSION
  const root = await assertSafeTier2Root(args.tier2Path)
  const warnings: string[] = []

  // 1. project.json — mandatory.
  const projectJsonPath = path.join(root, 'project.json')
  let projectFileText: string
  try {
    projectFileText = await fs.readFile(projectJsonPath, 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Tier2ImportError(`No project.json at ${projectJsonPath}`)
    }
    throw new Tier2ImportError(`Cannot read project.json: ${(err as Error).message}`)
  }
  let projectFile: {
    formatVersion?: number
    project?: Partial<Project>
    sceneOrder?: string[]
  }
  try {
    projectFile = JSON.parse(projectFileText)
  } catch (err: unknown) {
    throw new Tier2ImportError(`Corrupt project.json: ${(err as Error).message}`)
  }
  if (projectFile.formatVersion !== expectedVersion) {
    throw new Tier2ImportError(
      `Unsupported Tier 2 formatVersion ${projectFile.formatVersion} (expected ${expectedVersion})`,
    )
  }
  if (!projectFile.project || typeof projectFile.project !== 'object') {
    throw new Tier2ImportError(`project.json is missing the "project" field`)
  }
  if (!Array.isArray(projectFile.sceneOrder)) {
    throw new Tier2ImportError(`project.json is missing the "sceneOrder" array`)
  }

  // 2. Per-scene dreambyte.json — read in declared order; warn (not throw)
  //    on missing files so a partial export is still loadable.
  const scenesDir = path.join(root, 'scenes')
  const scenes: Scene[] = []
  for (const sceneId of projectFile.sceneOrder) {
    if (typeof sceneId !== 'string' || !SAFE_SCENE_ID_RE.test(sceneId)) {
      warnings.push(`Scene id "${String(sceneId)}" rejected — must match ${SAFE_SCENE_ID_RE}.`)
      continue
    }
    const dreambyteJsonPath = path.join(scenesDir, `${sceneId}.dreambyte.json`)
    let sceneText: string
    try {
      sceneText = await fs.readFile(dreambyteJsonPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        warnings.push(`Scene "${sceneId}" listed in sceneOrder but no dreambyte.json found — skipped.`)
        continue
      }
      throw new Tier2ImportError(`Cannot read scene ${sceneId}: ${(err as Error).message}`)
    }
    let scene: Scene
    try {
      scene = JSON.parse(sceneText) as Scene
    } catch (err: unknown) {
      throw new Tier2ImportError(`Corrupt dreambyte.json for scene ${sceneId}: ${(err as Error).message}`)
    }
    if (scene.id !== sceneId) {
      warnings.push(
        `Scene file ${sceneId}.dreambyte.json carries id "${scene.id}" — using folder-derived id "${sceneId}" as canonical.`,
      )
      scene.id = sceneId
    }
    scenes.push(scene)
  }

  // 3. Detect orphan dreambyte.json files (in scenes/ but not in sceneOrder)
  //    so callers can warn the user. We do NOT auto-import them — sceneOrder
  //    is the project's source of truth for which scenes belong.
  try {
    const entries = await fs.readdir(scenesDir)
    const orderedSet = new Set(projectFile.sceneOrder)
    for (const entry of entries) {
      if (!entry.endsWith('.dreambyte.json')) continue
      const id = entry.slice(0, -'.dreambyte.json'.length)
      if (!orderedSet.has(id)) {
        warnings.push(`Found orphan scene file ${entry} — not in sceneOrder, ignored.`)
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Could not enumerate scenes/: ${(err as Error).message}`)
    }
  }

  // 4. Reassemble Project. The export side strips runtime-only fields; we
  //    take the import file as authoritative for everything it contains.
  const project = projectFile.project as Project

  return { ok: true, project, scenes, warnings, rootRealPath: root }
}

/**
 * Helper for the regression contract: returns true iff a previous
 * exportProjectToTier2(P, S) followed by importProjectFromTier2() yields
 * byte-identical project.json and scene dreambyte.json content.
 *
 * Caller composes the round trip; this helper just normalizes both sides
 * to JSON strings so test assertions can compare cleanly.
 */
export function projectsAreByteIdentical(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function scenesAreByteIdentical(a: Scene[], b: Scene[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}
