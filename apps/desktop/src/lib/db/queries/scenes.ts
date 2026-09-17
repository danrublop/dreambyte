import { db } from '../index'
import { scenes } from '../schema'
import { eq, and, asc } from 'drizzle-orm'

export async function getProjectScenesByBranch(projectId: string, branchId: string) {
  return db
    .select({
      id: scenes.id,
      name: scenes.name,
      position: scenes.position,
      duration: scenes.duration,
      thumbnailUrl: scenes.thumbnailUrl,
    })
    .from(scenes)
    .where(and(eq(scenes.projectId, projectId), eq(scenes.branchId, branchId)))
    .orderBy(asc(scenes.position))
}
