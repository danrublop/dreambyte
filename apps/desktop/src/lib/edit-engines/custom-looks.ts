'use client'

/**
 * User-saved Looks (grading presets) — the "save as Look" / Looks-library
 * half of a typical NLE grading workflow. A custom Look snapshots the WHOLE
 * grade (preset CSS + correction stack incl. wheels/curves/vignette/sharpen)
 * under a name, persisted in localStorage so it's available across projects.
 */

import type { LayerColorGrade } from './layer-grade'

export interface CustomLook {
  id: string
  name: string
  lookCss?: string
  grade?: LayerColorGrade
  createdAt: number
}

const STORAGE_KEY = 'dreambyte.customLooks.v1'

export function listCustomLooks(): CustomLook[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CustomLook[]) : []
  } catch {
    return []
  }
}

function persist(looks: CustomLook[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(looks))
  } catch {
    /* quota/private mode — looks just don't persist */
  }
}

/** Save (or overwrite by name) and return the updated list. */
export function saveCustomLook(name: string, snapshot: { lookCss?: string; grade?: LayerColorGrade }): CustomLook[] {
  const trimmed = name.trim()
  if (!trimmed) return listCustomLooks()
  const looks = listCustomLooks().filter((l) => l.name !== trimmed)
  looks.push({
    id: `look-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: trimmed,
    lookCss: snapshot.lookCss,
    grade: snapshot.grade,
    createdAt: Date.now(),
  })
  persist(looks)
  return looks
}

export function deleteCustomLook(id: string): CustomLook[] {
  const looks = listCustomLooks().filter((l) => l.id !== id)
  persist(looks)
  return looks
}
