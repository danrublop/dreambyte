# Architecture notes

The overview (processes, IPC, scene runtime, agent) is in the
[README](../README.md#architecture). This page covers the module rules, the dependency cycles
still left, and the plan for splitting the five largest files.

## Layering rules

- `apps/desktop/src/lib/` never imports from `apps/desktop/src/components/`, `apps/desktop/src/app/`, or `apps/desktop/src/electron/`. Code that both the agent
  and the editor need, such as pure timeline logic (`apps/desktop/src/lib/timeline/snap-engine.ts`), browser
  speech helpers (`apps/desktop/src/lib/speech-recognition.ts`), and hook-owned types, lives in `apps/desktop/src/lib/`.
- `apps/desktop/src/electron/` may import `apps/desktop/src/lib/`. `apps/desktop/src/lib/` reaches Electron-only capabilities through injected
  seams (`setGpuProbe`, `setVideoUnderstander`, `setMarlinUnderstander`, `setFrameDetector`, …)
  that `apps/desktop/src/electron/main.ts` registers at boot.
- The preload bridge types have one source: `apps/desktop/src/types/dreambyte-api.d.ts` (`DreambyteApi`) and
  `apps/desktop/src/types/electron.d.ts` (`ElectronAPI`). `apps/desktop/src/electron/preload.ts` imports them type-only and
  annotates its bridge objects, so if the bridge and the types drift apart, it fails to compile.
- Tool handlers type against `WorldStateMutable` from `apps/desktop/src/lib/agents/world-state.ts`, not from
  `tool-executor.ts`.

To check for cycles, run madge from a scratch directory so it isn't added to the project's
dependencies:

```bash
npx madge --circular --extensions ts,tsx --ts-config tsconfig.json \
  --exclude 'node_modules|\.test\.|out/|dist-electron' lib electron components app hooks types scripts
```

## Remaining cycles

madge found 60 cycles before the release clean-up and finds 12 now. Most of the ones that are left
involve runtime values, not just types:

| Cycle                                                                                      | Why it exists                                                                                                                                                                           | Fix                                                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `tool-executor` ↔ `tool-handlers/{audio,avatar,image-video,chart,layer,state-query}-tools` | These handlers call `getWorldAbortSignal`, `regenerateHTML`, `clearStaleCodeFields` or `restoreSnapshot`, usually through a dynamic `import()`.                                         | Step 1 of the `tool-executor.ts` split below moves those functions into leaf modules.       |
| `tool-executor` ↔ `tool-handlers/{capture-frame,timeline,verify}-tools`                    | These are type-only (`import type { executeTool as ExecuteTool }` and similar) because the handler factories take those functions as injected dependencies. They are erased at runtime. | They go away when the injected functions move to leaf modules.                              |
| `runner` → `director-loop` → `orchestrator` (→ `subagent-dispatch`) → `runner`             | Sub-agents re-enter `runAgent`.                                                                                                                                                         | Pass `runAgent` into the director and orchestrator as a dependency instead of importing it. |
| `store/undo-persistence` ↔ `store/undo-actions`                                            | `stripCodeFields` and `scheduleDurablePersistFromState` import each other.                                                                                                              | Move `stripCodeFields` into a leaf `apps/desktop/src/lib/store/undo-strip.ts`.                           |

## Plan for splitting the large files

These files were deliberately left whole for the first public release. Each step below is its
own PR that only moves code (no behaviour change), keeps the existing exports working through
re-exports from the original path so callers and tests don't change in the same PR, and must
pass the full test suite before the next step starts.

### `apps/desktop/src/lib/agents/tool-executor.ts` (~2,700 lines)

1. `apps/desktop/src/lib/agents/executor/world-signals.ts`: `setWorldAbortSignal`, `getWorldAbortSignal`,
   `abortResult`, `isAbortResult`. This removes most of the handler cycles.
2. `apps/desktop/src/lib/agents/executor/snapshots.ts`: `createSnapshot`, `createNamedCheckpoint`,
   `restoreSnapshot`.
3. `apps/desktop/src/lib/agents/executor/caches.ts`: the runtime-verify cache (`read/writeRecentRuntimeVerify`)
   and the auto-capture cache (`computeCodeHash`, `hasCachedCapture`, `writeRecentCapture`).
4. `apps/desktop/src/lib/agents/executor/validation-gates.ts`: `renderBlockForTool`, `verifySkippedForTool`,
   `flowBlockForTool`, `quickValidateScene`, `collectSceneCode`,
   `hasTemplateInterpInQuotedString`, plus the `MEDIA_GEN_*` sets and `toolTimeoutMs`.
5. `apps/desktop/src/lib/agents/executor/hooks.ts`: pre/post tool hook registration and the `run*ToolHooks`
   runners.
6. `apps/desktop/src/lib/agents/executor/permissions.ts`: `checkApiPermission`, `evaluateRules`,
   `enrichPermission`, `checkMediaEnabled`.
7. `apps/desktop/src/lib/agents/executor/html.ts`: `regenerateHTML`, `generateLayerContent`,
   `clearStaleCodeFields`.
8. `apps/desktop/src/lib/agents/executor/registration.ts`: `ensureAllHandlersRegistered`,
   `ensureRegistryCoverage`, `INTERNAL_ONLY_TOOL_NAMES`, `READ_ONLY_FOREIGN_SCENE_TOOLS`.

After these steps, `tool-executor.ts` keeps only `executeTool`, id-prefix expansion and
scope checks.

### `apps/desktop/src/lib/agents/tools.ts` (~3,650 lines)

Tool definitions are plain data, so this split carries the least risk. Move each
`// ── <Group> Tools ──` section into `apps/desktop/src/lib/agents/tools/<group>.ts` (scene, layer, element,
research, asset-media, ai-layer, style, planning, interaction, timeline, export, physics/3D,
skills). Each file exports its definitions and its `*_TOOLS` array. `apps/desktop/src/lib/agents/tools/index.ts`
keeps `ALL_TOOLS`, `FALLBACK_AGENT_TOOLS`, `patchToolDimensions`, `patchRoutedCraftMenu` and
`userRequestedSubAgents`, and `apps/desktop/src/lib/agents/tools.ts` becomes a re-export of that index.
`apps/desktop/src/lib/agents/__tests__/tool-consumer-registry.test.ts` confirms that no tool definition was lost.

### `apps/desktop/src/lib/agents/runner.ts` (~4,700 lines)

`runAgent` is a single ~3,400-line function with numbered phases. Take out the pure helpers
first, then the phases:

1. `apps/desktop/src/lib/agents/runner/tool-call.ts`: `withTimeout`, `withRetry`, `isRetryableError`,
   `mapToolError`, `validateToolInputAgainstSchema`, `buildToolResultContent`, `parseDataUri`,
   `summarizeToolResult`.
2. `apps/desktop/src/lib/agents/runner/routing.ts`: `shouldHandoffToOrchestrator`, `shouldFanOutToBranches`,
   `shouldDispatchToProjects`, `researchCapDecision`, `maybeInterceptInlineResearch`,
   `resolveCutReviewEngine`, `resolveMotionEngine`.
3. `apps/desktop/src/lib/agents/runner/cli-providers.ts`: phase 0, the early exit for CLI providers.
4. `apps/desktop/src/lib/agents/runner/world-setup.ts`: phases 2–4.5 (context, message history, mutable world,
   resuming a blocked tool call). This returns a `RunState` object instead of mutating locals.
5. `apps/desktop/src/lib/agents/runner/tool-loop.ts`: phase 5, the multi-turn loop, including the no-progress
   guard and reference-media intake, operating on `RunState`.
6. `apps/desktop/src/lib/agents/runner/finish.ts`: phases 6–7 (usage, cost, `done` event, stop reason).

`runAgent` then reads as setup → loop → finish. `runner.integration.test.ts` covers the whole
path and has to pass after each step.

### `apps/desktop/src/components/AgentChat.tsx` (~2,700 lines)

1. `apps/desktop/src/components/chat/hooks/useChatAttachments.ts`: `handleImageFile`, `handleAssetFile`,
   `handleReferenceMediaFile`, `handleVideoFile`, `routeAttachedFile`, and draining the
   home-composer attachments.
2. `apps/desktop/src/components/chat/hooks/useRunControls.ts`: `handlePermission`, `handleRetry`,
   `handleRateLimitRetry` (with the countdown ticker), `handleResumeCheckpoint`,
   `handleDiscardCheckpoint`, `handleAbort`.
3. `apps/desktop/src/components/chat/hooks/usePlanApproval.ts`: `handleApprovePlan`, `handleRejectPlan`, and
   answering `ask_user`.
4. `apps/desktop/src/components/chat/hooks/useMessageEditing.ts`: `handleEditMessage`, `handleRegenerate`,
   `rerunUserTurn`, `canRestoreForAssistant`, the rewind confirm, `handleResendSteer`.
5. `apps/desktop/src/components/chat/hooks/useSendMessage.ts`: `handleSend` and `runVariantsFlow`, which is the
   largest callback at ~500 lines.
6. `apps/desktop/src/components/chat/ChatHistoryModal.tsx`: the history list, including pin/archive filtering,
   search and download.

Once these are moved, `AgentChat` only wires store state to the hooks and renders.

### `apps/desktop/src/components/PreviewPlayer.tsx` (~2,500 lines)

1. `apps/desktop/src/components/preview/usePlaybackClock.ts`: the single playback tick, playback controls, seek
   helpers and frame stepping (roughly lines 680–1560 today).
2. `apps/desktop/src/components/preview/useSceneFrames.ts`: loading scenes, auto-reloading on HTML changes,
   reloading scenes an agent rewrote, and per-scene animation control through `postMessage`.
3. `apps/desktop/src/components/preview/useAudioMix.ts`: track mute and the per-category mix.
4. `apps/desktop/src/components/preview/useAgentFrameCapture.ts`: the frame capturer the agent uses for visual
   feedback, plus `shrinkToJpeg`.
5. `apps/desktop/src/components/preview/usePreviewShortcuts.ts`: keyboard shortcuts, drag-to-pan, and fitting
   the preview to the viewport.
6. `apps/desktop/src/components/preview/SceneCompositor.tsx`: the all-DOM multi-track compositing and the
   canvas.

Hooks 1 and 2 share state through refs today. They should take a small shared `PlayerRefs`
object rather than a React context, which keeps the per-frame tick free of re-renders.
