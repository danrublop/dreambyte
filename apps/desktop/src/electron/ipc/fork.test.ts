// @vitest-environment node

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cench-fork-test-'))
const tmpDb = path.join(tmpRoot, 'test.db')
const uploadsDir = path.join(tmpRoot, 'uploads')
const scenesDir = path.join(tmpRoot, 'scenes')
process.env.DATABASE_URL = `file:${tmpDb}`
process.env.DREAMBYTE_UPLOADS_DIR = uploadsDir
process.env.DREAMBYTE_UPLOADS_URL_BASE = '/uploads/'
process.env.DREAMBYTE_SCENES_DIR = scenesDir

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fsPromises from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/lib/db/migrate'
import { db, closeDb } from '@/lib/db'
import { projects, projectBranches, projectAssets, scenes } from '@/lib/db/schema'
import { createBranch, getDefaultBranch } from '@/lib/db/queries/branches'
import { forkBranchToProject, sweepOrphanForks } from './fork'

const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations')

beforeAll(async () => {
  mkdirSync(uploadsDir, { recursive: true })
  mkdirSync(scenesDir, { recursive: true })
  await runMigrations({ url: `file:${tmpDb}`, migrationsFolder })
})

afterAll(async () => {
  await closeDb()
  rmSync(tmpRoot, { recursive: true, force: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  // Test isolation: clear branch locks so a live 'fork' lock left by one test
  // can't make a later sweepOrphanForks defer (B6's guard is global) — the
  // suite was order-dependent without this.
  const { branchLocks } = await import('@/lib/db/schema')
  await db.delete(branchLocks)
})

/** Seed a source project: 1 branch, 1 asset (+file), 1 scene (+HTML) that
 *  references the asset by URL (sceneBlob + videoLayer) and by bare id. */
async function seedSource() {
  const projectId = crypto.randomUUID()
  await db.insert(projects).values({ id: projectId, name: 'Source', status: 'ready' })
  const branch = await createBranch({ projectId, name: 'main', isDefault: true })

  const assetId = crypto.randomUUID()
  const assetFile = `${assetId}_clip.mp4`
  const assetUrl = `/uploads/projects/${projectId}/${assetFile}`
  const srcAssetDir = path.join(uploadsDir, 'projects', projectId)
  mkdirSync(srcAssetDir, { recursive: true })
  writeFileSync(path.join(srcAssetDir, assetFile), 'VIDEO-BYTES')
  await db.insert(projectAssets).values({
    id: assetId,
    projectId,
    filename: 'clip.mp4',
    name: 'Clip',
    storagePath: path.join(srcAssetDir, assetFile),
    publicUrl: assetUrl,
    type: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 11,
  })

  const sceneId = crypto.randomUUID()
  await db.insert(scenes).values({
    id: sceneId,
    projectId,
    position: 0,
    duration: 8,
    branchId: branch.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    videoLayer: { enabled: true, src: assetUrl, opacity: 1, trimStart: 0, trimEnd: null } as any,
    sceneBlob: {
      id: sceneId,
      branchId: branch.id,
      projectId,
      videoLayer: { src: assetUrl },
      placements: [{ assetId, x: 0, y: 0 }],
    } as Record<string, unknown>,
  })
  // HTML embeds the source asset URL so the fork must rewrite it to be standalone.
  writeFileSync(
    path.join(scenesDir, `${sceneId}.html`),
    `<html><body><video src="${assetUrl}"></video><!-- asset:${assetId} --></body></html>`,
  )

  return { projectId, branchId: branch.id, assetId, assetUrl, sceneId }
}

describe('forkBranchToProject', () => {
  it('produces a fully standalone project with rewritten asset refs', async () => {
    const src = await seedSource()
    const result = await forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId })

    expect(result.sceneCount).toBe(1)
    expect(result.assetCount).toBe(1)
    const newPid = result.projectId

    // Project is ready and openable.
    const [proj] = await db.select().from(projects).where(eq(projects.id, newPid)).limit(1)
    expect(proj.status).toBe('ready')
    expect(proj.name).toContain('fork')

    // New default branch carries the scene.
    const newBranch = await getDefaultBranch(newPid)
    const cloned = await db.select().from(scenes).where(eq(scenes.branchId, newBranch!.id))
    expect(cloned).toHaveLength(1)
    const scene = cloned[0]

    // Asset references rewritten to the NEW project, in every surface.
    const blob = scene.sceneBlob as Record<string, any>
    const vlayer = scene.videoLayer as Record<string, any>
    expect(blob.videoLayer.src).toContain(`/projects/${newPid}/`)
    expect(blob.videoLayer.src).not.toContain(src.projectId)
    expect(vlayer.src).toContain(`/projects/${newPid}/`)
    expect(vlayer.src).not.toContain(src.projectId)
    // The bare-id placement was remapped to the new asset id.
    const [newAsset] = await db.select().from(projectAssets).where(eq(projectAssets.projectId, newPid))
    expect(blob.placements[0].assetId).toBe(newAsset.id)
    expect(newAsset.id).not.toBe(src.assetId)

    // Asset file copied into the new project's dir.
    const newFile = (newAsset.publicUrl as string).split('/').pop()!
    expect(existsSync(path.join(uploadsDir, 'projects', newPid, newFile))).toBe(true)

    // Scene HTML copied for the new scene id.
    expect(existsSync(path.join(scenesDir, `${scene.id}.html`))).toBe(true)

    // Source is untouched.
    const [srcScene] = await db.select().from(scenes).where(eq(scenes.id, src.sceneId)).limit(1)
    expect((srcScene.sceneBlob as Record<string, any>).videoLayer.src).toBe(src.assetUrl)
    expect(existsSync(path.join(uploadsDir, 'projects', src.projectId, `${src.assetId}_clip.mp4`))).toBe(true)
  })

  it('copies assets stored in the ingested/ subdir (URL/yt-dlp media)', async () => {
    const src = await seedSource()
    // Add an ingested asset: file lives under projects/<id>/ingested/<assetId>.mp4
    const ingId = crypto.randomUUID()
    const ingDir = path.join(uploadsDir, 'projects', src.projectId, 'ingested')
    mkdirSync(ingDir, { recursive: true })
    writeFileSync(path.join(ingDir, `${ingId}.mp4`), 'INGESTED')
    await db.insert(projectAssets).values({
      id: ingId,
      projectId: src.projectId,
      filename: 'yt.mp4',
      name: 'YT',
      storagePath: path.join(ingDir, `${ingId}.mp4`),
      publicUrl: `/uploads/projects/${src.projectId}/ingested/${ingId}.mp4`,
      type: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 8,
    })

    const result = await forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId })
    const newPid = result.projectId

    const ingested = (await db.select().from(projectAssets).where(eq(projectAssets.projectId, newPid))).find(
      (a) => (a.publicUrl as string).includes('/ingested/'),
    )!
    // URL keeps the ingested/ segment and points at the new project.
    expect(ingested.publicUrl).toContain(`/projects/${newPid}/ingested/`)
    expect(ingested.publicUrl).not.toContain(src.projectId)
    // The actual file was copied into the new project's ingested dir.
    const newName = (ingested.publicUrl as string).split('/').pop()!
    expect(existsSync(path.join(uploadsDir, 'projects', newPid, 'ingested', newName))).toBe(true)
  })

  it('skips symlinks in the upload tree instead of copying their targets (B7)', async () => {
    const src = await seedSource()

    // A file OUTSIDE the project's upload tree + a symlink to it inside.
    const outside = path.join(tmpRoot, 'outside-secret.txt')
    writeFileSync(outside, 'OUTSIDE-CONTENT')
    const srcProjectDir = path.join(uploadsDir, 'projects', src.projectId)
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outside, path.join(srcProjectDir, 'sneaky-link.txt'))

    const result = await forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId })
    const newPid = result.projectId

    // The legit asset copied; the symlink (and its target's content) did not.
    const dstDir = path.join(uploadsDir, 'projects', newPid)
    const copied = await fsPromises.readdir(dstDir)
    expect(copied.some((f) => f.endsWith('_clip.mp4'))).toBe(true)
    expect(copied).not.toContain('sneaky-link.txt')
  })

  it('rolls back rows + files when the copy fails mid-fork', async () => {
    const src = await seedSource()
    const projectsBefore = (await db.select({ id: projects.id }).from(projects)).length

    // Force the asset file copy to throw.
    vi.spyOn(fsPromises, 'copyFile').mockRejectedValue(new Error('disk full'))

    await expect(
      forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId }),
    ).rejects.toThrow()

    // No leftover project (the half-built fork was deleted) and source intact.
    const projectsAfter = await db.select({ id: projects.id, status: projects.status }).from(projects)
    expect(projectsAfter).toHaveLength(projectsBefore)
    expect(projectsAfter.some((p) => p.status === 'forking')).toBe(false)
    // No orphan branch/scene/asset rows beyond the source's.
    const branchesForSrc = await db.select().from(projectBranches).where(eq(projectBranches.projectId, src.projectId))
    expect(branchesForSrc).toHaveLength(1)
  })

  it('rewrites copied scene HTML to fork-local asset refs (standalone after source delete)', async () => {
    const src = await seedSource()
    const result = await forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId })
    const newPid = result.projectId

    const newBranch = await getDefaultBranch(newPid)
    const [cloned] = await db.select().from(scenes).where(eq(scenes.branchId, newBranch!.id))
    const [newAsset] = await db.select().from(projectAssets).where(eq(projectAssets.projectId, newPid))

    // The forked scene's HTML must point at the NEW project + asset, not the source.
    const forkedHtml = await fsPromises.readFile(path.join(scenesDir, `${cloned.id}.html`), 'utf-8')
    expect(forkedHtml).toContain(`/projects/${newPid}/`)
    expect(forkedHtml).not.toContain(src.projectId)
    expect(forkedHtml).not.toContain(src.assetId)
    expect(forkedHtml).toContain(newAsset.id)

    // Simulate the source project being deleted entirely — files and dir gone.
    rmSync(path.join(uploadsDir, 'projects', src.projectId), { recursive: true, force: true })
    rmSync(path.join(scenesDir, `${src.sceneId}.html`), { force: true })

    // The fork still "renders": its HTML references its OWN asset file, which exists.
    const forkAssetFile = (newAsset.publicUrl as string).split('/').pop()!
    expect(existsSync(path.join(uploadsDir, 'projects', newPid, forkAssetFile))).toBe(true)
    const stillStandalone = await fsPromises.readFile(path.join(scenesDir, `${cloned.id}.html`), 'utf-8')
    expect(stillStandalone).toContain(newAsset.id)
  })

  it('fails the fork (rolls back) when a scene HTML copy fails', async () => {
    const src = await seedSource()
    const projectsBefore = (await db.select({ id: projects.id }).from(projects)).length

    // Force the scene-HTML read to throw (asset file copies still succeed). The
    // fork must treat this as fatal and roll back, not silently produce a fork
    // with stale/missing scene HTML.
    const realReadFile = fsPromises.readFile
    vi.spyOn(fsPromises, 'readFile').mockImplementation(((p: any, ...rest: any[]) => {
      if (typeof p === 'string' && p.endsWith(`${src.sceneId}.html`)) {
        return Promise.reject(Object.assign(new Error('EIO: read error'), { code: 'EIO' }))
      }
      return (realReadFile as any)(p, ...rest)
    }) as any)

    await expect(
      forkBranchToProject({ sourceProjectId: src.projectId, sourceBranchId: src.branchId }),
    ).rejects.toThrow()

    // No leftover forking project; source intact.
    const projectsAfter = await db.select({ id: projects.id, status: projects.status }).from(projects)
    expect(projectsAfter).toHaveLength(projectsBefore)
    expect(projectsAfter.some((p) => p.status === 'forking')).toBe(false)
  })
})

