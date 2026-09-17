/**
 * Provider adapter registry — barrel + side-effect import for the registry.
 *
 * The runner imports this module solely for its side effect (registering
 * each adapter) plus the typed `getAdapter` lookup. Adding a new provider
 * means: (1) drop a `*-adapter.ts` next to this file, (2) import + register
 * it here.
 *
 * Status: adapters are LIVE — `runConfig.useProviderAdapters` defaults to
 * true (DEFAULT_RUN_CONFIG in runner.ts). Google routes through its adapter
 * unconditionally; Anthropic/OpenAI/local/deepseek/qwen/kimi route through
 * theirs whenever the flag is on, with the runner's legacy OpenAI/local branch
 * kept only as a rollback path when it's explicitly disabled.
 */

import { registerAdapter } from './adapter'
import { googleAdapter } from './google-adapter'
import { anthropicAdapter } from './anthropic-adapter'
import { openaiAdapter } from './openai-adapter'
import { createOpenAICompatChatAdapter } from './openai-compat-chat-adapter'
import { getDeepseekClient, getQwenClient, getKimiClient, getLocalClient } from '../providers'

registerAdapter(googleAdapter)
registerAdapter(anthropicAdapter)
registerAdapter(openaiAdapter)
// Cheap OpenAI-compatible chat providers as first-class agent models.
// All three speak OpenAI /chat/completions with tool calling, so one factory
// drives them; each just supplies its own base-URL + key client.
//   - DeepSeek: text/reasoning only (no vision — that's deepseek-vl2, open-weights).
//   - Qwen (DashScope) and Kimi (Moonshot): also vision-capable; their key is
//     shared with the media-understanding intake path.
registerAdapter(createOpenAICompatChatAdapter('deepseek', getDeepseekClient))
registerAdapter(createOpenAICompatChatAdapter('qwen', getQwenClient))
registerAdapter(createOpenAICompatChatAdapter('kimi', getKimiClient))
// `local` (Ollama and anything else OpenAI-compatible behind a base URL) is the
// CATCH-ALL provider for any unrecognised model id (types.ts getModelProvider),
// so it is not a niche path. Without a registered adapter it fell to the legacy
// runner branch, which has NO 429 handling and counts cached tokens as full-price
// input. Same chat-completions protocol, so the same factory drives it; the
// per-model endpoint arrives as providerOverrides.endpoint (the runner reads it
// off the model config — the adapter registry is built once at module load and
// can't see per-run configs).
registerAdapter(
  createOpenAICompatChatAdapter('local', (opts) =>
    getLocalClient(String(opts.providerOverrides?.endpoint ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434')),
  ),
)

export {
  getAdapter,
  type ProviderAdapter,
  type NormalizedStreamEvent,
  type NormalizedUsage,
  type CanonicalMessage,
  type CacheBreakpoint,
  type StreamChatOptions,
} from './adapter'
