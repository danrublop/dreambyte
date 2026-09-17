import { describe, it, expect } from 'vitest'
import { embedText, EMBED_DIM, EMBED_MODEL, _resetEmbedderForTest } from './embed'

// The real embedding path (model load + inference) is proven by the feasibility
// spike, not re-run here — loading the ONNX model is slow and network-dependent.
// These cover the no-load guards: empty input never touches the model.
describe('embedText — guards', () => {
  it('returns null for empty / whitespace input without loading the model', async () => {
    _resetEmbedderForTest()
    expect(await embedText('')).toBeNull()
    expect(await embedText('   \n ')).toBeNull()
  })

  it('exposes stable model identity for the schema guards', () => {
    expect(EMBED_DIM).toBe(384)
    expect(EMBED_MODEL).toContain('all-MiniLM-L6-v2')
  })
})
