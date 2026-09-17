import type { IpcMain } from 'electron'
import {
  getProjectConversations,
  createConversation,
  updateConversation,
  deleteConversation,
  getConversationMessages,
  addMessage,
  updateMessage,
  updateMessageRating,
  upsertMessage,
  clearConversationMessages,
  deleteMessagesAfter,
  searchConversations,
} from '@/lib/db/queries/conversations'
import { promoteDraftToReady } from '@/lib/db/queries/projects'
import { assertValidUuid, loadConversationOrThrow, loadProjectOrThrow, IpcValidationError } from './_helpers'

/**
 * Category: conversations
 *
 * Conversation + message CRUD and search. Business logic lives in
 * `src/lib/db/queries/conversations.ts`.
 */

const MAX_TITLE_LENGTH = 500
const MAX_CONTENT_LENGTH = 500_000

async function list(projectId: string) {
  await loadProjectOrThrow(projectId)
  return { conversations: await getProjectConversations(projectId) }
}

async function create(args: { projectId: string; title?: string }) {
  await loadProjectOrThrow(args.projectId)
  if (args.title !== undefined) {
    if (typeof args.title !== 'string' || args.title.length > MAX_TITLE_LENGTH) {
      throw new IpcValidationError(`title must be a string under ${MAX_TITLE_LENGTH} chars`)
    }
  }
  return { conversation: await createConversation({ projectId: args.projectId, title: args.title }) }
}

async function get(id: string) {
  const conv = await loadConversationOrThrow(id)
  const messages = await getConversationMessages(id)
  return { conversation: conv, messages }
}

async function update(id: string, updates: { title?: string; isPinned?: boolean; isArchived?: boolean }) {
  await loadConversationOrThrow(id)
  const patch: { title?: string; isPinned?: boolean; isArchived?: boolean } = {}

  if (updates.title !== undefined) {
    if (typeof updates.title !== 'string' || updates.title.length > MAX_TITLE_LENGTH) {
      throw new IpcValidationError(`title must be a string under ${MAX_TITLE_LENGTH} chars`)
    }
    patch.title = updates.title
  }
  if (updates.isPinned !== undefined) {
    if (typeof updates.isPinned !== 'boolean') {
      throw new IpcValidationError('isPinned must be a boolean')
    }
    patch.isPinned = updates.isPinned
  }
  if (updates.isArchived !== undefined) {
    if (typeof updates.isArchived !== 'boolean') {
      throw new IpcValidationError('isArchived must be a boolean')
    }
    patch.isArchived = updates.isArchived
  }
  if (Object.keys(patch).length === 0) {
    throw new IpcValidationError('No valid fields to update')
  }

  const conversation = await updateConversation(id, patch)
  return { conversation }
}

async function remove(id: string) {
  await loadConversationOrThrow(id)
  await deleteConversation(id)
  return { success: true as const }
}

async function listMessages(id: string) {
  await loadConversationOrThrow(id)
  return { messages: await getConversationMessages(id) }
}

type AddMessageArgs = {
  id?: string
  messageId?: string
  conversationId: string
  projectId: string
  role: 'user' | 'assistant'
  content: string
  status?: string
  agentType?: string
  modelUsed?: string
  thinkingContent?: string
  toolCalls?: unknown
  contentSegments?: unknown
  pendingPermissions?: unknown
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
  apiCalls?: number
  userRating?: number | null
  generationLogId?: string
  /** Monotonic sequence for the streaming incremental persist. */
  seq?: number | null
  /** The IPC runId that produced this row (S6 — precise orphan detection). */
  runId?: string | null
  /** sendBeacon-compatible upsert path. Beacons can only POST, so the web
   *  fallback threaded `_method: 'PUT'` through. Kept for parity. */
  _method?: 'PUT'
}

async function addMessageIpc(args: AddMessageArgs) {
  const conv = await loadConversationOrThrow(args.conversationId)
  assertValidUuid(args.projectId, 'projectId')
  if (args.projectId !== conv.projectId) {
    throw new IpcValidationError('projectId does not match conversation')
  }
  if (args.role !== 'user' && args.role !== 'assistant') {
    throw new IpcValidationError('role must be "user" or "assistant"')
  }
  if (typeof args.content !== 'string') {
    throw new IpcValidationError('content must be a string')
  }
  if (args.content.length > MAX_CONTENT_LENGTH) {
    throw new IpcValidationError(`content exceeds ${MAX_CONTENT_LENGTH} character limit`)
  }
  if (args.userRating !== undefined && args.userRating !== null) {
    const r = Number(args.userRating)
    if (!Number.isInteger(r) || r < -1 || r > 1) {
      throw new IpcValidationError('userRating must be -1, 0, or 1')
    }
  }

  if (args._method === 'PUT' && args.messageId) {
    await upsertMessage({
      id: args.messageId,
      conversationId: args.conversationId,
      projectId: args.projectId,
      role: args.role ?? 'assistant',
      content: args.content ?? '',
      status: (args.status ?? 'aborted') as 'aborted' | 'streaming' | 'complete',
      agentType: args.agentType as never,
      modelUsed: args.modelUsed,
      thinkingContent: args.thinkingContent,
      toolCalls: args.toolCalls as never,
      contentSegments: args.contentSegments as never,
      pendingPermissions: args.pendingPermissions as never,
      seq: args.seq ?? null,
    })
    return { success: true as const }
  }

  const message = await addMessage({
    id: args.id,
    conversationId: args.conversationId,
    projectId: args.projectId,
    role: args.role,
    content: args.content,
    status: args.status as never,
    seq: args.seq ?? null,
    runId: args.runId ?? null,
    agentType: args.agentType as never,
    modelUsed: args.modelUsed,
    thinkingContent: args.thinkingContent,
    toolCalls: args.toolCalls as never,
    contentSegments: args.contentSegments as never,
    pendingPermissions: args.pendingPermissions as never,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd: args.costUsd,
    durationMs: args.durationMs,
    apiCalls: args.apiCalls,
    userRating: args.userRating ?? undefined,
    generationLogId: args.generationLogId,
  })
  // First real activity promotes a draft to a 'ready' project.
  // A 'streaming' placeholder is NOT activity on its own — it's the start of a
  // run that may be aborted before any content lands — so skip those; the
  // user's message (and the final non-streaming assistant reply) drive promotion.
  if (args.status !== 'streaming') {
    await promoteDraftToReady(conv.projectId).catch(() => {})
  }
  return { message }
}

