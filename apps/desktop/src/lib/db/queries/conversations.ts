import { db } from '../index'
import { conversations, messages } from '../schema'
import { eq, desc, asc, sql, inArray, and, or, isNull, lte, gt } from 'drizzle-orm'

// ── Conversations ────────────────────────────────────────────────────────────

export async function getProjectConversations(projectId: string) {
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.lastMessageAt))

  if (convs.length === 0) return []

  // Latest message per conversation. Two earlier approaches failed:
  //   - Correlated subquery with bare `messages.position` inside — the name
  //     `messages` resolved to the outer table, so MAX became a constant.
  //   - Drizzle `alias(messages, 'm2')` + `FROM ${m2}` — `${m2}` in a raw
  //     `sql` template interpolates just the alias identifier `"m2"`, not
  //     `"messages" AS "m2"`, so SQLite saw `FROM "m2"` and threw 'no such
  //     table'.
  // Instead: group-by subquery to find each conversation's max position,
  // then inner-join the messages table to fetch the actual latest rows.
  // Pure Drizzle builder, no template-string subtleties.
  const convIds = convs.map((c) => c.id)
  const latestPositions = db
    .select({
      conversationId: messages.conversationId,
      maxPosition: sql<number>`MAX(${messages.position})`.as('max_position'),
    })
    .from(messages)
    .where(inArray(messages.conversationId, convIds))
    .groupBy(messages.conversationId)
    .as('latest_positions')

  const latestByConv = await db
    .select({
      conversation_id: messages.conversationId,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(
      latestPositions,
      and(
        eq(messages.conversationId, latestPositions.conversationId),
        eq(messages.position, latestPositions.maxPosition),
      ),
    )

  const msgMap = new Map<string, { role: string; content: string }>()
  for (const row of latestByConv) {
    msgMap.set(row.conversation_id, { role: row.role, content: row.content })
  }

  return convs.map((conv) => {
    const lastMsg = msgMap.get(conv.id)
    return { ...conv, messages: lastMsg ? [lastMsg] : [] }
  })
}

export async function createConversation(data: { projectId: string; title?: string }) {
  const [conv] = await db
    .insert(conversations)
    .values({
      projectId: data.projectId,
      title: data.title ?? 'New chat',
    })
    .returning()
  return conv
}

export async function updateConversation(
  id: string,
  updates: { title?: string; isPinned?: boolean; isArchived?: boolean },
) {
  const [conv] = await db
    .update(conversations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning()
  return conv
}

export async function deleteConversation(id: string) {
  await db.delete(conversations).where(eq(conversations.id, id))
}

// ── Messages ─────────────────────────────────────────────────────────────────

export async function getConversationMessages(conversationId: string, limit = 200) {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: asc(messages.position),
    limit,
  })
}

/** Atomic next-position selector. Used inside a transaction so the read+write
 *  pair can't race with another insert against the same conversation. */
async function nextPosition(
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  conversationId: string,
): Promise<number> {
  const rows = await tx
    .select({ max: sql<number>`coalesce(max(${messages.position}), -1) + 1` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
  return Number(rows[0]?.max ?? 0)
}

export async function addMessage(data: {
  /** Optional client-generated UUID — if omitted, Drizzle's $defaultFn supplies one. */
  id?: string
  conversationId: string
  projectId: string
  role: string
  content: string
  status?: string
  /** Monotonic sequence for the streaming incremental persist. */
  seq?: number | null
  /** The IPC runId that produced this row (precise orphan detection). */
  runId?: string | null
  agentType?: 'router' | 'director' | 'scene-maker' | 'editor' | 'dop' | 'planner' | null
  modelUsed?: string | null
  thinkingContent?: string | null
  toolCalls?: unknown[]
  contentSegments?: unknown[]
  pendingPermissions?: unknown[]
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  durationMs?: number | null
  apiCalls?: number | null
  userRating?: number | null
  generationLogId?: string | null
}) {
  const status = data.status ?? 'complete'
  return db.transaction(async (tx) => {
    const position = await nextPosition(tx, data.conversationId)
    const [row] = await tx
      .insert(messages)
      .values({
        ...(data.id ? { id: data.id } : {}),
        conversationId: data.conversationId,
        projectId: data.projectId,
        role: data.role,
        content: data.content,
        status,
        seq: data.seq ?? null,
        runId: data.runId ?? null,
        agentType: data.agentType ?? null,
        modelUsed: data.modelUsed ?? null,
        thinkingContent: data.thinkingContent ?? null,
        toolCalls: data.toolCalls ?? [],
        contentSegments: data.contentSegments ?? null,
        pendingPermissions: data.pendingPermissions ?? null,
        inputTokens: data.inputTokens ?? null,
        outputTokens: data.outputTokens ?? null,
        costUsd: data.costUsd ?? null,
        durationMs: data.durationMs ?? null,
        apiCalls: data.apiCalls ?? null,
        userRating: data.userRating ?? null,
        generationLogId: data.generationLogId ?? null,
        position,
      })
      .returning()

    // Only update conversation stats for non-placeholder messages
    if (status !== 'streaming') {
      await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
          totalCostUsd: sql`${conversations.totalCostUsd} + ${data.costUsd ?? 0}`,
          totalInputTokens: sql`${conversations.totalInputTokens} + ${data.inputTokens ?? 0}`,
          totalOutputTokens: sql`${conversations.totalOutputTokens} + ${data.outputTokens ?? 0}`,
        })
        .where(eq(conversations.id, data.conversationId))
    } else {
      await tx
        .update(conversations)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(conversations.id, data.conversationId))
    }

    return row
  })
}

