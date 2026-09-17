import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * ChatScenePreview — component behavior + the D6 placement contract.
 *
 * Store is mocked HomeSidebar-test style (selector over a plain object) so the
 * test isolates the pane's follow/refresh/empty/error logic from the 6k-line
 * AgentChat world.
 */

let storeState: Record<string, unknown>

vi.mock('@/lib/store', () => ({
  useVideoStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))

import ChatScenePreview from './ChatScenePreview'

const SCENES = [
  { id: 'sc-1', name: 'Opening', duration: 6 },
  { id: 'sc-2', name: 'Chart', duration: 10 },
]

function baseState(over: Record<string, unknown> = {}) {
  return {
    scenes: SCENES,
    selectedSceneId: null,
    isGenerating: false,
    generatingSceneId: null,
    sceneHtmlVersion: 0,
    sceneWriteErrors: {},
    setProjectView: vi.fn(),
    selectScene: vi.fn(),
    project: { mp4Settings: { aspectRatio: '16:9', resolution: '1080p' } },
    ...over,
  }
}

beforeEach(() => {
  window.localStorage.clear() // collapsed state persists — isolate tests
  storeState = baseState()
})

afterEach(() => {
  vi.useRealTimers()
})

const iframe = () => document.querySelector('iframe')

describe('follow priority', () => {
  it('follows the newest scene when nothing is selected', () => {
    render(<ChatScenePreview />)
    expect(iframe()?.getAttribute('src')).toContain('sc-2')
    expect(screen.getByText('Chart')).toBeTruthy()
  })

  it('follows the selected scene when set', () => {
    storeState = baseState({ selectedSceneId: 'sc-1' })
    render(<ChatScenePreview />)
    expect(iframe()?.getAttribute('src')).toContain('sc-1')
  })

  it('follows the scene the agent is building during a run (outranks selection)', () => {
    storeState = baseState({ selectedSceneId: 'sc-1', isGenerating: true, generatingSceneId: 'sc-2' })
    render(<ChatScenePreview />)
    expect(iframe()?.getAttribute('src')).toContain('sc-2')
    expect(screen.getByText('building…')).toBeTruthy()
  })
})

describe('empty + error states (never a silent blank pane)', () => {
  it('renders the designed empty state with zero scenes', () => {
    storeState = baseState({ scenes: [] })
    render(<ChatScenePreview />)
    expect(iframe()).toBeNull()
    expect(screen.getByText(/No scenes yet/)).toBeTruthy()
  })

  it('renders the error state when the followed scene has a write error', () => {
    storeState = baseState({ sceneWriteErrors: { 'sc-2': 'SVG missing viewBox' } })
    render(<ChatScenePreview />)
    expect(iframe()).toBeNull()
    expect(screen.getByText('Scene failed to render')).toBeTruthy()
    expect(screen.getByText('SVG missing viewBox')).toBeTruthy()
  })
})

describe('resource policy (D7)', () => {
  it('collapse unmounts the iframe entirely — not display:none', () => {
    render(<ChatScenePreview />)
    expect(iframe()).not.toBeNull()
    fireEvent.click(screen.getByTitle('Hide preview'))
    expect(iframe()).toBeNull() // gone from the DOM, zero idle CPU
    fireEvent.click(screen.getByTitle('Show scene preview'))
    expect(iframe()).not.toBeNull()
  })

  it('debounces scene-HTML rewrites: one reload after writes settle, not per write', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ChatScenePreview />)
    const srcBefore = iframe()!.getAttribute('src')

    // Three rapid writes (agent mid-build) — each restarts the settle window.
    for (const v of [1, 2, 3]) {
      storeState = baseState({ sceneHtmlVersion: v })
      rerender(<ChatScenePreview />)
      act(() => void vi.advanceTimersByTime(300)) // < settle window
    }
    expect(iframe()!.getAttribute('src')).toBe(srcBefore) // no churn yet

    act(() => void vi.advanceTimersByTime(1000)) // writes settle
    const srcAfter = iframe()!.getAttribute('src')
    expect(srcAfter).not.toBe(srcBefore)
    expect(srcAfter).toContain('?v=1') // exactly ONE bump for three writes
  })

  it('iframe src always comes from sceneSrc() — the ?v cache-bust shape', () => {
    render(<ChatScenePreview />)
    // dev (non-dreambyte protocol) shape; the dreambyte:// branch is the same helper.
    expect(iframe()!.getAttribute('src')).toBe('/scenes/sc-2.html')
  })
})

describe('open in editor', () => {
  it('selects the followed scene and switches view', () => {
    render(<ChatScenePreview />)
    fireEvent.click(screen.getByTitle('Open in editor'))
    expect((storeState.selectScene as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('sc-2')
    expect((storeState.setProjectView as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('editor')
  })
})

/**
 * D6 placement contract — the pane must be a SIBLING of AgentChatHost in
 * AppShell, never inside the reparented AgentChat subtree (an iframe there
 * would reload on every chat⇄editor appendChild move). Mounting the real
 * AppShell/AgentChat in jsdom is impractical (6k-line component, IPC), so
 * this guards the structure at the source level: the pane is referenced by
 * AppShell and by NOTHING inside the reparented subtree.
 */
describe('D6 placement contract (structural)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8')

  it('AppShell mounts ChatScenePreview as a sibling of AgentChatHost', () => {
    const appShell = read('src/components/AppShell.tsx')
    expect(appShell).toContain('<ChatScenePreview')
    expect(appShell).toContain('<AgentChatHost')
  })

  it('nothing inside the reparented subtree mounts the pane', () => {
    for (const rel of ['src/components/AgentChat.tsx', 'src/components/chat/AgentChatHost.tsx']) {
      expect(read(rel)).not.toContain('ChatScenePreview')
    }
  })
})
