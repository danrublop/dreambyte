/**
 * Built-in tool hooks for the Dreambyte agent system.
 *
 * These hooks provide default validation and telemetry for tool execution.
 * Register them at server startup (e.g., in the agent API route).
 */

import { registerPreToolHook, registerPostToolHook } from './tool-executor'
import type { PreToolHookContext, PostToolHookContext } from './tool-executor'
import { CODE_PREVIEW_SCENE_LIMIT_LARGE } from './context-builder'

/**
 * Per-scene memo of which scenes the agent has called `read_scene_code` on
 * during the current process lifetime. This is best-effort — module-level
 * state survives across runs in the same Electron main process but is
 * cleared on app restart. We track this so the patch_layer_code guard
 * can let the agent through after it has actually read the full source.
 *
 * Keyed by `${sceneId}:${codeFieldLength}` so a regeneration that grows
 * the code past the next read invalidates the memo. Reading the same
 * version of the same scene multiple times is a no-op.
 */
const readSceneCodeMemo = new Set<string>()

function memoKey(sceneId: string, codeLength: number): string {
  return `${sceneId}:${codeLength}`
}

/** Reset the read-memo. Used by tests to start from a clean slate. */
export function __resetReadSceneCodeMemoForTesting(): void {
  readSceneCodeMemo.clear()
}

let registered = false

/**
 * Reset the registration flag so built-in hooks can be re-registered
 * after a clearToolHooks() call. Used by hook-config.ts when reloading
 * project hooks between runs.
 */
export function resetBuiltInHooksRegistration(): void {
  registered = false
}

/**
 * Register all built-in hooks. Safe to call multiple times (idempotent).
 */
