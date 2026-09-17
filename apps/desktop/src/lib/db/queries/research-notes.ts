import 'server-only'
import { db } from '../index'
import { researchNotes } from '../schema'
import { eq, desc } from 'drizzle-orm'
import { createLogger } from '@/lib/logger'
import { EMBED_MODEL, EMBED_DIM } from '@/lib/research/embed'
import { rankNotes, type RankableNote } from '@/lib/research/note-ranking'

const log = createLogger('db.research-notes')

export interface NewResearchNote {
  projectId: string
  topic: string
  brief: string
  sources: { title: string; url: string }[]
  assetIds: string[]
  embedding: number[] | null
}

/**
 * Persist a research sub-agent's output. Best-effort by contract: a write failure
 * logs and is swallowed so a DB hiccup never fails the agent run (the note is just
 * missing next time). Stamps embedModel/embedDim only when an embedding exists.
 */
export async function insertResearchNote(note: NewResearchNote): Promise<void> {
  try {
    await db.insert(researchNotes).values({
      projectId: note.projectId,
      topic: note.topic,
      brief: note.brief,
      sources: note.sources,
      assetIds: note.assetIds,
      embedding: note.embedding ?? null,
      embedModel: note.embedding ? EMBED_MODEL : null,
      embedDim: note.embedding ? EMBED_DIM : null,
    })
  } catch (e) {
    log.warn(`insertResearchNote failed (swallowed): ${(e as Error)?.message ?? e}`)
  }
}

/**
 * Notes to inject as "prior research" for a new task in this project.
 * `queryEmbedding` null ⇒ embedder unavailable ⇒ degrade to most-recent (rankNotes).
 * Reads a bounded recent window (not the whole table) then ranks in JS — a project
 * has tens of notes, so a full scan is instant and needs no vector index.
 */
export async function findRelevantNotes(
  projectId: string,
  queryEmbedding: number[] | null,
  nowMs: number,
): Promise<RankableNote[]> {
  try {
    const rows = await db
      .select({
        id: researchNotes.id,
        topic: researchNotes.topic,
        brief: researchNotes.brief,
        embedding: researchNotes.embedding,
        embedModel: researchNotes.embedModel,
        embedDim: researchNotes.embedDim,
        createdAt: researchNotes.createdAt,
      })
      .from(researchNotes)
      .where(eq(researchNotes.projectId, projectId))
      .orderBy(desc(researchNotes.createdAt))
      .limit(200)
    return rankNotes(rows as RankableNote[], {
      queryEmbedding,
      embedModel: EMBED_MODEL,
      embedDim: EMBED_DIM,
      nowMs,
    })
  } catch (e) {
    log.warn(`findRelevantNotes failed (swallowed): ${(e as Error)?.message ?? e}`)
    return []
  }
}
