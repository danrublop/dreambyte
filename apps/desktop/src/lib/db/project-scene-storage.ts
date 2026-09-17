/**
 * Transitional storage adapter for project scene data.
 *
 * Today, scenes/graph are persisted in projects.description JSON.
 * This module centralizes read/write logic so we can migrate incrementally
 * to first-class tables without touching every route.
 */

export interface ProjectSceneBlob {
  scenes: any[]
  sceneGraph: any
  zdogLibrary?: any[]
  timeline?: any
}

export function readProjectSceneBlob(description: string | null | undefined): ProjectSceneBlob {
  if (!description) {
    return { scenes: [], sceneGraph: null, zdogLibrary: [] }
  }
  try {
    const parsed = JSON.parse(description)
    return {
      scenes: parsed.scenes || [],
      sceneGraph: parsed.sceneGraph || null,
      zdogLibrary: parsed.zdogLibrary || [],
      timeline: parsed.timeline || null,
    }
  } catch {
    return { scenes: [], sceneGraph: null, zdogLibrary: [] }
  }
}

export function writeProjectSceneBlob(
  existingDescription: string | null | undefined,
  updates: { scenes?: any[]; sceneGraph?: any; zdogLibrary?: any[]; zdogStudioLibrary?: any[]; timeline?: any },
): string {
  let existingData: Record<string, unknown> = {}
  if (existingDescription) {
    try {
      existingData = JSON.parse(existingDescription)
    } catch {
      existingData = {}
    }
  }

  const result: Record<string, unknown> = {
    ...existingData,
    scenes: updates.scenes !== undefined ? updates.scenes : existingData.scenes || [],
    sceneGraph: updates.sceneGraph !== undefined ? updates.sceneGraph : existingData.sceneGraph || null,
  }
  if (updates.zdogLibrary !== undefined) result.zdogLibrary = updates.zdogLibrary
  if (updates.zdogStudioLibrary !== undefined) result.zdogStudioLibrary = updates.zdogStudioLibrary
  if (updates.timeline !== undefined) result.timeline = updates.timeline

  return JSON.stringify(result)
}
