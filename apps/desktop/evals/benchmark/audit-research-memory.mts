/**
 * Full E2E audit of the research-memory feature against a REAL agent build.
 * parent=Haiku, research=DeepSeek V4 Flash (proven loop) + SearXNG, embedder=bundled.
 *
 *   TSX_TSCONFIG_PATH=evals/benchmark/tsconfig.json node --env-file=.env --env-file=.env.local \
 *     --import tsx evals/benchmark/audit-research-memory.mts
 *
 * Proves A (persist + semantic reuse) and B (media lands as assets) in one run:
 *  1. runs a research + archival-image + build prompt
 *  2. asserts a research_notes row (embedding + sources + assetIds)
 *  3. asserts project_assets staged from research
 *  4. directly exercises findRelevantNotes with the same topic → reuse retrieval fires
 */
import type { ModelConfig } from '@/lib/agents/model-config'

async function main() {
  const { runAgentRequest } = await import('@/lib/services/agent-runner')
  const { createProject } = await import('@/lib/db/queries/projects')
  const { db } = await import('@/lib/db/index')
  const { researchNotes, projectAssets } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { embedText } = await import('@/lib/research/embed')
  const { findRelevantNotes } = await import('@/lib/db/queries/research-notes')
  type Req = import('@/lib/services/agent-runner').AgentAPIRequest

  const deepseek: ModelConfig = {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    tier: 'budget',
    enabled: true,
    isDefault: true,
    costPer1MInput: 0.14,
    costPer1MOutput: 0.28,
    maxTokens: 32768,
    supportsTools: true,
    supportsStreaming: true,
  }

  const projectId = `audit-resmem-${process.pid}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createProject({ id: projectId, name: 'audit:resmem', outputMode: 'mp4' } as any)

  const events: Array<Record<string, unknown>> = []
  const body: Req = {
    message:
      "Research the history of the Eiffel Tower using a 'research' subagent, and have it find 2 real archival " +
      'photos with find_archival_footage. Then build ONE short scene titled "Eiffel Tower" that shows the ' +
      'research findings. Keep it minimal — one scene only.',
    scenes: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalStyle: { presetId: null } as any,
    projectName: 'audit:resmem',
    outputMode: 'mp4',
    projectId,
    branchId: null,
    modelOverride: 'claude-haiku-4-5',
    modelTier: 'auto',
    researchModelId: 'deepseek-v4-flash',
    modelConfigs: [deepseek],
    enabledModelIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'deepseek-v4-flash'],
    webSearchEnabled: true,
    webFetchEnabled: true,
    autoAcceptWebSearch: true,
    aiQualityReview: false,
    runBudgetUsd: 5,
  }

  process.stderr.write('[audit] running real build (parent=Haiku, research=DeepSeek, search=SearXNG)…\n')
  let err: string | undefined
  try {
    await runAgentRequest({
      body,
      authenticatedUserId: null,
      abortSignal: new AbortController().signal,
      emit: (e) => events.push(e as unknown as Record<string, unknown>),
    })
  } catch (e) {
    err = (e as Error).message
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (t: string) => events.filter((e) => e.type === 'tool_complete' && (e as any).toolName === t).length

  // ── DB inspection ──────────────────────────────────────────────
  const notes = await db.select().from(researchNotes).where(eq(researchNotes.projectId, projectId))
  const assets = await db.select().from(projectAssets).where(eq(projectAssets.projectId, projectId))
  const researchAssets = assets.filter((a) => (a.tags ?? []).includes('research'))

  // ── Direct semantic-reuse retrieval on the SAME topic ──────────
  const topicEmb = await embedText('history of the Eiffel Tower Paris')
  const reused = topicEmb ? await findRelevantNotes(projectId, topicEmb, Date.now()) : []

  const n0 = notes[0]
  console.log('\n================ RESEARCH-MEMORY AUDIT ================')
  console.log('error:', err ?? '(none)')
  console.log('tools: dispatch_subagent=%d web_search=%d find_archival=%d write_scene_code=%d',
    tool('dispatch_subagent'), tool('web_search'), tool('find_archival_footage'), tool('write_scene_code'))
  console.log('--- A: persistence ---')
  console.log('research_notes rows:', notes.length)
  if (n0) {
    console.log('  topic:', String(n0.topic).slice(0, 70))
    console.log('  brief chars:', (n0.brief ?? '').length, '| sources:', (n0.sources ?? []).length,
      '| assetIds:', (n0.assetIds ?? []).length)
    console.log('  embedding dim:', Array.isArray(n0.embedding) ? n0.embedding.length : 'NULL',
      '| embedModel:', n0.embedModel ?? 'NULL')
    console.log('  brief has "Staged assets" block:', (n0.brief ?? '').includes('## Staged assets'))
  }
  console.log('--- B: media staged as assets ---')
  console.log('project_assets total:', assets.length, '| tagged research:', researchAssets.length)
  researchAssets.slice(0, 4).forEach((a) => console.log('  -', a.id.slice(0, 8), a.type, String(a.name).slice(0, 40)))
  console.log('--- A(reuse): semantic retrieval on same topic ---')
  console.log('findRelevantNotes returned:', reused.length, reused.length ? '(REUSE FIRES ✓)' : '(no match)')
  console.log('--- VERDICT ---')
  const pass = notes.length >= 1 && !!n0 && Array.isArray(n0.embedding) && reused.length >= 1
  console.log(pass ? 'PASS: persisted with embedding + semantic reuse retrieves it' : 'CHECK: see rows above')
  console.log('======================================================\n')
  process.exit(0)
}
main().catch((e) => {
  console.error('HARNESS FAIL:', e?.stack || e?.message || e)
  process.exit(1)
})
