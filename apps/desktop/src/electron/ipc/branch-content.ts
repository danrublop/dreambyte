import path from 'node:path'
import fs from 'node:fs/promises'
import { resolveScenesDir } from '@/lib/scene-html-paths'
import type { SceneIdPair } from '@/lib/db/queries/branches'
import { createLogger } from '@/lib/logger'

const log = createLogger('electron.ipc.branch-content')

/**
 * Copy each source scene's HTML file to its cloned scene id, pairing by the
 * explicit old→new id map (never by row order). Scene HTML lives in one global
 * dir keyed by scene id, so this is correct for both intra-project clone and
 * cross-project fork — the destination scene always has a fresh id.
 *
 * Best-effort per file: a missing/failed source copy is logged, not thrown — an
 * absent HTML file is inert (the scene regenerates it on next save), so one bad
 * copy must not abort the whole clone/fork. Returns the list of destination
 * scene ids whose HTML was successfully written, so a fork can record them in
 * its rollback manifest.
 */
export async function copySceneHtmlFiles(idMap: SceneIdPair[]): Promise<{ writtenDstIds: string[] }> {
  if (idMap.length === 0) return { writtenDstIds: [] }
  const scenesDir = resolveScenesDir()
  const results = await Promise.allSettled(
    idMap.map(({ srcId, dstId }) =>
      fs.copyFile(path.join(scenesDir, `${srcId}.html`), path.join(scenesDir, `${dstId}.html`)),
    ),
  )
  const writtenDstIds: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      writtenDstIds.push(idMap[i].dstId)
    } else {
      log.warn('scene HTML copy failed', {
        extra: { src: idMap[i].srcId, dst: idMap[i].dstId },
        error: (r as PromiseRejectedResult).reason,
      })
    }
  })
  return { writtenDstIds }
}
