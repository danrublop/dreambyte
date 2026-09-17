import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// HomeSidebar reads the whole store via selectors and renders ProjectTreeItem,
// which lazy-loads conversations over IPC. Mock both so this test isolates the
// workspace FILTER + SWITCHER logic (the surface the Workspaces page added).
const setActiveWorkspace = vi.fn()
const fetchWorkspaces = vi.fn()
const openProject = vi.fn()

let storeState: Record<string, unknown>

vi.mock('@/lib/store', () => ({
  useVideoStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))

// Render each project row as its plain name so we can assert which are visible.
vi.mock('./ProjectTreeItem', () => ({
  default: ({ name }: { name: string }) => <div data-testid="project-row">{name}</div>,
}))

import HomeSidebar from './HomeSidebar'

function baseState(over: Record<string, unknown> = {}) {
  return {
    projectList: [
      { id: 'p-a', name: 'Alpha', workspaceId: 'ws-a' },
      { id: 'p-b', name: 'Beta', workspaceId: 'ws-b' },
      { id: 'p-none', name: 'Loose', workspaceId: null },
    ],
    activeProjectId: null,
    activeConversationId: null,
    appView: 'home',
    openProject,
    switchConversation: vi.fn(),
    goAppHome: vi.fn(),
    currentUser: { name: 'Dana', email: 'dana@test.dev' },
    workspaces: [
      { id: 'ws-a', name: 'Workspace A' },
      { id: 'ws-b', name: 'Workspace B' },
    ],
    activeWorkspaceId: null,
    setActiveWorkspace,
    fetchWorkspaces,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState = baseState()
})

describe('HomeSidebar workspace filter', () => {
  it('shows every project when no workspace is active', () => {
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={() => {}} />)
    const names = screen.getAllByTestId('project-row').map((n) => n.textContent)
    expect(names).toEqual(['Alpha', 'Beta', 'Loose'])
  })

  it('shows only the active workspace projects when one is selected', () => {
    storeState = baseState({ activeWorkspaceId: 'ws-a' })
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={() => {}} />)
    const names = screen.getAllByTestId('project-row').map((n) => n.textContent)
    expect(names).toEqual(['Alpha'])
  })

  it('fetches workspaces on mount', () => {
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={() => {}} />)
    expect(fetchWorkspaces).toHaveBeenCalled()
  })
})

describe('HomeSidebar workspace switcher', () => {
  it('labels the active workspace, falling back to "All workspaces"', () => {
    storeState = baseState({ activeWorkspaceId: 'ws-b' })
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={() => {}} />)
    expect(screen.getByText('Workspace B')).toBeInTheDocument()
  })

  it('selecting a workspace from the switcher sets it active', () => {
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={() => {}} />)
    // Open the switcher (its trigger shows the current label).
    fireEvent.click(screen.getByText('All workspaces'))
    // Pick Workspace A from the popover.
    fireEvent.click(screen.getByText('Workspace A'))
    expect(setActiveWorkspace).toHaveBeenCalledWith('ws-a')
  })

  it('"Manage workspaces…" opens the workspaces page', () => {
    const onOpenWorkspaces = vi.fn()
    render(<HomeSidebar onOpenSettings={() => {}} onOpenWorkspaces={onOpenWorkspaces} />)
    fireEvent.click(screen.getByText('All workspaces'))
    fireEvent.click(screen.getByText('Manage workspaces…'))
    expect(onOpenWorkspaces).toHaveBeenCalled()
  })
})
