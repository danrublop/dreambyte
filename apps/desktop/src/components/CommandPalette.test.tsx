// @vitest-environment jsdom
//
// Coverage for the global command palette. The component holds the
// load-bearing branches the audit flagged as wired-without-tests:
//   - mode switch: PROJECT search (welcome/home, projects non-empty) vs COMMAND
//     search (editor), they are mutually exclusive;
//   - case-insensitive label/hint filtering;
//   - conversation search results appended under their own section via the IPC;
//   - keyboard navigation (ArrowDown/Up clamp to list bounds) and Enter →
//     fire(), which dispatches a DIFFERENT onAction shape per row kind
//     (open-project / command / open-conversation) — the routing that, if wrong,
//     opens the wrong thing.
//
// IPC (conversation search) is mocked on window.dreambyteApi.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CommandPalette, COMMAND_ITEMS } from './CommandPalette'

const search = vi.fn(async () => ({ results: [] as unknown[] }))

beforeEach(() => {
  vi.useFakeTimers()
  search.mockReset()
  search.mockResolvedValue({ results: [] })
  ;(window as unknown as { dreambyteApi: unknown }).dreambyteApi = {
    conversations: { search },
  }
})

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  }
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
})

function getInput(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement
}

describe('CommandPalette — command mode (editor)', () => {
  it('renders all command items when no projects are passed', () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} />)
    for (const item of COMMAND_ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument()
    }
  })

  it('filters commands case-insensitively by label OR hint', () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} />)
    // "EXPORT" upper-cased still matches the "Export / Publish" label.
    fireEvent.change(getInput(), { target: { value: 'EXPORT' } })
    expect(screen.getByText('Export / Publish')).toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()

    // "finder" only appears in the reveal command's HINT, not its label.
    fireEvent.change(getInput(), { target: { value: 'finder' } })
    expect(screen.getByText('Reveal mirror in Finder')).toBeInTheDocument()
  })

  it('shows the no-results state when nothing matches', () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} />)
    fireEvent.change(getInput(), { target: { value: 'zzz-no-such-command' } })
    expect(screen.getByText('No results found')).toBeInTheDocument()
  })

  it('Enter on a command row dispatches a { type: command, action } payload', () => {
    const onAction = vi.fn()
    render(<CommandPalette onClose={() => {}} onAction={onAction} />)
    // Narrow to a single command (only the Agents item carries this hint) so
    // selectedIndex 0 deterministically targets it.
    fireEvent.change(getInput(), { target: { value: 'Agent configuration' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith({ type: 'command', action: 'agents' })
  })

  it('clicking a command row fires its action', () => {
    const onAction = vi.fn()
    render(<CommandPalette onClose={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByText('Layers'))
    expect(onAction).toHaveBeenCalledWith({ type: 'command', action: 'layers' })
  })
})

describe('CommandPalette — project mode (welcome/home)', () => {
  const projects = [
    { id: 'p-a', name: 'Alpha Reel' },
    { id: 'p-b', name: 'Beta Promo' },
  ]

  it('lists projects and NOT commands when projects are present (mutually exclusive)', () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} projects={projects} />)
    expect(screen.getByText('Alpha Reel')).toBeInTheDocument()
    expect(screen.getByText('Beta Promo')).toBeInTheDocument()
    // Command items must NOT render in project mode.
    expect(screen.queryByText('Export / Publish')).not.toBeInTheDocument()
  })

  it('filters projects case-insensitively', () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} projects={projects} />)
    fireEvent.change(getInput(), { target: { value: 'alpha' } })
    expect(screen.getByText('Alpha Reel')).toBeInTheDocument()
    expect(screen.queryByText('Beta Promo')).not.toBeInTheDocument()
  })

  it('Enter on a project row dispatches { type: open-project, projectId }', () => {
    const onAction = vi.fn()
    render(<CommandPalette onClose={() => {}} onAction={onAction} projects={projects} />)
    fireEvent.change(getInput(), { target: { value: 'beta' } })
    fireEvent.keyDown(getInput(), { key: 'Enter' })
    expect(onAction).toHaveBeenCalledWith({ type: 'open-project', projectId: 'p-b' })
  })
})

describe('CommandPalette — keyboard navigation', () => {
  const projects = [
    { id: 'p-a', name: 'Aaa' },
    { id: 'p-b', name: 'Bbb' },
    { id: 'p-c', name: 'Ccc' },
  ]

  it('ArrowDown/ArrowUp move the selection and clamp at the list bounds', () => {
    const onAction = vi.fn()
    render(<CommandPalette onClose={() => {}} onAction={onAction} projects={projects} />)
    const input = getInput()
    // Start at index 0 (Aaa). Down twice → Ccc; a third Down clamps at Ccc.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // clamp
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'open-project', projectId: 'p-c' })

    onAction.mockClear()
    // Up past the top clamps at index 0 (Aaa).
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' }) // clamp
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAction).toHaveBeenLastCalledWith({ type: 'open-project', projectId: 'p-a' })
  })

  it('Escape closes the palette', () => {
    const onClose = vi.fn()
    render(<CommandPalette onClose={onClose} onAction={() => {}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('CommandPalette — conversation search (T8 / D11)', () => {
  it('does NOT call search for queries shorter than 2 chars', async () => {
    render(<CommandPalette onClose={() => {}} onAction={() => {}} />)
    fireEvent.change(getInput(), { target: { value: 'a' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(search).not.toHaveBeenCalled()
  })

  it('debounces, queries the IPC, and renders a conversation result that dispatches open-conversation', async () => {
    // Real timers here: the IPC resolves a microtask after the 200ms debounce,
    // which fake timers + React act() flushing deadlocks against. The debounce
    // is short enough to await directly.
    vi.useRealTimers()
    search.mockResolvedValue({
      results: [
        {
          conversationId: 'c-1',
          projectId: 'p-9',
          title: 'Neon City',
          matchedOn: 'message',
          snippet: '…flamingo…',
        },
      ],
    })
    const onAction = vi.fn()
    render(<CommandPalette onClose={() => {}} onAction={onAction} />)
    // A 2+ char query that matches NO command, so only the conversation row shows.
    fireEvent.change(getInput(), { target: { value: 'flamingo' } })

    expect(await screen.findByText('Neon City')).toBeInTheDocument()
    expect(search).toHaveBeenCalledWith({ query: 'flamingo', limit: 50 })
    expect(screen.getByText('Conversations')).toBeInTheDocument()
    expect(screen.getByText('…flamingo…')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Neon City'))
    expect(onAction).toHaveBeenCalledWith({
      type: 'open-conversation',
      projectId: 'p-9',
      conversationId: 'c-1',
    })
  })
})