/** Update an existing message in-place. Only updates fields that are explicitly passed.
 *
 *  Stale-seq guard: when `updates.seq` is provided, the UPDATE is
 *  gated on `seq IS NULL OR seq <= :newSeq` so an out-of-order incremental
 *  persist (an older debounced write that lands after a newer one) can never
 *  overwrite newer streamed content. The final persist omits `seq` and so
 *  always wins, superseding any partials. Returns `{ applied }` so the caller
 *  (renderer persister) can tell whether the write took effect. */
export async function updateMessage(
  messageId: string,
  updates: {
    /**
     * Scope the update to a conversation (COMMIT 4). ANDed into the WHERE so a
     * messageId from one conversation can never be updated under another — a
     * cross-conversation write would corrupt the wrong thread. Optional for
     * back-compat; the IPC caller always supplies it (it already validates it).
     */
    conversationId?: string
    content?: string
    status?: string
    seq?: number | null
    /** The IPC runId that produced this row (precise orphan detection). */
    runId?: string | null
    agentType?: 'router' | 'director' | 'scene-maker' | 'editor' | 'dop' | 'planner' | null
    modelUsed?: string | null
    thinkingContent?: string | null
    toolCalls?: unknown[]
    contentSegments?: unknown[]
    pendingPermissions?: unknown[]
    inputTokens?: number | null
    outputTokens?: number | null
    costUsd?: number | null
    durationMs?: number | null
    apiCalls?: number | null
    generationLogId?: string | null
  },
): Promise<{ applied: boolean }> {
  // Build the partial update from explicitly-passed fields. Drizzle handles
  // JSON serialization for `toolCalls` / `contentSegments` /
  // `pendingPermissions` automatically.
  const patch: Record<string, unknown> = {}
  if (updates.content !== undefined) patch.content = updates.content
  if (updates.seq !== undefined && updates.seq !== null) patch.seq = updates.seq
  if (updates.runId !== undefined) patch.runId = updates.runId
  if (updates.status !== undefined) patch.status = updates.status
  if (updates.agentType !== undefined) patch.agentType = updates.agentType
  if (updates.modelUsed !== undefined) patch.modelUsed = updates.modelUsed
  if (updates.thinkingContent !== undefined) patch.thinkingContent = updates.thinkingContent
  if (updates.toolCalls !== undefined) patch.toolCalls = updates.toolCalls
  if (updates.contentSegments !== undefined) patch.contentSegments = updates.contentSegments
  if (updates.pendingPermissions !== undefined) patch.pendingPermissions = updates.pendingPermissions
  if (updates.inputTokens !== undefined) patch.inputTokens = updates.inputTokens
  if (updates.outputTokens !== undefined) patch.outputTokens = updates.outputTokens
  if (updates.costUsd !== undefined) patch.costUsd = updates.costUsd
  if (updates.durationMs !== undefined) patch.durationMs = updates.durationMs
  if (updates.apiCalls !== undefined) patch.apiCalls = updates.apiCalls
  if (updates.generationLogId !== undefined) patch.generationLogId = updates.generationLogId

  if (Object.keys(patch).length === 0) return { applied: false }

  // Conversation scope (COMMIT 4): AND the conversationId into both WHERE
  // variants when supplied, so a messageId is only ever updated within its own
  // conversation.
  const convScope =
    updates.conversationId !== undefined ? eq(messages.conversationId, updates.conversationId) : undefined

  // Stale-seq guard: only gate when the caller supplied a seq. SQLite has no
  // NULLS-comparison sugar, so `seq IS NULL OR seq <= :new` keeps legacy rows
  // (seq NULL) writable while rejecting an older partial after a newer one.
  const where =
    updates.seq !== undefined && updates.seq !== null
      ? and(eq(messages.id, messageId), convScope, or(isNull(messages.seq), lte(messages.seq, updates.seq)))
      : and(eq(messages.id, messageId), convScope)

  return db.transaction(async (tx) => {
    const updated = await tx.update(messages).set(patch).where(where).returning({ id: messages.id })
    const applied = updated.length > 0
    if (!applied) return { applied: false }

    // When completing a message, update conversation cost/token stats
    if (updates.status === 'complete' && (updates.costUsd || updates.inputTokens || updates.outputTokens)) {
      const [row] = await tx
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      const convId = row?.conversationId
      if (convId) {
        await tx
          .update(conversations)
          .set({
            updatedAt: new Date(),
            totalCostUsd: sql`${conversations.totalCostUsd} + ${updates.costUsd ?? 0}`,
            totalInputTokens: sql`${conversations.totalInputTokens} + ${updates.inputTokens ?? 0}`,
            totalOutputTokens: sql`${conversations.totalOutputTokens} + ${updates.outputTokens ?? 0}`,
          })
          .where(eq(conversations.id, convId))
      }
    }
    return { applied: true }
  })
}

