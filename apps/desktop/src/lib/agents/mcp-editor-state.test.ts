// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// T7: read_editor_state over MCP does a LIVE read of the renderer's selection /
// playhead / zoom (via the registered _editorStateReader), instead of the empty
// start-of-run snapshot. These exercise the executeMcpTool fast-path directly by
// swapping the reader — it returns before any DB/project load.
import { describe, it, expect, beforeEach } from 'vitest'
import { executeMcpTool, setEditorStateReader, type McpEditorState } from './mcp-handler'

const PID = 'proj-123'
const snap = (over?: Partial<McpEditorState>): McpEditorState => ({
  projectId: PID,
  selectedSceneId: 'scene-a',
  selectedClipIds: ['clip-1'],
  currentTime: 2.5,
  isPlaying: false,
  totalDuration: 10,
  timelineZoom: 1,
  capturedAt: '2026-06-08T00:00:00.000Z',
  ...over,
})
const data = (r: Awaited<ReturnType<typeof executeMcpTool>>) => r.data as Record<string, unknown>

describe('read_editor_state over MCP (T7)', () => {
  beforeEach(() => setEditorStateReader(null))

  it('no reader attached -> honest active:false', async () => {
    const r = await executeMcpTool({ projectId: PID, toolName: 'read_editor_state' })
    expect(r.success).toBe(true)
    expect(data(r).active).toBe(false)
    expect(r.content).toMatch(/no desktop renderer/i)
  })

  it('reader returns null (window gone / store unmounted) -> active:false', async () => {
    setEditorStateReader(async () => null)
    expect(data(await executeMcpTool({ projectId: PID, toolName: 'read_editor_state' })).active).toBe(false)
  })

  it('a thrown reader is caught -> active:false, no crash', async () => {
    setEditorStateReader(async () => {
      throw new Error('renderer gone')
    })
    expect(data(await executeMcpTool({ projectId: PID, toolName: 'read_editor_state' })).active).toBe(false)
  })

  it('live state for the SAME project -> active:true, projectMatches:true, fields surfaced', async () => {
    setEditorStateReader(async () => snap())
    const r = await executeMcpTool({ projectId: PID, toolName: 'read_editor_state' })
    expect(data(r).active).toBe(true)
    expect(data(r).projectMatches).toBe(true)
    expect(data(r).selectedSceneId).toBe('scene-a')
    expect(data(r).currentTime).toBe(2.5)
    expect(r.content).not.toMatch(/DIFFERENT project/)
  })

  it('editor showing a DIFFERENT project -> projectMatches:false, foreign state REDACTED', async () => {
    setEditorStateReader(async () =>
      snap({ projectId: 'other-proj', selectedSceneId: 'secret-scene', selectedClipIds: ['secret-clip'] }),
    )
    const r = await executeMcpTool({ projectId: PID, toolName: 'read_editor_state' })
    expect(data(r).active).toBe(true)
    expect(data(r).projectMatches).toBe(false)
    expect(r.content).toMatch(/DIFFERENT project/)
    // Cross-project guard: the other project's selection/scene/clips/playhead must NOT leak.
    expect(data(r).selectedSceneId).toBeUndefined()
    expect(data(r).selectedClipIds).toBeUndefined()
    expect(data(r).currentTime).toBeUndefined()
    expect(r.content).not.toMatch(/secret-scene/)
    expect(r.content).not.toMatch(/secret-clip/)
  })
})