export function registerBuiltInHooks(): void {
  if (registered) return
  registered = true

  // ── Pre-tool: Scene existence validation ─────────────────────────────────
  // Blocks tools that reference a sceneId that doesn't exist in the world state.
  registerPreToolHook('*', 'validate-scene-exists', (ctx: PreToolHookContext) => {
    const sceneId = ctx.args.sceneId as string | undefined
    if (!sceneId) return {}

    const exists = ctx.world.scenes.some((s) => s.id === sceneId)
    if (!exists) {
      return {
        deny: true,
        reason: `Scene "${sceneId}" does not exist. Available scenes: ${ctx.world.scenes.map((s) => `"${s.name}" (${s.id.slice(0, 8)})`).join(', ') || 'none'}`,
      }
    }
    return {}
  })

  // ── Pre-tool: Named checkpoint before destructive ops ──────────
  // The per-tool snapshot store gets an entry before EVERY tool (noise); this
  // creates the agent-VISIBLE rollback points that list_snapshots /
  // rollback_to_snapshot read — one labeled checkpoint per destructive call,
  // so "undo that delete" is one tool call away.
  // `element` is the merged overlay tool — only its delete op is destructive, so it is
  // filtered by op below rather than checkpointing every add/edit too.
  const DESTRUCTIVE_TOOLS = ['delete_scene', 'remove_layer', 'remove_track', 'clip', 'element']
  for (const toolName of DESTRUCTIVE_TOOLS) {
    registerPreToolHook(toolName, `named-checkpoint:${toolName}`, (ctx: PreToolHookContext) => {
      try {
        if (toolName === 'element' && ctx.args.op !== 'delete') return {}
        const sceneId = ctx.args.sceneId as string | undefined
        const sceneName = sceneId ? ctx.world.scenes.find((s) => s.id === sceneId)?.name : undefined
        // Marker only — executeTool promotes its per-tool pre-snapshot under
        // this label, reusing the clone it makes anyway instead of paying a
        // second full world clone here.
        ctx.world._pendingNamedCheckpointLabel = `before ${toolName}${sceneName ? `: ${sceneName}` : ''}`
      } catch {
        // Checkpoint failure must never block the tool itself.
      }
      return {}
    })
  }

  // ── Pre-tool: Duration range validation ──────────────────────────────────
  // Ensures scene durations stay within 2-60s range.
  registerPreToolHook('scene_props', 'validate-duration-range', (ctx: PreToolHookContext) => {
    if (ctx.args.op !== 'duration') return {}
    const duration = ctx.args.duration as number | undefined
    if (duration !== undefined && (duration < 2 || duration > 60)) {
      return {
        deny: true,
        reason: `Duration ${duration}s is out of range. Must be between 2 and 60 seconds.`,
      }
    }
    return {}
  })

  // ── Pre-tool: Patch-against-truncated-code guard ─────────────────────────
  //
  // Cursor reads the whole file before suggesting an edit. Our agent gets a
  // truncated preview (CODE_PREVIEW_SCENE_LIMIT_LARGE = 16K chars) of the
  // scene's primary code field in the world state summary. If the real code
  // is longer than the preview, the agent is patching code it hasn't fully
  // seen — which is exactly how `oldCode not found` errors stack up.
  //
  // This guard fires only when ALL of these are true:
  //   - tool is `patch_layer_code`
  //   - the scene's relevant code field is longer than the preview window
  //   - the agent has NOT called `read_scene_code` on this scene at this
  //     code length within the current process lifetime
  //
  // Deny with a clear next-step ("call read_scene_code first") rather than
  // letting the patch fail downstream with the existing string-match error.
  // The agent's loop reads the deny reason and self-corrects.
  registerPreToolHook('patch_layer_code', 'require-read-before-patch', (ctx: PreToolHookContext) => {
    const sceneId = ctx.args.sceneId as string | undefined
    const layerId = ctx.args.layerId as string | undefined
    if (!sceneId) return {}
    const scene = ctx.world.scenes.find((s) => s.id === sceneId)
    if (!scene) return {} // validate-scene-exists already handles this

    // Only the scene's primary code field is what the preview truncates.
    // Per-layer SVG patches read from `svgObjects[].svgContent` which is
    // shown in full (it's a layer object, not the truncated preview).
    if (layerId) {
      const svgObj = (scene.svgObjects || []).find((o) => o.id === layerId)
      if (svgObj) return {} // SVG layer patches see full content
    }

    const codeField =
      scene.sceneType === 'react'
        ? 'reactCode'
        : scene.sceneType === 'canvas2d'
          ? 'canvasCode'
          : scene.sceneType === 'lottie'
            ? 'lottieSource'
            : 'sceneCode'
    const code = ((scene as unknown as Record<string, unknown>)[codeField] as string | undefined) || ''
    if (code.length <= CODE_PREVIEW_SCENE_LIMIT_LARGE) return {} // fits in preview

    if (readSceneCodeMemo.has(memoKey(sceneId, code.length))) return {} // already read

    return {
      deny: true,
      reason:
        `Cannot patch_layer_code yet: scene "${scene.name}" has ${code.length} chars of ${codeField}, ` +
        `but your context only shows the first ${CODE_PREVIEW_SCENE_LIMIT_LARGE}. Call inspect({ kind: "code", sceneId: "${sceneId}" }) ` +
        `first to see the full source, then retry the patch with an oldCode substring you actually saw.`,
    }
  })

  // ── Pre-tool: Verification budget enforcement (Gap 5) ────────────────────
  //
  // Hard-cap on verify_scene calls when the self-correction budget is spent.
  // Without this, an agent that can't figure out how to fix a runtime error
  // will spin verify_scene → patch_layer_code → verify_scene forever until
  // the iteration wall stops it — wasting tokens and user time.
  //
  // After `verificationCyclesMax` failed verifies in a row, this hook denies
  // further verify_scene calls with a clear instruction: either accept the
  // current state or hand control back to the user. The agent's next move
  // should be a text reply summarizing what's wrong, not another tool call.
  registerPreToolHook('verify_scene', 'enforce-verification-budget', (ctx: PreToolHookContext) => {
    const used = ctx.world.verificationCyclesUsed ?? 0
    const max = ctx.world.verificationCyclesMax ?? 2
    if (used < max) return {}
    return {
      deny: true,
      reason:
        `Self-correction budget exhausted: verify_scene has failed ${used}/${max} times in a row on this run. ` +
        `Do not call verify_scene again — the same scene is unlikely to pass on another retry. ` +
        `Either finish your turn with a plain-text summary of what's wrong so the user can decide, ` +
        `or move on to a different scene. Calling verify_scene now is denied.`,
    }
  })

  // ── Post-tool: Track read_scene_code so patches against long code work ───
  registerPostToolHook('inspect', 'memo-read-scene-code', (ctx: PostToolHookContext) => {
    if (!ctx.result.success) return {}
    const sceneId = ctx.args.sceneId as string | undefined
    if (!sceneId) return {}
    const scene = ctx.world.scenes.find((s) => s.id === sceneId)
    if (!scene) return {}
    const codeField =
      scene.sceneType === 'react'
        ? 'reactCode'
        : scene.sceneType === 'canvas2d'
          ? 'canvasCode'
          : scene.sceneType === 'lottie'
            ? 'lottieSource'
            : 'sceneCode'
    const code = ((scene as unknown as Record<string, unknown>)[codeField] as string | undefined) || ''
    readSceneCodeMemo.add(memoKey(sceneId, code.length))
    return {}
  })

  // ── Post-tool: Auto runtime-verify after code writes ─────────────────────
  //
  // Cursor runs the typechecker/linter after every save. We render the scene
  // in an offscreen browser after every code write. The agent sees compile
  // errors in the SAME tool response that wrote the code, so it can self-
  // correct in the next turn without needing an explicit verify_scene call.
  //
  // We attach to the tools that actually produce new HTML on disk:
  //   - write_scene_code   (direct overwrite)
  //   - patch_layer_code   (substring replace)
  //   - add_layer          (LLM-generated layer added)
  //   - regenerate_layer   (LLM-generated layer rewritten)
  //
  // Failures are surfaced as a `warning` on the tool result — the runner
  // includes warnings in the SSE event stream so the agent sees them as
  // part of normal tool feedback. We do NOT mark the tool as failed; the
  // mutation succeeded and the action log has captured it. The agent
  // decides whether to roll back, patch, or move on.
  const codeWriteTools = ['write_scene_code', 'patch_layer_code', 'add_layer', 'regenerate_layer']
  for (const toolName of codeWriteTools) {
    registerPostToolHook(toolName, `auto-runtime-verify:${toolName}`, async (ctx: PostToolHookContext) => {
      if (!ctx.result.success) return {}
      const sceneId = ctx.result.affectedSceneId ?? (ctx.args.sceneId as string | undefined) ?? null
      if (!sceneId) return {}
      try {
        const { verifyAndStampScene } = await import('../services/scene-verifier')
        const { writeRecentRuntimeVerify, readRecentRuntimeVerify } = await import('./tool-executor')
        const outcome = await verifyAndStampScene(sceneId)
        const status: 'verified' | 'errored' | 'unknown' =
          outcome.status === 'verified' || outcome.status === 'errored' ? outcome.status : 'unknown'
        // Cache the outcome so a follow-up verify_scene call in the same
        // agent turn hits the debounce path.
        //
        // Don't downgrade: if a prior verify produced a known status
        // ('verified' or 'errored') and this run came back 'unknown' (e.g.
        // headless / CI / offscreen window unavailable), the prior known
        // state carries more information. Overwriting it with 'unknown'
        // would silently lose the previously-known crashed state and let
        // the next hook in the chain (auto-capture) trigger on a scene we
        // already knew was broken. Only overwrite known→known, or
        // unknown→anything.
        const prior = readRecentRuntimeVerify(ctx.world, sceneId)
        const isDowngradeToUnknown = status === 'unknown' && prior && prior.status !== 'unknown'
        if (!isDowngradeToUnknown) {
          writeRecentRuntimeVerify(ctx.world, sceneId, {
            status,
            error: outcome.error,
            durationMs: outcome.durationMs,
          })
        }
        if (outcome.status === 'errored' && outcome.error) {
          const loc = outcome.error.line ? ` (line ${outcome.error.line})` : ''
          return {
            warning:
              `RUNTIME ${outcome.error.kind.toUpperCase()}: ${outcome.error.message}${loc}. ` +
              `Your write succeeded but the scene failed to render in a real browser. ` +
              `Read the scene code, locate the issue, and patch it before continuing.`,
          }
        }
        // No warning on verified / unknown — keeps the result message clean
        // when things work. Unknown happens in headless/MCP contexts where
        // the offscreen window can't open; we don't punish the agent there.
      } catch {
        // Verifier infra failed to import. Don't break the tool result.
      }
      return {}
    })
  }

  // ── Post-tool: Auto capture_frame after code-writes (all providers) ─────────
  //
  // After a successful code-write the agent receives a rendered frame image
  // alongside the verify result so it can self-correct visually without an
  // explicit capture_frame call. We trigger this by setting clientAction on
  // the tool result — the runner's capture round-trip detects this flag and
  // handles the pending-capture SSE dance.
  //
  // Guard conditions:
  //   - Skip if the auto-verify hook found a runtime error (capturing a
  //     crashed scene gives the agent a blank/corrupt image with no signal).
  //   - Skip if we already captured this exact code state (sceneId+codeHash
  //     cache). Same pixels would waste a round-trip.
  const codeWriteToolsForCapture = ['write_scene_code', 'patch_layer_code', 'add_layer', 'regenerate_layer']
  for (const toolName of codeWriteToolsForCapture) {
    registerPostToolHook(toolName, `auto-capture:${toolName}`, async (ctx: PostToolHookContext) => {
      if (!ctx.result.success) return {}

      // All providers get the auto-capture. The round-trip is
      // renderer-side (capture_request SSE → posted dataUri), so the run's
      // provider is irrelevant to CAPTURING. What differs is consumption:
      // Anthropic-family models receive the frame as an image block in the
      // tool_result; other providers can't carry images in tool results, but
      // still get the vision check's TEXT warnings (_visualWarnings) — a
      // closed feedback loop via text instead of pixels. Before this, every
      // non-claude run was visually open-loop.
      const sceneId = ctx.result.affectedSceneId ?? (ctx.args.sceneId as string | undefined) ?? null
      if (!sceneId) return {}

      try {
        const { readRecentRuntimeVerify, computeCodeHash, hasCachedCapture, writeRecentCapture } =
          await import('./tool-executor')

        // Skip if runtime verify found an error — the scene is broken.
        const recentVerify = readRecentRuntimeVerify(ctx.world, sceneId)
        if (recentVerify?.status === 'errored') return {}

        // Compute a hash over the scene's code content to detect duplicate state.
        const scene = ctx.world.scenes.find((s) => s.id === sceneId)
        if (!scene) return {}
        const code = (scene as any).reactCode ?? scene.sceneCode ?? scene.canvasCode ?? scene.svgContent ?? ''
        const codeHash = computeCodeHash(code)

        // If we already captured this exact code state, skip.
        if (hasCachedCapture(ctx.world, sceneId, codeHash)) return {}

        // Record the capture intent before returning so a concurrent hook
        // invocation (parallel batch) doesn't double-fire.
        writeRecentCapture(ctx.world, sceneId, codeHash)

        // Attach clientAction so the runner's pending-captures round-trip
        // fires. We preserve all existing data fields (including any
        // _hookWarning from the auto-runtime-verify hook that ran before us).
        const existingData =
          typeof ctx.result.data === 'object' && ctx.result.data !== null
            ? (ctx.result.data as Record<string, unknown>)
            : {}
        return {
          modifiedResult: {
            ...ctx.result,
            data: {
              ...existingData,
              clientAction: 'capture_frame',
              sceneId,
              // Capture at t=1s — early enough to catch layout, late enough
              // for entrance animations to have started.
              time: 1,
            },
          },
        }
      } catch {
        // Import or hash failure — don't break the tool result.
      }
      return {}
    })
  }

  // ── Post-tool: Slow tool warning ─────────────────────────────────────────
  // Flags tools that took more than 30 seconds.
  registerPostToolHook('*', 'slow-tool-warning', (_ctx: PostToolHookContext) => {
    if (_ctx.durationMs > 30000) {
      return {
        warning: `Tool ${_ctx.toolName} took ${(_ctx.durationMs / 1000).toFixed(1)}s — consider optimizing or splitting the operation.`,
      }
    }
    return {}
  })

  // ── Post-tool: Generation cost tracking ──────────────────────────────────
  // Logs generation tool costs for analytics.
  registerPostToolHook('add_layer', 'track-generation-cost', (ctx: PostToolHookContext) => {
    if (ctx.result.success && ctx.durationMs > 0) {
      const data = ctx.result.data as Record<string, any> | undefined
      if (data?.usage) {
        // Cost data is already in the result; hook just ensures it's logged
        return {}
      }
    }
    return {}
  })
}
