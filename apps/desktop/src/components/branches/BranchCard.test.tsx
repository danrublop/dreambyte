// @vitest-environment jsdom

/**
 * B12 — BranchCard refactor pins:
 *  - fork and restore now go through the shared run() pipeline, so they bump
 *    the branch-list cache (onChanged) like every other mutation — the old
 *    bespoke .then/.catch chains skipped it;
 *  - rename/clone/fork use the card's inline name input instead of
 *    window.prompt (delete/restore use an inline confirm instead of
 *    window.confirm) — no window.* dialog is ever invoked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BranchCard from './BranchCard'
import type { BranchRecord } from '@/types/dreambyte-api'

const PROJECT_ID = 'p1'
const branches: BranchRecord[] = [
  { id: 'b-main', projectId: PROJECT_ID, name: 'main', isDefault: true, createdAt: 0, updatedAt: 0 } as never,
  { id: 'b-feat', projectId: PROJECT_ID, name: 'feature', isDefault: false, createdAt: 0, updatedAt: 0 } as never,
]

function setup(ipcOverrides: Record<string, unknown> = {}) {
  const ipc = {
    create: vi.fn().mockResolvedValue({}),
    rename: vi.fn().mockResolvedValue({}),
    setDefault: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    fork: vi.fn().mockResolvedValue({ projectId: 'forked-1' }),
    restoreToPoint: vi.fn().mockResolvedValue({}),
    history: vi.fn().mockResolvedValue({
      entries: [{ key: 'h1', batchId: 'h1', label: 'Edit', source: 'user', createdAt: new Date(), sceneCount: 1 }],
    }),
    ...ipcOverrides,
  }
  ;(window as never as Record<string, unknown>).dreambyteApi = { branches: ipc }
  const callbacks = {
    onSwitch: vi.fn(),
    onReload: vi.fn(),
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onOpenProject: vi.fn(),
  }
  render(<BranchCard projectId={PROJECT_ID} branches={branches} activeBranchId="b-main" {...callbacks} />)
  return { ipc, callbacks }
}

beforeEach(() => {
  // The refactor must NEVER fall back to window dialogs.
  vi.spyOn(window, 'prompt').mockImplementation(() => {
    throw new Error('window.prompt must not be called (B12)')
  })
  vi.spyOn(window, 'confirm').mockImplementation(() => {
    throw new Error('window.confirm must not be called (B12)')
  })
})

afterEach(() => {
  delete (window as never as Record<string, unknown>).dreambyteApi
  vi.restoreAllMocks()
})

function openRowMenu(branchName: string) {
  const row = screen.getByText(branchName).closest('button')!
  // The kebab is the role=button span inside the row.
  fireEvent.click(row.querySelector('[role="button"]')!)
}

describe('BranchCard (B12)', () => {
  it('rename flows through the inline input (no window.prompt) and refreshes the list', async () => {
    const { ipc, callbacks } = setup()
    openRowMenu('feature')
    fireEvent.click(screen.getByText('Rename…'))
    const input = screen.getByPlaceholderText('Branch name…') as HTMLInputElement
    expect(input.value).toBe('feature')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(ipc.rename).toHaveBeenCalledWith({ projectId: PROJECT_ID, id: 'b-feat', name: 'renamed' }),
    )
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
  })

  it('fork goes through run(): onChanged fires (the old bespoke chain skipped it) then navigation', async () => {
    const { ipc, callbacks } = setup()
    openRowMenu('feature')
    fireEvent.click(screen.getByText('Fork to new project…'))
    const input = screen.getByPlaceholderText('New project name…') as HTMLInputElement
    expect(input.value).toBe('feature (fork)')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(ipc.fork).toHaveBeenCalled())
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
    expect(callbacks.onClose).toHaveBeenCalled()
    expect(callbacks.onOpenProject).toHaveBeenCalledWith('forked-1')
  })

  it('delete uses an inline confirm (no window.confirm), only for deletable branches', async () => {
    const { ipc, callbacks } = setup()
    openRowMenu('feature')
    fireEvent.click(screen.getByText('Delete'))
    // Inline confirm row appears in place of the menu.
    fireEvent.click(screen.getByText('Delete', { selector: 'button' }))
    await waitFor(() => expect(ipc.delete).toHaveBeenCalledWith({ projectId: PROJECT_ID, id: 'b-feat' }))
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
  })

  it('restore confirms inline and goes through run(): onChanged + onReload + onClose', async () => {
    const { ipc, callbacks } = setup()
    fireEvent.click(screen.getByText('History'))
    await waitFor(() => expect(ipc.history).toHaveBeenCalled())
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.click(screen.getByText('Restore', { selector: 'button' }))
    await waitFor(() =>
      expect(ipc.restoreToPoint).toHaveBeenCalledWith({ projectId: PROJECT_ID, branchId: 'b-main', key: 'h1' }),
    )
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
    expect(callbacks.onReload).toHaveBeenCalled()
    expect(callbacks.onClose).toHaveBeenCalled()
  })

  it('the kebab toggles its menu CLOSED with a real mousedown→click sequence (review #162 race)', () => {
    setup()
    const row = screen.getByText('feature').closest('button')!
    const kebab = row.querySelector('[role="button"]')!
    // Open (real event order: mousedown, then click).
    fireEvent.mouseDown(kebab)
    fireEvent.click(kebab)
    expect(screen.getByText('Rename…')).toBeTruthy()
    // Close via the same kebab — the native mousedown must NOT pre-close the
    // menu and let the click re-open it (the masked close-then-reopen race).
    fireEvent.mouseDown(kebab)
    fireEvent.click(kebab)
    expect(screen.queryByText('Rename…')).toBeNull()
  })

  it('outside mousedown closes the menu; menu-internal clicks do not', () => {
    setup()
    openRowMenu('feature')
    expect(screen.getByText('Rename…')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Rename…')).toBeNull()
  })

  it('set as main goes through run() and refreshes the list', async () => {
    const { ipc, callbacks } = setup()
    openRowMenu('feature')
    fireEvent.click(screen.getByText('Set as main'))
    await waitFor(() => expect(ipc.setDefault).toHaveBeenCalledWith({ projectId: PROJECT_ID, id: 'b-feat' }))
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalled())
  })

  it('a failed mutation surfaces the error on the card (run pipeline)', async () => {
    setup({ rename: vi.fn().mockRejectedValue(new Error('UNIQUE-ish friendly message')) })
    openRowMenu('feature')
    fireEvent.click(screen.getByText('Rename…'))
    const input = screen.getByPlaceholderText('Branch name…')
    fireEvent.change(input, { target: { value: 'taken' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('UNIQUE-ish friendly message')).toBeTruthy()
  })
})
