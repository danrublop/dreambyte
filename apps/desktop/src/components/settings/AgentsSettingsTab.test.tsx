// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let storeState: Record<string, unknown>
// zustand hooks take BOTH forms: useVideoStore(selector) and bare useVideoStore()
// for the whole state. KeyInputRow (shared.tsx) uses the bare form, so a
// selector-only mock threw "selector is not a function" on every render — which
// also poisoned unrelated files sharing the run.
vi.mock('@/lib/store', () => ({
  useVideoStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(storeState) : storeState,
}))

import AgentsSettingsTab from './AgentsSettingsTab'

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    thinkingMode: 'adaptive',
    setThinkingMode: vi.fn(),
    localMode: false,
    setLocalMode: vi.fn(),
    // ExternalCliSection reads modelConfigs if it renders; not needed since the
    // section hides itself when window.dreambyteApi.agents is absent (below).
    modelConfigs: [],
    setModelConfigs: vi.fn(),
    // KeyInputRow (searxng + tavily rows in the research section) reads these off
    // the bare store and calls .find on providerConfigs.
    providerConfigs: [],
    updateProviderConfig: vi.fn(),
  }
  // No dreambyteApi.agents → ExternalCliSection renders nothing (web-build guard).
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
})
afterEach(() => {
  delete (window as unknown as { dreambyteApi?: unknown }).dreambyteApi
})

describe('AgentsSettingsTab — single-agent panel', () => {
  it('shows the single Master Builder agent, not a persona grid', () => {
    render(<AgentsSettingsTab />)
    expect(screen.getByText('Master Builder')).toBeTruthy()
    // The old persona grid + create flow must be gone.
    expect(screen.queryByText('Create')).toBeNull()
    expect(screen.queryByText('Director')).toBeNull()
    expect(screen.queryByText('Tutor')).toBeNull()
  })

  it('renders the live run-config controls (thinking + local mode)', () => {
    render(<AgentsSettingsTab />)
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.getByText('Deep')).toBeTruthy()
    expect(screen.getByText('Local mode')).toBeTruthy()
  })

  it('points specialization at Skills & Rules', () => {
    render(<AgentsSettingsTab />)
    expect(screen.getByText(/Skills & Rules/i)).toBeTruthy()
  })
})
