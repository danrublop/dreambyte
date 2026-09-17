// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useVideoStore } from '../index'

/**
 * Top-level app-view state machine (AppShell routing) + the persist contract
 * that makes it survive a refresh.
 *
 * The machine is `appView: 'home'|'project'` × `projectView: 'chat'|'editor'`
 * × `activeProjectId`. It is persisted (partialize) so a reload resumes the
 * same view, and merge() must not let stripped-localStorage scenes clobber a
 * project freshly reloaded from the DB (the resume-on-refresh regression —
 * see src/app/page.tsx which waits for hydration before mounting AppShell).
 */

function resetView() {
  useVideoStore.setState({
    appView: 'home',
    projectView: 'chat',
    activeProjectId: null,
    contentView: 'none',
    settingsSection: 'general',
    sidebarCollapsed: false,
    // Stub the async side effects openProject fires so the synchronous view
    // transition is what we assert (loadProject hits IPC/DB, absent in tests).
    loadProject: vi.fn().mockResolvedValue(undefined),
    switchConversation: vi.fn().mockResolvedValue(undefined),
  } as never)
}

beforeEach(() => resetView())

describe('view transitions', () => {
  it('openProject enters the project at the chat view by default', () => {
    useVideoStore.getState().openProject('p1')
    const s = useVideoStore.getState()
    expect(s.appView).toBe('project')
    expect(s.projectView).toBe('chat')
    expect(s.activeProjectId).toBe('p1')
    expect(s.loadProject).toHaveBeenCalledWith('p1')
  })

  it('openProject honors an explicit editor view', () => {
    useVideoStore.getState().openProject('p1', 'editor')
    expect(useVideoStore.getState().projectView).toBe('editor')
  })

  it('openProject switches to the requested conversation AFTER the load settles', async () => {
    const switchConversation = vi.fn().mockResolvedValue(undefined)
    // loadProject must resolve before switchConversation runs (ordering is the
    // whole point: a non-active project must land on the exact clicked chat).
    let loadResolved = false
    const loadProject = vi.fn().mockImplementation(async () => {
      loadResolved = true
    })
    useVideoStore.setState({ loadProject, switchConversation } as never)

    useVideoStore.getState().openProject('p1', 'chat', 'c9')
    expect(switchConversation).not.toHaveBeenCalled() // not before load resolves

    await vi.waitFor(() => expect(switchConversation).toHaveBeenCalledWith('c9'))
    expect(loadResolved).toBe(true)
  })

  it('goAppHome returns home WITHOUT discarding the active project, resetting the pill to Chat', () => {
    useVideoStore.getState().openProject('p1', 'editor')
    useVideoStore.getState().goAppHome()
    const s = useVideoStore.getState()
    expect(s.appView).toBe('home')
    // The project id is preserved so re-opening resumes the same project...
    expect(s.activeProjectId).toBe('p1')
    // ...but home IS the chat composer — the Chat/Editor pill resets so the
    // visible view and the switcher can't disagree.
    expect(s.projectView).toBe('chat')
  })

  it('setProjectView(editor) with a project open just flips the view', () => {
    useVideoStore.setState({ appView: 'project', activeProjectId: 'p1' } as never)
    useVideoStore.getState().setProjectView('editor')
    const s = useVideoStore.getState()
    expect(s.projectView).toBe('editor')
    expect(s.activeProjectId).toBe('p1') // same project — no new project minted
  })

  it('setProjectView(editor) with NO project open mints a project and enters its editor', () => {
    // From the chat-first home: flipping the pill to Editor must OPEN an editor
    // (zero friction). Under the eager draft model the project is minted as a
    // real DB row with status='draft'; the startup sweep soft-hides it if it
    // stays untouched, so the entry is still friction-free.
    // createNewProject's async persistence side effects are stubbed below.
    useVideoStore.setState({
      projectList: [],
      saveProjectToDb: vi.fn().mockResolvedValue(undefined),
      fetchProjectList: vi.fn().mockResolvedValue(undefined),
      newConversation: vi.fn().mockResolvedValue('c1'),
    } as never)
    useVideoStore.getState().setProjectView('editor')
    const s = useVideoStore.getState()
    expect(s.projectView).toBe('editor')
    expect(s.appView).toBe('project')
    expect(s.activeProjectId).toBe(s.project.id)
    expect(s.activeProjectId).not.toBeNull()
  })

  it('setProjectView(chat) sets exactly its own field', () => {
    useVideoStore.getState().setProjectView('chat')
    expect(useVideoStore.getState().projectView).toBe('chat')
    expect(useVideoStore.getState().appView).toBe('home') // untouched
    useVideoStore.getState().setAppView('project')
    expect(useVideoStore.getState().appView).toBe('project')
  })
})

describe('content overlay (Settings/Customize/Library/Workspaces)', () => {
  it('setContentView is the single mutually-exclusive switch', () => {
    useVideoStore.getState().setContentView('settings')
    expect(useVideoStore.getState().contentView).toBe('settings')
    // Opening another overlay replaces the first — no second overlay can coexist.
    useVideoStore.getState().setContentView('library')
    expect(useVideoStore.getState().contentView).toBe('library')
    useVideoStore.getState().setContentView('none')
    expect(useVideoStore.getState().contentView).toBe('none')
  })

  it('setSettingsSection / setSidebarCollapsed set exactly their own field', () => {
    useVideoStore.getState().setSettingsSection('models')
    expect(useVideoStore.getState().settingsSection).toBe('models')
    expect(useVideoStore.getState().contentView).toBe('none') // untouched
    useVideoStore.getState().setSidebarCollapsed(true)
    expect(useVideoStore.getState().sidebarCollapsed).toBe(true)
  })
})