type UpdateMessageArgs = {
  conversationId: string
  messageId: string
  userRating?: number | null
  content?: string
  status?: string
  /** Monotonic sequence for the streaming incremental persist. */
  seq?: number | null
  /** The IPC runId that produced this row (S6 — precise orphan detection). */
  runId?: string | null
  agentType?: string
  modelUsed?: string
  thinkingContent?: string
  toolCalls?: unknown
  contentSegments?: unknown
  pendingPermissions?: unknown
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
  apiCalls?: number
  generationLogId?: string
}

async function updateMessageIpc(args: UpdateMessageArgs) {
  await loadConversationOrThrow(args.conversationId)
  assertValidUuid(args.messageId, 'messageId')

  const ratingOnly =
    'userRating' in args &&
    Object.keys(args).filter((k) => k !== 'conversationId' && k !== 'messageId' && k !== 'userRating').length === 0

  if (ratingOnly) {
    if (args.userRating !== undefined && args.userRating !== null) {
      const r = Number(args.userRating)
      if (!Number.isInteger(r) || r < -1 || r > 1) {
        throw new IpcValidationError('userRating must be -1, 0, or 1')
      }
    }
    await updateMessageRating(args.conversationId, args.messageId, args.userRating ?? null)
    return { success: true as const, applied: true }
  }

  // Thread the seq-gate verdict through to the renderer: `applied:false` means
  // the stale-seq guard rejected this write (queries/conversations.ts), which
  // the streaming persister needs to distinguish from a successful update.
  const { applied } = await updateMessage(args.messageId, {
    // Conversation-scope the WHERE — args.conversationId is already
    // validated above; passing it prevents a cross-conversation message update.
    conversationId: args.conversationId,
    content: args.content,
    status: args.status as never,
    seq: args.seq,
    runId: args.runId,
    agentType: args.agentType as never,
    modelUsed: args.modelUsed,
    thinkingContent: args.thinkingContent,
    toolCalls: args.toolCalls as never,
    contentSegments: args.contentSegments as never,
    pendingPermissions: args.pendingPermissions as never,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd: args.costUsd,
    durationMs: args.durationMs,
    apiCalls: args.apiCalls,
    generationLogId: args.generationLogId,
  })
  return { success: true as const, applied }
}

async function clearMessages(id: string) {
  await loadConversationOrThrow(id)
  await clearConversationMessages(id)
  return { success: true as const }
}

type DeleteAfterArgs = {
  conversationId: string
  messageId: string
  newContent?: string
}

/**
 * Tail-delete the conversation after a message (rewind primitive).
 * Unknown messageId ⇒ `{ found: false }` with ZERO mutation so the renderer
 * surfaces an error and never splices its store out of sync with the DB.
 */
type SearchArgs = { query: string; includeArchived?: boolean; limit?: number }

/** Global conversation search for the command palette. */
async function search(args: SearchArgs) {
  if (typeof args.query !== 'string') {
    throw new IpcValidationError('query must be a string')
  }
  return { results: await searchConversations(args.query, args) }
}

async function deleteAfter(args: DeleteAfterArgs) {
  await loadConversationOrThrow(args.conversationId)
  assertValidUuid(args.messageId, 'messageId')
  if (args.newContent !== undefined) {
    if (typeof args.newContent !== 'string' || args.newContent.length > MAX_CONTENT_LENGTH) {
      throw new IpcValidationError(`newContent must be a string under ${MAX_CONTENT_LENGTH} chars`)
    }
  }
  return deleteMessagesAfter(args)
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:conversations.list', (_e, projectId: string) => list(projectId))
  ipcMain.handle('dreambyte:conversations.create', (_e, args: { projectId: string; title?: string }) => create(args))
  ipcMain.handle('dreambyte:conversations.get', (_e, id: string) => get(id))
  ipcMain.handle('dreambyte:conversations.update', (_e, args: { id: string; updates: Parameters<typeof update>[1] }) =>
    update(args.id, args.updates),
  )
  ipcMain.handle('dreambyte:conversations.delete', (_e, id: string) => remove(id))
  ipcMain.handle('dreambyte:conversations.listMessages', (_e, id: string) => listMessages(id))
  ipcMain.handle('dreambyte:conversations.addMessage', (_e, args: AddMessageArgs) => addMessageIpc(args))
  ipcMain.handle('dreambyte:conversations.updateMessage', (_e, args: UpdateMessageArgs) => updateMessageIpc(args))
  ipcMain.handle('dreambyte:conversations.clearMessages', (_e, id: string) => clearMessages(id))
  ipcMain.handle('dreambyte:conversations.deleteMessagesAfter', (_e, args: DeleteAfterArgs) => deleteAfter(args))
  ipcMain.handle('dreambyte:conversations.search', (_e, args: SearchArgs) => search(args))
}