/** Upsert a message — INSERT if not exists, UPDATE only if still streaming.
 *  Used by the sendBeacon path that fires on tab close to flush a streaming
 *  agent reply that never reached `status='complete'`. */
export async function upsertMessage(data: {
  id: string
  conversationId: string
  projectId: string
  role: string
  content: string
  status?: string
  agentType?: 'router' | 'director' | 'scene-maker' | 'editor' | 'dop' | 'planner' | null
  modelUsed?: string | null
  thinkingContent?: string | null
  toolCalls?: unknown[]
  contentSegments?: unknown[]
  pendingPermissions?: unknown[]
  /** Monotonic sequence for the streaming incremental persist. */
  seq?: number | null
}) {
  const status = data.status ?? 'aborted'
  return db.transaction(async (tx) => {
    const position = await nextPosition(tx, data.conversationId)
    await tx
      .insert(messages)
      .values({
        id: data.id,
        conversationId: data.conversationId,
        projectId: data.projectId,
        role: data.role,
        content: data.content,
        status,
        agentType: data.agentType ?? null,
        modelUsed: data.modelUsed ?? null,
        thinkingContent: data.thinkingContent ?? null,
        toolCalls: data.toolCalls ?? [],
        contentSegments: data.contentSegments ?? null,
        pendingPermissions: data.pendingPermissions ?? null,
        seq: data.seq ?? null,
        position,
      })
      // The `status = 'streaming'` ON CONFLICT predicate suppresses overwrites of
      // already-finalized messages, so a late beacon can't clobber a
      // successfully-completed message.
      //
      // Stale-seq guard: when a seq is supplied, also require the
      // incoming seq to be >= the stored one so an out-of-order streamed
      // partial can't overwrite newer content. The final persist (no seq) keeps
      // only the streaming gate and supersedes partials.
      .onConflictDoUpdate({
        target: messages.id,
        set: {
          content: data.content,
          status,
          toolCalls: data.toolCalls ?? [],
          contentSegments: data.contentSegments ?? null,
          pendingPermissions: data.pendingPermissions ?? null,
          thinkingContent: data.thinkingContent ?? null,
          agentType: data.agentType ?? null,
          modelUsed: data.modelUsed ?? null,
          ...(data.seq !== undefined && data.seq !== null ? { seq: data.seq } : {}),
        },
        setWhere:
          data.seq !== undefined && data.seq !== null
            ? and(eq(messages.status, 'streaming'), or(isNull(messages.seq), lte(messages.seq, data.seq)))
            : eq(messages.status, 'streaming'),
      })
  })
}

export async function updateMessageRating(conversationId: string, messageId: string, userRating: number | null) {
  await db
    .update(messages)
    .set({ userRating })
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
}

