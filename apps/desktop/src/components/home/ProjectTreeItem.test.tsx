import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProjectTreeItem from './ProjectTreeItem'

const list = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { dreambyteApi: unknown }).dreambyteApi = { conversations: { list } }
})
afterEach(() => {
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
})

function row(over: Partial<React.ComponentProps<typeof ProjectTreeItem>> = {}) {
  return (
    <ProjectTreeItem
      id="p1"
      name="Project One"
      active={false}
      activeConversationId={null}
      onOpenProject={vi.fn()}
      onOpenChat={vi.fn()}
      {...over}
    />
  )
}

describe('ProjectTreeItem lazy load', () => {
  it('does not fetch chats until expanded', () => {
    render(row())
    expect(list).not.toHaveBeenCalled()
  })

  it('loads and renders chats when expanded via the chevron', async () => {
    list.mockResolvedValue({ conversations: [{ id: 'c1', title: 'First chat' }] })
    render(row())
    fireEvent.click(screen.getByTitle('Expand'))
    expect(await screen.findByText('First chat')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith('p1')
  })

  it('auto-loads when defaultExpanded (active project) — no blank section', async () => {
    list.mockResolvedValue({ conversations: [{ id: 'c1', title: 'Auto chat' }] })
    render(row({ active: true, defaultExpanded: true }))
    expect(await screen.findByText('Auto chat')).toBeInTheDocument()
  })

  it('filters out archived conversations', async () => {
    list.mockResolvedValue({
      conversations: [
        { id: 'c1', title: 'Kept' },
        { id: 'c2', title: 'Gone', isArchived: true },
      ],
    })
    render(row({ defaultExpanded: true }))
    expect(await screen.findByText('Kept')).toBeInTheDocument()
    expect(screen.queryByText('Gone')).not.toBeInTheDocument()
  })
})

describe('ProjectTreeItem staleness refresh', () => {
  it('silently refreshes when a new active conversation is not in the cached list', async () => {
    list.mockResolvedValueOnce({ conversations: [{ id: 'c1', title: 'Chat one' }] })
    const { rerender } = render(row({ active: true, defaultExpanded: true, activeConversationId: 'c1' }))
    expect(await screen.findByText('Chat one')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(1)

    // A new chat 'c2' becomes active (created in the chat view) — not in cache.
    list.mockResolvedValueOnce({
      conversations: [
        { id: 'c1', title: 'Chat one' },
        { id: 'c2', title: 'Brand new chat' },
      ],
    })
    rerender(row({ active: true, defaultExpanded: true, activeConversationId: 'c2' }))

    expect(await screen.findByText('Brand new chat')).toBeInTheDocument()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    // The old chat stayed visible during the background refresh (no flash).
    expect(screen.getByText('Chat one')).toBeInTheDocument()
  })

  it('does not refresh when the active conversation is already cached', async () => {
    list.mockResolvedValue({
      conversations: [
        { id: 'c1', title: 'Chat one' },
        { id: 'c2', title: 'Chat two' },
      ],
    })
    const { rerender } = render(row({ active: true, defaultExpanded: true, activeConversationId: 'c1' }))
    expect(await screen.findByText('Chat one')).toBeInTheDocument()
    rerender(row({ active: true, defaultExpanded: true, activeConversationId: 'c2' }))
    // c2 was already in the list — no extra fetch.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  })
})
