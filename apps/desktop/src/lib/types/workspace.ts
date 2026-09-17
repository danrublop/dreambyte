import type { BrandKit } from './media'
import type { GlobalStyle } from './project'

export interface Workspace {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  brandKit: BrandKit | null
  globalStyle: GlobalStyle | null
  settings: Record<string, unknown>
  isDefault: boolean
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkspaceListItem {
  id: string
  name: string
  color: string | null
  icon: string | null
  isDefault: boolean
  projectCount: number
  updatedAt: string
}
