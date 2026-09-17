/**
 * Headless E2E proof: research sub-agent runs on DeepSeek V4 Flash (cheap cloud,
 * ~$0.14/1M, no native search → SearXNG), parent = Anthropic Haiku (frontier).
 * Proves the researchModelId setting + SearXNG-backed web_search + media pull for
 * a NON-LOCAL cheap model. Run with the eval tsconfig (stubs 'server-only'):
 *   TSX_TSCONFIG_PATH=evals/benchmark/tsconfig.json node --env-file=.env --env-file=.env.local \
 *     --import tsx evals/benchmark/proof-deepseek.mts
 */
import type { ModelConfig } from '@/lib/agents/model-config'

async function main() {
  const { runAgentRequest } = await import('@/lib/services/agent-runner')
  const { createProject } = await import('@/lib/db/queries/projects')
  type Req = import('@/lib/services/agent-runner').AgentAPIRequest

  // deepseek-v4-flash is a DEFAULT model; pass it explicitly so it's ENABLED and
  // the DEEPSEEK_API_KEY (from --env-file) reaches the runner.
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

  const projectId = `e2e-deepresearch-ds-${process.pid}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createProject({ id: projectId, name: 'e2e:deepresearch-ds', outputMode: 'mp4' } as any)

  const events: Array<Record<string, unknown>> = []
  const body: Req = {
    message:
      "Use the dispatch_subagent tool with subagentType 'research' to research the history of the Eiffel Tower " +
      'and find 2 archival images of it (use find_archival_footage). Do NOT build any scenes. When the research ' +
      'sub-agent returns, reply with its brief including the image URLs.',
    scenes: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalStyle: { presetId: null } as any,
    projectName: 'e2e:deepresearch-ds',
    outputMode: 'mp4',
    projectId,
    branchId: null,
    modelOverride: 'claude-haiku-4-5', // frontier parent
    modelTier: 'auto',
    researchModelId: 'deepseek-v4-flash', // research sub-agent → DeepSeek, cheap
    modelConfigs: [deepseek],
    enabledModelIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'deepseek-v4-flash'],
    webSearchEnabled: true,
    webFetchEnabled: true,
    autoAcceptWebSearch: true,
    aiQualityReview: false,
    runBudgetUsd: 4,
  }

  process.stderr.write('[e2e] running… (parent=Haiku, research=DeepSeek V4 Flash, search=SearXNG)\n')
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

  const finalText = events
    .filter((e) => e.type === 'text' || e.type === 'assistant_text' || e.type === 'done')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e) => (e as any).text ?? (e as any).fullText ?? '')
    .filter(Boolean)
    .pop()

  for (const e of events) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = e as any
    if (ev.type === 'tool_complete' && ev.result && ev.result.success === false) {
      console.log('FAILED TOOL:', ev.toolName, '| input:', JSON.stringify(ev.toolInput ?? ev.input ?? {}).slice(0, 160), '| error:', String(ev.result.error).slice(0, 160))
    }
  }
  console.log('\n================ E2E RESULT (DeepSeek) ================')
  console.log('error:', err ?? '(none)')
  console.log('tools called:', names.join(', ') || '(none)')
  console.log('dispatch_subagent calls:', tool('dispatch_subagent').length)
  console.log('web_search calls:', tool('web_search').length)
  console.log('find_archival_footage calls:', tool('find_archival_footage').length)
  console.log('--- final brief (first 900 chars) ---')
  console.log((finalText || '(no final text captured)').slice(0, 900))
  console.log('======================================================\n')
}
main().catch((e) => {
  console.error('HARNESS FAIL:', e?.stack || e?.message || e)
  process.exit(1)
})