describe('sweepOrphanForks', () => {
  it('reclaims an old forking project but spares a recent one', async () => {
    const oldId = crypto.randomUUID()
    const recentId = crypto.randomUUID()
    const longAgo = new Date(Date.now() - 60 * 60 * 1000) // 1h ago
    await db.insert(projects).values({ id: oldId, name: 'crashed', status: 'forking', updatedAt: longAgo })
    await db.insert(projects).values({ id: recentId, name: 'in-flight', status: 'forking' })

    const swept = await sweepOrphanForks()
    expect(swept).toBeGreaterThanOrEqual(1)

    expect((await db.select().from(projects).where(eq(projects.id, oldId))).length).toBe(0)
    expect((await db.select().from(projects).where(eq(projects.id, recentId))).length).toBe(1)
  })

  it('B6: defers the whole cycle while a fork lock is live, then reclaims once it expires', async () => {
    const { branchLocks } = await import('@/lib/db/schema')
    // A stale orphan that WOULD be reclaimed…
    const staleId = crypto.randomUUID()
    const longAgo = new Date(Date.now() - 60 * 60 * 1000)
    await db.insert(projects).values({ id: staleId, name: 'crashed', status: 'forking', updatedAt: longAgo })
    // …and a live fork lock on some unrelated source branch (no lineage exists
    // dest→lock, so the sweep must be globally conservative).
    const srcProjectId = crypto.randomUUID()
    await db.insert(projects).values({ id: srcProjectId, name: 'src', status: 'ready' })
    const srcBranch = await createBranch({ projectId: srcProjectId, name: 'fork-src' })
    await db.insert(branchLocks).values({
      branchId: srcBranch.id,
      projectId: srcProjectId,
      ownerId: 'window-2',
      operation: 'fork',
      heartbeatAt: new Date(), // live
    })

    expect(await sweepOrphanForks()).toBe(0)
    expect((await db.select().from(projects).where(eq(projects.id, staleId))).length).toBe(1)

    // Lock heartbeat goes stale (holder crashed) → next sweep reclaims.
    await db
      .update(branchLocks)
      .set({ heartbeatAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(branchLocks.branchId, srcBranch.id))
    expect(await sweepOrphanForks()).toBeGreaterThanOrEqual(1)
    expect((await db.select().from(projects).where(eq(projects.id, staleId))).length).toBe(0)
  })
})

describe('loadProjectOrThrow forking guard', () => {
  it('rejects a half-built fork by id (hidden from list, must not open directly)', async () => {
    const { loadProjectOrThrow } = await import('./_helpers')
    const forkingId = crypto.randomUUID()
    await db.insert(projects).values({ id: forkingId, name: 'half-built', status: 'forking' })

    await expect(loadProjectOrThrow(forkingId)).rejects.toThrow('still being forked')
  })

  it('still loads a ready project', async () => {
    const { loadProjectOrThrow } = await import('./_helpers')
    const readyId = crypto.randomUUID()
    await db.insert(projects).values({ id: readyId, name: 'ready', status: 'ready' })

    await expect(loadProjectOrThrow(readyId)).resolves.toMatchObject({ id: readyId })
  })
})
