/**
 * Mock Google (@google/genai) client for vitest fixtures.
 *
 * Implements the slice of the SDK the runner + google-adapter consume:
 *   client.models.generateContentStream(params) → AsyncIterable<chunk>
 *
 * Each call dequeues the next scripted response (one per agent iteration),
 * mirroring MockAnthropicClient's queue semantics so multi-iteration tool
 * loops can be scripted. Captured params let tests assert request shape.
 */

// Chunks are loosely typed — the adapter/runner switch on field presence
// (.text, .candidates, .usageMetadata), not full SDK types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScriptedGeminiChunk = Record<string, any>

export interface ScriptedGeminiResponse {
  chunks: ScriptedGeminiChunk[]
}

async function* toStream(chunks: ScriptedGeminiChunk[]): AsyncIterable<ScriptedGeminiChunk> {
  for (const c of chunks) yield c
}

export class MockGoogleClient {
  private queue: ScriptedGeminiResponse[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly captured: any[] = []

  constructor(responses: ScriptedGeminiResponse[]) {
    this.queue = [...responses]
  }

  public readonly models = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContentStream: async (params: any): Promise<AsyncIterable<ScriptedGeminiChunk>> => {
      this.captured.push(params)
      const next = this.queue.shift()
      if (!next) throw new Error('MockGoogleClient: out of scripted responses (more iterations than scripted)')
      return toStream(next.chunks)
    },
  }
}

// ── Chunk builders ──────────────────────────────────────────────────────────

export const geminiText = (text: string): ScriptedGeminiChunk => ({ text })

export const geminiFunctionCall = (name: string, args: Record<string, unknown>): ScriptedGeminiChunk => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
})

export const geminiUsage = (promptTokenCount: number, candidatesTokenCount: number): ScriptedGeminiChunk => ({
  usageMetadata: { promptTokenCount, candidatesTokenCount },
})

export const geminiFinish = (finishReason = 'STOP'): ScriptedGeminiChunk => ({ candidates: [{ finishReason }] })

export const geminiGrounding = (sources: Array<{ uri: string; title?: string }>): ScriptedGeminiChunk => ({
  candidates: [
    { groundingMetadata: { groundingChunks: sources.map((s) => ({ web: { uri: s.uri, title: s.title } })) } },
  ],
})