describe('createNewProject view contract (resume + Bug: new video kept its view)', () => {
  function stubCreateDeps() {
    useVideoStore.setState({
      projectList: [],
      saveProjectToDb: vi.fn().mockResolvedValue(undefined),
      fetchProjectList: vi.fn().mockResolvedValue(undefined),
      newConversation: vi.fn().mockResolvedValue('c1'),
    } as never)
  }

  it('enters the new project, preserves the editor view, and closes any overlay', async () => {
    useVideoStore.setState({ appView: 'project', projectView: 'editor', contentView: 'settings' } as never)
    stubCreateDeps()

    await useVideoStore.getState().createNewProject('My Video')

    const s = useVideoStore.getState()
    expect(s.appView).toBe('project')
    expect(s.projectView).toBe('editor') // preserved — does NOT bounce to chat
    expect(s.contentView).toBe('none') // overlay closed so the new project shows
    expect(s.activeProjectId).toBe(s.project.id) // active id tracks the new project
    expect(s.activeProjectId).not.toBeNull()
  })

  it('from chat, a new project stays in chat', async () => {
    useVideoStore.setState({ appView: 'project', projectView: 'chat' } as never)
    stubCreateDeps()

    await useVideoStore.getState().createNewProject('Another')

    expect(useVideoStore.getState().projectView).toBe('chat')
  })

  it('eager draft model: { draft: true } still persists a real project (row + conversation + list refresh)', async () => {
    // Eager draft model (D7/D17) supersedes the old lazy in-memory draft: even
    // the editor-pill `{ draft: true }` mint creates a real DB row immediately.
    // With no Electron IPC bridge in tests, createNewProject falls back to
    // saveProjectToDb, then refreshes the list and seeds the first conversation
    // — none of which the old lazy draft did.
    stubCreateDeps()

    await useVideoStore.getState().createNewProject(undefined, undefined, { draft: true })

    const s = useVideoStore.getState()
    expect(s.appView).toBe('project')
    expect(s.activeProjectId).toBe(s.project.id)
    expect(s.activeProjectId).not.toBeNull()
    // The project is persisted at creation (IPC-less fallback path here).
    expect(s.saveProjectToDb).toHaveBeenCalled()
    expect(s.fetchProjectList).toHaveBeenCalled()
    expect(s.newConversation).toHaveBeenCalled()
  })

  it('both draft and non-draft creates mint a real, persisted project', async () => {
    // Under the eager model there is no in-memory-only mode and no flag to
    // clear — every create persists. We assert the project id tracks each new
    // project and persistence side effects fire both times.
    stubCreateDeps()
    await useVideoStore.getState().createNewProject(undefined, undefined, { draft: true })
    const draftId = useVideoStore.getState().project.id
    expect(useVideoStore.getState().activeProjectId).toBe(draftId)

    await useVideoStore.getState().createNewProject('Real one')
    const realId = useVideoStore.getState().project.id
    expect(useVideoStore.getState().activeProjectId).toBe(realId)
    expect(realId).not.toBe(draftId)
    expect(useVideoStore.getState().project.name).toBe('Real one')
  })
})

describe('persist contract (resume-on-refresh)', () => {
  const opts = useVideoStore.persist.getOptions()

  it('partialize persists the view fields and strips heavy scene code', () => {
    const full = {
      ...useVideoStore.getState(),
      appView: 'project',
      projectView: 'editor',
      activeProjectId: 'p1',
      contentView: 'settings',
      settingsSection: 'models',
      sidebarCollapsed: true,
      scenes: [{ id: 's1', sceneCode: 'huge code', reactCode: 'more', sceneHTML: '<div/>' }],
    }
    const snap = opts.partialize!(full as never) as Record<string, unknown>
    expect(snap.appView).toBe('project')
    expect(snap.projectView).toBe('editor')
    expect(snap.activeProjectId).toBe('p1')
    // Settings/overlay + sidebar state persist so a refresh resumes the same panel.
    expect(snap.contentView).toBe('settings')
    expect(snap.settingsSection).toBe('models')
    expect(snap.sidebarCollapsed).toBe(true)
    const persistedScene = (snap.scenes as Array<Record<string, string>>)[0]
    expect(persistedScene.sceneCode).toBe('')
    expect(persistedScene.reactCode).toBe('')
    expect(persistedScene.sceneHTML).toBe('')
    expect(persistedScene.id).toBe('s1') // identity kept; code reloaded from DB
  })

  it('merge resumes the persisted view but keeps freshly DB-loaded scenes', () => {
    // localStorage (persisted) has the view + stripped scenes (no code).
    const persisted = {
      appView: 'project',
      projectView: 'editor',
      activeProjectId: 'p1',
      scenes: [{ id: 's1', sceneCode: '', reactCode: '', sceneHTML: '' }],
    }
    // In-memory (current) was just filled by loadProject from the DB.
    const current = {
      ...useVideoStore.getState(),
      appView: 'home',
      scenes: [{ id: 's1', sceneCode: 'real code from db' }],
      _lastDbLoadTimestamp: Date.now(),
    }
    const merged = opts.merge!(persisted as never, current as never) as unknown as Record<string, unknown>
    // View resumes from persisted state...
    expect(merged.appView).toBe('project')
    expect(merged.projectView).toBe('editor')
    expect(merged.activeProjectId).toBe('p1')
    // ...but the rich DB scenes win over the stripped localStorage ones.
    const scenes = merged.scenes as Array<Record<string, string>>
    expect(scenes[0].sceneCode).toBe('real code from db')
  })
})
