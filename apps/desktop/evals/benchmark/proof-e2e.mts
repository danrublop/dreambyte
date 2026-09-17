/**
 * Headless E2E proof of the local deep-research feature.
 * Parent = Anthropic Haiku (frontier). Research sub-agent = WebSailor-7B (local Ollama, $0).
 * Search backend = SearXNG (SEARXNG_URL, free). Media = find_archival_footage (free APIs).
 * Run with the eval tsconfig (stubs 'server-only'):
 *   TSX_TSCONFIG_PATH=evals/benchmark/tsconfig.json node --env-file=.env --env-file=.env.local \
 *     --import tsx evals/benchmark/proof-e2e.mts
 */
import type { ModelConfig } from '@/lib/agents/model-config'

const WS_MODEL = process.env.RESEARCH_MODEL || 'hf.co/mradermacher/WebSailor-7B-GGUF:Q4_K_M'

async function main() {
  const { runAgentRequest } = await import('@/lib/services/agent-runner')
  const { createProject } = await import('@/lib/db/queries/projects')
  type Req = import('@/lib/services/agent-runner').AgentAPIRequest

  const websailor: ModelConfig = {
    id: 'websailor-7b',
    provider: 'local',
    modelId: WS_MODEL,
    displayName: 'WebSailor-7B',
    tier: 'budget',
    enabled: true,
    isDefault: false,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    maxTokens: 32768,
    supportsTools: true,
    supportsStreaming: true,
    endpoint: 'http://localhost:11434',
    localModelName: WS_MODEL,
  }

  const projectId = `e2e-deepresearch-${process.pid}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createProject({ id: projectId, name: 'e2e:deepresearch', outputMode: 'mp4' } as any)

  const events: Array<Record<string, unknown>> = []
  const body: Req = {
    message:
      "Use the dispatch_subagent tool with subagentType 'research' to research the history of the Eiffel Tower " +
      'and find 2 archival images of it (use find_archival_footage). Do NOT build any scenes. When the research ' +
      'sub-agent returns, reply with its brief including the image URLs.',
    scenes: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalStyle: { presetId: null } as any,
    projectName: 'e2e:deepresearch',
    outputMode: 'mp4',
    projectId,
    branchId: null,
    modelOverride: 'claude-haiku-4-5', // frontier parent
    modelTier: 'auto',
    researchModelId: 'websailor-7b', // research sub-agent → local, $0
    modelConfigs: [websailor],
    enabledModelIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'websailor-7b', WS_MODEL],
    webSearchEnabled: true,
    webFetchEnabled: true,
    autoAcceptWebSearch: true,
    aiQualityReview: false,
    runBudgetUsd: 4,
  }

  process.stderr.write('[e2e] running… (parent=Haiku, research=WebSailor local, search=SearXNG)\n')
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
  const tool = (t: string) => events.filter((e) => e.type === 'tool_complete' && (e as any).toolName === t)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = [...new Set(events.filter((e) => e.type === 'tool_complete').map((e) => (e as any).toolName))]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalText = events
    .filter((e) => e.type === 'text' || e.type === 'assistant_text' || e.type === 'done')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e) => (e as any).text ?? (e as any).fullText ?? '')
    .filter(Boolean)
    .pop()

  // Dump any failed tool call (esp. Invalid tool args) with the tool + error.
  for (const e of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = e as any
    if (ev.type === 'tool_complete' && ev.result && ev.result.success === false) {
      console.log('FAILED TOOL:', ev.toolName, '| input:', JSON.stringify(ev.toolInput ?? ev.input ?? {}).slice(0,160), '| error:', String(ev.result.error).slice(0,160))
    }
  }
  console.log('\n================ E2E RESULT ================')
  console.log('error:', err ?? '(none)')
  console.log('tools called:', names.join(', ') || '(none)')
  console.log('dispatch_subagent calls:', tool('dispatch_subagent').length)
  console.log('web_search calls:', tool('web_search').length)
  console.log('find_archival_footage calls:', tool('find_archival_footage').length)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evt = events.filter((e) => /sub_agent|dispatch|model/i.test(String((e as any).type)))
  for (const m of evt.slice(0, 10)) console.log('  evt:', JSON.stringify(m).slice(0, 180))
  console.log('--- final brief (first 800 chars) ---')
  console.log((finalText || '(no final text captured)').slice(0, 800))
  console.log('===========================================\n')
}
main().catch((e) => {
  console.error('HARNESS FAIL:', e?.stack || e?.message || e)
  process.exit(1)
})
