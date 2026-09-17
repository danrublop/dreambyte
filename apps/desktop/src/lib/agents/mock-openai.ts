/**
 * Mock OpenAI client for vitest fixtures.
 *
 * Implements the slice the runner + openai-adapter consume:
 *   client.chat.completions.create(params) → AsyncIterable<chunk>   (streaming)
 *   client.responses.create(params)        → AsyncIterable<event>   (Responses API)
 *
 * Separate queues per surface; each create() call dequeues the next scripted
 * response (one per agent iteration), mirroring MockAnthropicClient.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScriptedOpenAIChunk = Record<string, any>

export interface ScriptedOpenAIResponse {
  chunks: ScriptedOpenAIChunk[]
}

async function* toStream(chunks: ScriptedOpenAIChunk[]): AsyncIterable<ScriptedOpenAIChunk> {
  for (const c of chunks) yield c
}

export class MockOpenAIClient {
  private chatQueue: ScriptedOpenAIResponse[]
  private responsesQueue: ScriptedOpenAIResponse[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly capturedChat: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly capturedResponses: any[] = []

  constructor(opts: { chat?: ScriptedOpenAIResponse[]; responses?: ScriptedOpenAIResponse[] } = {}) {
    this.chatQueue = [...(opts.chat ?? [])]
    this.responsesQueue = [...(opts.responses ?? [])]
  }

  public readonly chat = {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (params: any): Promise<AsyncIterable<ScriptedOpenAIChunk>> => {
        this.capturedChat.push(params)
        const next = this.chatQueue.shift()
        if (!next) throw new Error('MockOpenAIClient: out of scripted chat responses')
        return toStream(next.chunks)
      },
    },
  }

  public readonly responses = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (params: any): Promise<AsyncIterable<ScriptedOpenAIChunk>> => {
      this.capturedResponses.push(params)
      const next = this.responsesQueue.shift()
      if (!next) throw new Error('MockOpenAIClient: out of scripted responses-API responses')
      return toStream(next.chunks)
    },
  }
}

// ── Chat Completions chunk builders ───────────────────────────────────────────

export const oaiText = (content: string, finishReason: string | null = null): ScriptedOpenAIChunk => ({
  choices: [{ delta: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
})

export const oaiFinish = (
  finishReason: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
): ScriptedOpenAIChunk => ({
  choices: [{ delta: {}, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
})

/** A complete tool call delivered across the standard 3 deltas: name, args, done. */
export const oaiToolCallChunks = (index: number, id: string, name: string, args: string): ScriptedOpenAIChunk[] => [
  { choices: [{ delta: { tool_calls: [{ index, id, function: { name } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }] },
]
