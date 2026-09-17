'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { X } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import type { Scene } from '@/lib/types'
import {
  registerAgentChatSlot,
  releaseAgentChatSlot,
  registerOpenSceneCodeEditor,
  releaseOpenSceneCodeEditor,
} from '../chat/agent-chat-slot'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface Props {
  scene?: Scene | null
}

export default function PromptTab({ scene }: Props) {
  const { updateScene, saveSceneHTML } = useVideoStore()
  const [showCodeEditor, setShowCodeEditor] = useState(false)
  const slotElRef = useRef<HTMLDivElement | null>(null)

  // Element-keyed slot registration — release only OUR element so a stale
  // unmount (StrictMode double-mount, view cross-fade) can't clobber a newer
  // PromptTab instance's registration.
  const slotRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      slotElRef.current = el
      registerAgentChatSlot(el)
    } else if (slotElRef.current) {
      releaseAgentChatSlot(slotElRef.current)
      slotElRef.current = null
    }
  }, [])

  const isSVG = scene?.sceneType === 'svg'
  const isCanvas = scene?.sceneType === 'canvas2d'

  const handleCodeEdit = useCallback(
    (value: string | undefined) => {
      if (!scene) return
      if (isSVG) updateScene(scene.id, { svgContent: value ?? '' })
      else if (isCanvas) updateScene(scene.id, { canvasCode: value ?? '' })
      else updateScene(scene.id, { sceneCode: value ?? '' })
    },
    [scene?.id, isSVG, isCanvas, updateScene],
  )

  const handleCodeEditorSave = useCallback(async () => {
    if (!scene) return
    await saveSceneHTML(scene.id)
    setShowCodeEditor(false)
  }, [scene?.id, saveSceneHTML])

  const editorLanguage = isSVG ? 'xml' : 'javascript'
  const editorValue = scene ? (isSVG ? scene.svgContent : isCanvas ? scene.canvasCode : scene.sceneCode) : ''

  // The chat itself is the single persistent AgentChat owned by AgentChatHost
  // (AppShell) — it reparents into the slot div below so an in-flight stream
  // survives Chat ⇄ Editor switches. This tab only registers the slot and how
  // to open the scene-code modal.
  useEffect(() => {
    // Capture the exact fn we register so cleanup releases THIS one. A bare
    // registerOpenSceneCodeEditor(null) on unmount could null out a newer
    // tab's registration during a StrictMode double-mount / view cross-fade;
    // releaseOpenSceneCodeEditor only clears when the departing fn is current.
    const fn = scene ? () => setShowCodeEditor(true) : null
    registerOpenSceneCodeEditor(fn)
    return () => {
      if (fn) releaseOpenSceneCodeEditor(fn)
    }
  }, [scene?.id])

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] overflow-hidden">
      {/* Main Agent Chat Interface — filled by AgentChatHost via reparenting */}
      <div className="flex-1 overflow-hidden [&>*]:h-full" ref={slotRef} />

      {/* Code Editor Modal */}
      {showCodeEditor && scene && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-4xl h-[80vh] bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <span className="text-[var(--color-text-primary)] text-sm font-medium">
                {isSVG ? 'Edit SVG' : isCanvas ? 'Edit Canvas Code' : `Edit ${scene.sceneType} Code`}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={handleCodeEditorSave}
                  className="kbd h-8 px-3 bg-[#e84545] border-[#e84545] shadow-[#800] text-white"
                >
                  <span className="text-[11px] uppercase tracking-wider">Save & Close</span>
                </button>
                <button
                  onClick={() => setShowCodeEditor(false)}
                  className="kbd h-8 w-8 p-0 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <MonacoEditor
                defaultLanguage={editorLanguage}
                value={editorValue}
                onChange={handleCodeEdit}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
