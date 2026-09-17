'use client'

import { v4 as uuidv4 } from 'uuid'
import type { Scene, SceneNode, SceneEdge } from '../types'
import { generateSceneHTML } from '../sceneTemplate'
import { resolveProjectDimensions } from '../dimensions'
import { createCapabilityShowcaseScenes } from '../capabilityShowcaseScenes'
import { createThreeEnvironmentShowcaseScenes } from '../threeEnvironmentShowcaseScenes'
import { createReactShowcaseScenes } from '../reactShowcaseScenes'
import type { Set, Get } from './types'
import { createLogger } from '../logger'

const log = createLogger('store.dev')

// Seed/showcase helpers all write the same shape: one HTML file per scene
// to the scenes directory. Fire-and-forget in every case (these are dev
// test flows; a single failed write shouldn't halt seeding).
async function writeSceneHtmlSilent(id: string, html: string): Promise<void> {
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.scene : undefined
  if (!ipc) return
  try {
    await ipc.writeHtml({ id, html })
  } catch {
    // dev-seed writes are non-fatal
  }
}

export function createDevActions(set: Set, get: Get) {
  return {
    seedReactShowcaseScenes: async () => {
      const reactScenes = createReactShowcaseScenes()
      for (const scene of reactScenes) {
        const html = generateSceneHTML(
          scene,
          get().globalStyle,
          undefined,
          get().audioSettings,
          resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, get().project.mp4Settings?.resolution),
        )
        await writeSceneHtmlSilent(scene.id, html)
      }
      set((state) => ({
        scenes: [...state.scenes, ...reactScenes],
        selectedSceneId: reactScenes[0].id,
        sceneHtmlVersion: state.sceneHtmlVersion + 1,
      }))
    },

    seedCapabilityShowcaseScenes: async () => {
      const showcaseScenes = createCapabilityShowcaseScenes()
      for (const scene of showcaseScenes) {
        const html = generateSceneHTML(
          scene,
          get().globalStyle,
          undefined,
          get().audioSettings,
          resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, get().project.mp4Settings?.resolution),
        )
        await writeSceneHtmlSilent(scene.id, html)
      }
      set((state) => ({
        scenes: [...state.scenes, ...showcaseScenes],
        selectedSceneId: showcaseScenes[0].id,
        sceneHtmlVersion: state.sceneHtmlVersion + 1,
      }))
    },

    seedThreeEnvironmentShowcaseScenes: async () => {
      const envScenes = createThreeEnvironmentShowcaseScenes()
      for (const scene of envScenes) {
        const html = generateSceneHTML(
          scene,
          get().globalStyle,
          undefined,
          get().audioSettings,
          resolveProjectDimensions(get().project.mp4Settings?.aspectRatio, get().project.mp4Settings?.resolution),
        )
        await writeSceneHtmlSilent(scene.id, html)
      }
      set((state) => ({
        scenes: [...state.scenes, ...envScenes],
        selectedSceneId: envScenes[0].id,
        sceneHtmlVersion: state.sceneHtmlVersion + 1,
      }))
    },
  }
}
