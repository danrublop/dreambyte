import { describe, it, expect } from 'vitest'
import { PASTE_DELIM, splitPastedContent } from './pasted-text'

describe('splitPastedContent', () => {
  it('returns text unchanged with no chips when there is no pasted block', () => {
    expect(splitPastedContent('just a normal message')).toEqual({
      display: 'just a normal message',
      chips: [],
    })
  })

  it('splits one inlined pasted block into a chip, keeping the user text', () => {
    const big = 'x'.repeat(5000)
    const content = `make a video about this${PASTE_DELIM}${big}`
    const { display, chips } = splitPastedContent(content)
    expect(display).toBe('make a video about this')
    expect(chips).toHaveLength(1)
    expect(chips[0].text).toBe(big)
  })

  it('splits multiple pasted blocks in order', () => {
    const content = `intro${PASTE_DELIM}first paste${PASTE_DELIM}second paste`
    const { display, chips } = splitPastedContent(content)
    expect(display).toBe('intro')
    expect(chips.map((c) => c.text)).toEqual(['first paste', 'second paste'])
  })

  it('handles a paste-only message (empty user text)', () => {
    const content = `${PASTE_DELIM}only a paste`
    const { display, chips } = splitPastedContent(content)
    expect(display).toBe('')
    expect(chips).toEqual([{ id: 'paste-0', text: 'only a paste' }])
  })

  it('round-trips the AgentChat assembly (display + delim-joined blocks)', () => {
    // Mirror handleSend: fullText = userText + blocks.map(PASTE_DELIM+text).join('')
    const userText = 'edit the timeline'
    const blocks = ['paste A', 'paste B']
    const fullText = userText + blocks.map((t) => `${PASTE_DELIM}${t}`).join('')
    const { display, chips } = splitPastedContent(fullText)
    expect(display).toBe(userText)
    expect(chips.map((c) => c.text)).toEqual(blocks)
  })
})
