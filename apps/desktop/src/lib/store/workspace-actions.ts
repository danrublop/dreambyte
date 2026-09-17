import type { StoreApi } from 'zustand'
import type { VideoStore } from './types'
import type { Workspace, WorkspaceListItem } from '../types'
import { createLogger } from '../logger'

const log = createLogger('store.workspace')

type Set = StoreApi<VideoStore>['setState']
type Get = () => VideoStore

function requireWorkspacesIpc() {
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.workspaces : undefined
  if (!ipc) throw new Error('workspaces require the desktop runtime (window.dreambyteApi.workspaces unavailable).')
  return ipc
}

function requireProjectsIpc() {
  const ipc = typeof window !== 'undefined' ? window.dreambyteApi?.projects : undefined
  if (!ipc) throw new Error('projects require the desktop runtime (window.dreambyteApi.projects unavailable).')
  return ipc
}

export function createWorkspaceActions(set: Set, get: Get) {
  return {
    fetchWorkspaces: async () => {
      set({ isLoadingWorkspaces: true })
      try {
        const list = await requireWorkspacesIpc().list()
        if (list) set({ workspaces: list as unknown as WorkspaceListItem[] })
      } catch (e) {
        log.error('failed to fetch workspaces', { error: e })
      } finally {
        set({ isLoadingWorkspaces: false })
      }
    },

    createWorkspace: async (name: string, opts?: { color?: string; icon?: string }): Promise<string> => {
      const workspace = await requireWorkspacesIpc().create({ name, color: opts?.color, icon: opts?.icon })
      await get().fetchWorkspaces()
      return (workspace as { id: string }).id
    },

    updateWorkspace: async (id: string, updates: Partial<Workspace>) => {
      await requireWorkspacesIpc().update({ workspaceId: id, updates: updates as Record<string, unknown> })
      await get().fetchWorkspaces()
    },

    deleteWorkspace: async (id: string) => {
      await requireWorkspacesIpc().delete(id)
      if (get().activeWorkspaceId === id) {
        set({ activeWorkspaceId: null })
      }
      await get().fetchWorkspaces()
      await get().fetchProjectList()
    },

    setActiveWorkspace: (id: string | null) => {
      set({ activeWorkspaceId: id })
    },

    moveProjectToWorkspace: async (projectId: string, workspaceId: string | null) => {
      await requireProjectsIpc().update({ projectId, updates: { workspaceId } })
      set((state) => ({
        projectList: state.projectList.map((p) => (p.id === projectId ? { ...p, workspaceId } : p)),
      }))
      await get().fetchWorkspaces()
    },
  }
}
