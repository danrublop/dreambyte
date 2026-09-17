/**
 * Zod schema for RunCheckpoint validation.
 *
 * Kept in a separate file from types.ts to avoid pulling Zod into client bundles.
 * Used by getRunCheckpoint() to validate checkpoint data loaded from the DB.
 */

import { z } from 'zod'

export const RunCheckpointSchema = z.object({
  runId: z.string(),
  agentType: z.string(),
  modelId: z.string(),
  scenePlan: z.any().nullable(),
  completedSceneIds: z.array(z.string()),
  remainingSceneIndexes: z.array(z.number()),
  // RunProgress shape can evolve — validate structurally but allow extra fields
  progress: z.record(z.string(), z.unknown()),
  worldSnapshot: z.object({
    scenes: z.array(z.any()),
    globalStyle: z.any(),
    sceneGraph: z.any(),
  }),
  originalMessage: z.string(),
  // Optional so pre-existing checkpoints (written before the digest landed) still
  // parse — a stricter schema here would reject them and silently rebuild.
  conversationDigest: z.string().optional(),
  partialUsage: z.any(),
  createdAt: z.string(),
  // Must list EVERY reason the runner persists, or safeParse rejects the
  // checkpoint and resume silently rebuilds from scratch + re-bills.
  // disconnect/timeout/error + the four cap/stuck reasons persistCapCheckpoint
  // emits (cost-cap, tool-call-cap, round-cap, stuck). Keep in lockstep with
  // RunCheckpoint.reason in types.ts.
  reason: z.enum(['disconnect', 'timeout', 'error', 'cost-cap', 'tool-call-cap', 'round-cap', 'stuck']),
})
