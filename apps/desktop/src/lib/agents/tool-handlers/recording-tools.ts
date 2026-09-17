import type { AgentLogger } from '../logger'
import { ok, okGlobal, err, type ToolResult } from './_shared'

export const RECORDING_TOOL_NAMES = ['start_recording'] as const

/**
 * Recording tools — only `start_recording` is real.
 *
 * The recording lifecycle is one-way: `start_recording` sets a
 * recordingCommand on the world that the renderer consumes (use-agent-run.ts
 * applies it from the FINAL state_change — i.e. AFTER the run ends), but
 * recording state NEVER flows back into the agent world. The stop / pause /
 * resume / cancel / status / list-sources stubs that used to ride this handler
 * could only ever report on a recording the agent could not see, so they were
 * removed rather than advertised as tools that refuse.
 *
 * `start_recording` stays functional but its success message tells the truth:
 * the recording begins when the run completes and only the user can stop it.
 */
export function createRecordingToolHandler() {
  return async function handleRecordingTools(
    toolName: string,
    args: Record<string, unknown>,
    world: any,
    _logger?: AgentLogger,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'start_recording': {
        // `recordingCommand` has exactly ONE consumer — use-agent-run.ts,
        // a RENDERER hook that reads the in-app run's final state_change. The
        // MCP path (Claude Code / Cursor) builds its own world, never emits a
        // state_change, and drops the mutation on return — so this tool was a
        // guaranteed false success there, and MCP is the reason it's offered
        // at all (MCP_TOOLS adds it explicitly). Sub-agent events are dropped
        // by the same consumer. `orchestratorAvailable` is set only by the
        // top-level in-app runner (= !isSubAgent), which is exactly the one
        // path where the command is picked up — reuse it rather than adding a
        // second flag.
        if (!(world as { orchestratorAvailable?: boolean }).orchestratorAvailable) {
          return err(
            'start_recording only works from the in-app agent — this path has no recorder to receive the command, ' +
              'so nothing would be recorded. Ask the user to press Record in the Dreambyte editor, then continue ' +
              'once the clip lands in the project.',
          )
        }
        const { sourceId, sceneId, micEnabled, systemAudioEnabled, webcamEnabled, fps, resolution } = args as {
          sourceId?: string
          sceneId?: string
          micEnabled?: boolean
          systemAudioEnabled?: boolean
          webcamEnabled?: boolean
          fps?: number
          resolution?: string
        }
        void sourceId // ignored — source selection uses native OS picker via getDisplayMedia()

        // Set config on world state — the renderer picks this up from the FINAL
        // state_change payload (use-agent-run.ts), i.e. after this run completes.
        world.recordingConfig = {
          micEnabled: micEnabled ?? true,
          micDeviceId: null,
          systemAudioEnabled: systemAudioEnabled ?? true,
          webcamEnabled: webcamEnabled ?? false,
          webcamDeviceId: null,
          fps: fps ?? 30,
          resolution: resolution ?? '1080p',
        }
        world.recordingCommand = 'start'
        world.recordingCommandNonce = (world.recordingCommandNonce ?? 0) + 1
        world.recordingAttachSceneId = sceneId ?? null
        world.recordingError = null
        world.recordingResult = null

        // Truthful message: the command only dispatches on the FINAL
        // state_change — after this run ends — and no recording state ever flows
        // back to the agent, so it must not promise to stop or monitor anything.
        const desc =
          "Recording will begin when this run completes; stop it from the editor's record control — the agent cannot stop or monitor it." +
          (sceneId ? ` The captured video will attach to scene ${sceneId} when the user stops the recording.` : '')
        return sceneId ? ok(sceneId, desc) : okGlobal(desc)
      }

      default:
        return err(`Unknown recording tool: ${toolName}`)
    }
  }
}