export async function clearConversationMessages(conversationId: string) {
  await db.delete(messages).where(eq(messages.conversationId, conversationId))
  await db
    .update(conversations)
    .set({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId))
}

export interface ConversationSearchResult {
  conversationId: string
  projectId: string
  title: string
  /** Where the match landed — drives the result subtitle. */
  matchedOn: 'title' | 'message'
  /** A short content snippet when the match was in a message body. */
  snippet?: string
}

/**
 * Global conversation search for the command palette. Matches the
 * query against conversation titles AND message content (case-insensitive LIKE),
 * LIMIT 50. Archived conversations are EXCLUDED by default — pass
 * `includeArchived` to fold them back in (the "Archived" toggle).
 *
 * SQLite `LIKE` is case-insensitive for ASCII by default; we lower-case both
 * sides anyway so the contract is explicit. Title matches rank above
 * message-only matches, then by recency.
 */
export async function searchConversations(
  query: string,
  opts?: { includeArchived?: boolean; limit?: number },
): Promise<ConversationSearchResult[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const limit = opts?.limit ?? 50
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`

  const archivedFilter = opts?.includeArchived
    ? undefined
    : or(isNull(conversations.isArchived), eq(conversations.isArchived, false))

  // Title matches.
  const titleRows = await db
    .select({
      conversationId: conversations.id,
      projectId: conversations.projectId,
      title: conversations.title,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(
      and(sql`lower(${conversations.title}) LIKE ${like} ESCAPE '\\'`, ...(archivedFilter ? [archivedFilter] : [])),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit)

  const titleHits = new Set(titleRows.map((r) => r.conversationId))
  const results: ConversationSearchResult[] = titleRows.map((r) => ({
    conversationId: r.conversationId,
    projectId: r.projectId,
    title: r.title,
    matchedOn: 'title' as const,
  }))

  if (results.length >= limit) return results.slice(0, limit)

  // Message-content matches — join back to the (non-archived) conversation.
  const msgRows = await db
    .select({
      conversationId: messages.conversationId,
      projectId: conversations.projectId,
      title: conversations.title,
      content: messages.content,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(sql`lower(${messages.content}) LIKE ${like} ESCAPE '\\'`, ...(archivedFilter ? [archivedFilter] : [])))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit * 4)

  const seen = new Set(titleHits)
  for (const row of msgRows) {
    if (results.length >= limit) break
    if (seen.has(row.conversationId)) continue
    seen.add(row.conversationId)
    const text = row.content ?? ''
    const idx = text.toLowerCase().indexOf(q)
    const start = Math.max(0, idx - 30)
    const snippet =
      (start > 0 ? '…' : '') + text.slice(start, start + 90).trim() + (text.length > start + 90 ? '…' : '')
    results.push({
      conversationId: row.conversationId,
      projectId: row.projectId,
      title: row.title,
      matchedOn: 'message',
      snippet,
    })
  }

  return results.slice(0, limit)
}

/**
 * Tail-delete the conversation after a given message (rewind primitive).
 *
 * Deletes every message in the conversation whose `position` is greater than
 * `messageId`'s position; when `newContent` is supplied, swaps that message's
 * own content in the same transaction (the edit case). Atomic: an unknown
 * `messageId` (no anchor row) mutates NOTHING and returns `{ found: false }`
 * so the caller can refuse the rewind without divergence.
 *
 * Returns the surviving messages (ascending) so the renderer can splice its
 * in-memory list to exactly match the DB — store + DB stay in lockstep.
 */
export async function deleteMessagesAfter(args: {
  conversationId: string
  messageId: string
  newContent?: string
}): Promise<{ found: boolean; remaining: (typeof messages.$inferSelect)[] }> {
  return db.transaction(async (tx) => {
    const [anchor] = await tx
      .select({ position: messages.position })
      .from(messages)
      .where(and(eq(messages.id, args.messageId), eq(messages.conversationId, args.conversationId)))
      .limit(1)

    if (!anchor) return { found: false, remaining: [] }

    await tx
      .delete(messages)
      .where(and(eq(messages.conversationId, args.conversationId), gt(messages.position, anchor.position)))

    if (args.newContent !== undefined) {
      await tx.update(messages).set({ content: args.newContent }).where(eq(messages.id, args.messageId))
    }

    const remaining = await tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, args.conversationId))
      .orderBy(asc(messages.position))

    await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, args.conversationId))

    return { found: true, remaining }
  })
}
