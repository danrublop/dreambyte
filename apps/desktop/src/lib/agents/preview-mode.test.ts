// @vitest-environment node

process.env.DATABASE_URL = 'file::memory:'

import { describe, it, expect, beforeEach } from 'vitest'

import { executeTool, type WorldStateMutable } from './tool-executor'
import { ALL_TOOLS } from './tools'
import { createDefaultProject, createDefaultScene } from '../store/helpers'

/**
 * Direct coverage for the Phase 3.2 diff-preview gate. Exercises the real
 * executor + a real tool (scene_props) so we're testing the wire
 * the renderer actually flows through, not a mock.
 */

function emptyWorld(previewMode?: 'off' | 'destructive-only' | 'always'): WorldStateMutable {
  const scene = createDefaultScene()
  return {
    scenes: [scene],
    globalStyle: { presetId: null } as unknown as WorldStateMutable['globalStyle'],
    projectName: 'test',
    outputMode: 'mp4',
    sceneGraph: createDefaultProject([scene]).sceneGraph,
    ...(previewMode ? { previewMode } : {}),
  }
}

describe('diff-preview gate (Phase 3.2)', () => {
  describe('tool registry tagging', () => {
    it('write_scene_code is tagged mutates: scene', () => {
      const def = ALL_TOOLS.find((t) => t.name === 'write_scene_code')
      expect(def?.mutates).toBe('scene')
    })

    it('delete_scene is tagged mutates: scene', () => {
      const def = ALL_TOOLS.find((t) => t.name === 'delete_scene')
      expect(def?.mutates).toBe('scene')
    })

    it('set_style is tagged mutates: project', () => {
      const def = ALL_TOOLS.find((t) => t.name === 'set_style')
      expect(def?.mutates).toBe('project')
    })

    it('read-only tools (inspect, inspect) are NOT tagged', () => {
      const reads = ['inspect', 'inspect', 'verify_scene', 'list_scenes']
      for (const name of reads) {
        const def = ALL_TOOLS.find((t) => t.name === name)
        if (!def) continue
        expect(def.mutates, `${name} must not be tagged mutates`).toBeUndefined()
      }
    })
  })

  describe('previewMode off (default)', () => {
    it('runs mutating tools immediately without prompting', async () => {
      const world = emptyWorld()
      const sceneId = world.scenes[0].id
      const before = world.scenes[0].duration ?? 5
      const result = await executeTool('scene_props', { op: 'duration', sceneId, duration: 12 }, world)
      expect(result.success).toBe(true)
      expect(result.permissionNeeded).toBeUndefined()
      expect(world.scenes[0].duration).not.toBe(before)
    })
  })

  describe('previewMode destructive-only', () => {
    it('intercepts mutating tool with mutation_preview permission', async () => {
      const world = emptyWorld('destructive-only')
      const sceneId = world.scenes[0].id
      const before = world.scenes[0].duration
      const result = await executeTool('scene_props', { op: 'duration', sceneId, duration: 12 }, world)
      expect(result.success).toBe(false)
      expect(result.permissionNeeded?.kind).toBe('mutation_preview')
      expect(result.permissionNeeded?.toolName).toBe('scene_props')
      expect(result.permissionNeeded?.mutationScope).toBe('scene')
      expect((result.permissionNeeded?.toolArgs as Record<string, unknown>)?.duration).toBe(12)
      // Crucially: state was NOT mutated
      expect(world.scenes[0].duration).toBe(before)
    })

    it('does NOT intercept read-only tools (e.g. inspect)', async () => {
      const world = emptyWorld('destructive-only')
      world.editorState = {
        selectedSceneId: 's1',
        selectedClipIds: [],
        currentTime: 0,
        isPlaying: false,
        totalDuration: 0,
        timelineZoom: 0,
        capturedAt: '2026-05-12T00:00:00.000Z',
      }
      const result = await executeTool('inspect', {}, world)
      expect(result.success).toBe(true)
      expect(result.permissionNeeded).toBeUndefined()
    })

    it('runs the tool when args include __previewApproved: true (resume path)', async () => {
      const world = emptyWorld('destructive-only')
      const sceneId = world.scenes[0].id
      const result = await executeTool(
        'scene_props',
        { op: 'duration', sceneId, duration: 7, __previewApproved: true },
        world,
      )
      expect(result.success).toBe(true)
      expect(result.permissionNeeded).toBeUndefined()
      expect(world.scenes[0].duration).toBe(7)
    })

    it('strips __previewApproved before dispatching so handlers do not see it', async () => {
      const world = emptyWorld('destructive-only')
      const sceneId = world.scenes[0].id
      const args = { op: 'duration', sceneId, duration: 9, __previewApproved: true }
      await executeTool('scene_props', args, world)
      // The marker should be gone from the args object after dispatch
      expect(args).not.toHaveProperty('__previewApproved')
    })
  })

  describe('previewMode always', () => {
    it('intercepts even non-mutating tools (e.g. inspect)', async () => {
      const world = emptyWorld('always')
      const result = await executeTool('inspect', { sceneId: 'nope' }, world)
      // inspect is read-only but `always` mode prompts on every tool
      expect(result.success).toBe(false)
      expect(result.permissionNeeded?.kind).toBe('mutation_preview')
    })
  })
})
