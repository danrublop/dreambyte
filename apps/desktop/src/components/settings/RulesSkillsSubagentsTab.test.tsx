// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let storeState: Record<string, unknown>
vi.mock('@/lib/store', () => ({
  useVideoStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))

import RulesSkillsSubagentsTab from './RulesSkillsSubagentsTab'

const rulesApi = { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() }
const skillsApi = { list: vi.fn(), search: vi.fn(), readFile: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  storeState = { activeProjectId: 'p1', projectList: [{ id: 'p1', name: 'My Project' }] }
  rulesApi.list.mockResolvedValue({ rules: [] })
  skillsApi.list.mockResolvedValue({ skills: [], count: 0 })
  ;(window as unknown as { dreambyteApi: unknown }).dreambyteApi = { rules: rulesApi, skills: skillsApi }
})
afterEach(() => {
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
})

describe('RulesSkillsSubagentsTab', () => {
  it('renders all four sections', async () => {
    render(<RulesSkillsSubagentsTab />)
    expect(screen.getByText('Rules')).toBeTruthy()
    expect(screen.getByText('Skills')).toBeTruthy()
    expect(screen.getByText('Subagents')).toBeTruthy()
    expect(screen.getByText('Commands')).toBeTruthy()
    await waitFor(() => expect(rulesApi.list).toHaveBeenCalled())
  })

  it('shows User + active project scope tabs and refetches on switch', async () => {
    render(<RulesSkillsSubagentsTab />)
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('My Project')).toBeTruthy()
    await waitFor(() => expect(rulesApi.list).toHaveBeenCalledWith({ scope: 'user', projectId: null }))

    fireEvent.click(screen.getByText('My Project'))
    await waitFor(() => expect(rulesApi.list).toHaveBeenCalledWith({ scope: 'project', projectId: 'p1' }))
  })

  it('lists rules returned by the IPC', async () => {
    rulesApi.list.mockResolvedValue({
      rules: [
        {
          id: 'r1',
          scope: 'user',
          projectId: null,
          name: 'Coding standards',
          body: 'Use tabs',
          applyMode: 'always',
          globPattern: null,
          enabled: true,
          sortOrder: 0,
          createdAt: '',
          updatedAt: '',
        },
      ],
    })
    render(<RulesSkillsSubagentsTab />)
    await waitFor(() => expect(screen.getByText('Coding standards')).toBeTruthy())
  })

  it('lists skills from the registry IPC', async () => {
    skillsApi.list.mockResolvedValue({
      skills: [
        { id: 'dreambyte', name: 'dreambyte', description: 'Generate scenes', category: 'media', source: 'dreambyte' },
      ],
      count: 1,
    })
    render(<RulesSkillsSubagentsTab />)
    await waitFor(() => expect(screen.getByText('Generate scenes')).toBeTruthy())
  })

  it('creates a rule through the editor', async () => {
    rulesApi.create.mockResolvedValue({ rule: { id: 'new' } })
    render(<RulesSkillsSubagentsTab />)
    await waitFor(() => expect(rulesApi.list).toHaveBeenCalled())

    fireEvent.click(screen.getByText('New'))
    fireEvent.change(screen.getByPlaceholderText(/Rule name/i), { target: { value: 'No emojis' } })
    fireEvent.change(screen.getByPlaceholderText(/Guidance for the agent/i), { target: { value: 'Never use emojis.' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() =>
      expect(rulesApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'user',
          projectId: null,
          name: 'No emojis',
          body: 'Never use emojis.',
          applyMode: 'always',
        }),
      ),
    )
  })
})
