'use client'

import { useCallback, useRef } from 'react'
import { useVideoStore } from '@/lib/store'

export function useLayerCommit(sceneId: string) {
  const saveSceneHTML = useVideoStore((s) => s.saveSceneHTML)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commit = useCallback(async () => {
    await saveSceneHTML(sceneId)
  }, [sceneId, saveSceneHTML])

  const commitDebounced = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => saveSceneHTML(sceneId), 150)
  }, [sceneId, saveSceneHTML])

  return { commit, commitDebounced }
}
