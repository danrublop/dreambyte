import { describe, it, expect } from 'vitest'
import { serializeConversationToMarkdown, slugifyTitle, exportFilename, type ExportConversation } from './chat-export'

describe('serializeConversationToMarkdown', () => {
  it('renders a title header and role-headed sections for string content', () => {
    const conv: ExportConversation = {
      title: 'My build',
      messages: [
        { role: 'user', content: 'Make a logo intro' },
        { role: 'assistant', content: 'Sure, here it is.' },
      ],
    }
    const md = serializeConversationToMarkdown(conv)
    expect(md).toContain('# My build')
    expect(md).toContain('## User')
    expect(md).toContain('Make a logo intro')
    expect(md).toContain('## Assistant')
    expect(md).toContain('Sure, here it is.')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('renders image blocks as placeholders and text blocks verbatim', () => {
    const conv: ExportConversation = {
      title: 'With image',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Match this style' },
            { type: 'image', image: { dataUri: 'data:...' } },
          ],
        },
      ],
    }
    const md = serializeConversationToMarkdown(conv)
    expect(md).toContain('Match this style')
    expect(md).toContain('![attachment]')
  })

  it('collapses tool calls to one line each with an arg summary', () => {
    const conv: ExportConversation = {
      title: 'Tools',
      messages: [
        {
          role: 'assistant',
          content: 'Working on it',
          toolCalls: [
            { toolName: 'write_scene_code', input: { sceneId: 'abc', prompt: 'a bouncing ball' } },
            { toolName: 'verify_scene', input: {} },
          ],
        },
      ],
    }
    const md = serializeConversationToMarkdown(conv)
    expect(md).toContain('- 🔧 write_scene_code(sceneId: abc, prompt: a bouncing ball)')
    expect(md).toContain('- 🔧 verify_scene()')
  })

  it('truncates a long arg summary', () => {
    const longPrompt = 'x'.repeat(200)
    const md = serializeConversationToMarkdown({
      title: 't',
      messages: [{ role: 'assistant', content: '', toolCalls: [{ toolName: 'gen', input: { prompt: longPrompt } }] }],
    })
    const line = md.split('\n').find((l) => l.startsWith('- 🔧 gen('))!
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(longPrompt.length)
  })

  it('renders a per-message footer and a total cost when costs are present', () => {
    const conv: ExportConversation = {
      title: 'Costs',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'reply', modelId: 'claude-opus', costUsd: 0.0125 },
        { role: 'assistant', content: 'reply2', modelId: 'claude-sonnet', costUsd: 0.005 },
      ],
    }
    const md = serializeConversationToMarkdown(conv)
    expect(md).toContain('_claude-opus · $0.0125_')
    expect(md).toContain('_claude-sonnet · $0.0050_')
    expect(md).toContain('**Total cost:** $0.0175')
  })

  it('omits the total cost line when no message carried a cost', () => {
    const md = serializeConversationToMarkdown({
      title: 'No cost',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(md).not.toContain('Total cost')
  })

  it('handles an empty conversation', () => {
    const md = serializeConversationToMarkdown({ title: '', messages: [] })
    expect(md).toBe('# Conversation\n')
  })

  it('falls back to a default title when title is missing', () => {
    const md = serializeConversationToMarkdown({ messages: [{ role: 'user', content: 'x' }] })
    expect(md).toContain('# Conversation')
  })
})

describe('slugifyTitle / exportFilename', () => {
  it('slugifies a title', () => {
    expect(slugifyTitle('My Cool Build!')).toBe('my-cool-build')
    expect(slugifyTitle('  spaced  out  ')).toBe('spaced-out')
    expect(slugifyTitle('')).toBe('conversation')
    expect(slugifyTitle(null)).toBe('conversation')
  })

  it('builds a dated filename', () => {
    const d = new Date(2026, 5, 4) // 2026-06-04 (month is 0-indexed)
    expect(exportFilename('My Build', d)).toBe('my-build-2026-06-04.md')
    expect(exportFilename(null, d)).toBe('conversation-2026-06-04.md')
  })
})
