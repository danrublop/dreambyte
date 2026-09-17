import { db } from '../index'
import { generationLogs } from '../schema'
import { eq, desc, sql, isNotNull, and } from 'drizzle-orm'

/** Truncate text to a max byte size to prevent DB bloat from unbounded text columns */
function truncateForDB(text: string | undefined, maxBytes: number): string | undefined {
  if (!text || text.length <= maxBytes) return text
  return text.slice(0, maxBytes)
}

const MAX_THINKING_CONTENT = 500 * 1024 // 500KB
const MAX_USER_PROMPT = 100 * 1024 // 100KB
const MAX_ANALYSIS_NOTES = 100 * 1024 // 100KB

export interface CreateGenerationLogInput {
  projectId?: string
  sceneId?: string
  layerId?: string
  userPrompt: string
  systemPromptHash?: string
  systemPromptSnapshot?: string
  injectedRules?: string[]
  stylePresetId?: string
  agentType?: string
  modelUsed?: string
  thinkingMode?: string
}

export interface UpdateGenerationLogInput {
  agentType?: string
  modelUsed?: string
  sceneId?: string
  layerId?: string
  sceneType?: string
  generatedCodeLength?: number
  thinkingContent?: string
  generationTimeMs?: number
  inputTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  costUsd?: number
  userAction?: string
  timeToActionMs?: number
  editDistance?: number
  userRating?: number
  exportSucceeded?: boolean
  exportErrorMessage?: string
  qualityScore?: number
  analysisNotes?: string
  runId?: string
  runTrace?: unknown
}

export async function createGenerationLog(input: CreateGenerationLogInput): Promise<string> {
  const [row] = await db
    .insert(generationLogs)
    .values({
      projectId: input.projectId,
      sceneId: input.sceneId,
      layerId: input.layerId,
      userPrompt: truncateForDB(input.userPrompt, MAX_USER_PROMPT) ?? '',
      systemPromptHash: input.systemPromptHash,
      systemPromptSnapshot: input.systemPromptSnapshot,
      injectedRules: input.injectedRules,
      stylePresetId: input.stylePresetId,
      agentType: input.agentType,
      modelUsed: input.modelUsed,
      thinkingMode: input.thinkingMode,
    })
    .returning({ id: generationLogs.id })
  return row.id
}

export async function updateGenerationLog(id: string, updates: UpdateGenerationLogInput): Promise<void> {
  const truncated = {
    ...updates,
    thinkingContent: truncateForDB(updates.thinkingContent, MAX_THINKING_CONTENT),
    analysisNotes: truncateForDB(updates.analysisNotes, MAX_ANALYSIS_NOTES),
    updatedAt: new Date(),
  }
  await db.update(generationLogs).set(truncated).where(eq(generationLogs.id, id))
}

export async function getGenerationLogs(
  opts: {
    projectId?: string
    sceneId?: string
    limit?: number
    offset?: number
    hasQualityScore?: boolean
  } = {},
) {
  const conditions = []
  if (opts.projectId) conditions.push(eq(generationLogs.projectId, opts.projectId))
  if (opts.sceneId) conditions.push(eq(generationLogs.sceneId, opts.sceneId))
  if (opts.hasQualityScore) conditions.push(isNotNull(generationLogs.qualityScore))

  return db
    .select()
    .from(generationLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(generationLogs.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
}
