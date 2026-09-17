'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Search, ChevronRight, ChevronDown, FileCode2, Film, Braces, Palette } from 'lucide-react'
import { useVideoStore } from '@/lib/store'
import { pickSceneCodeField } from '@/lib/code-text-slots'
import type { Scene } from '@/lib/types'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

type SceneCodeField = 'reactCode' | 'sceneCode' | 'canvasCode' | 'svgContent' | 'sceneHTML' | 'sceneStyles'

interface CodeSlot {
  key: string
  sceneId: string
  label: string
  language: string
  kind: 'scene' | 'css'
  field: SceneCodeField
}

/** The field that holds a scene's primary code, with a sensible default for an
 *  empty scene so there's always a slot to write into. */
function primarySceneField(scene: Scene): SceneCodeField {
  const picked = pickSceneCodeField(scene)
  if (picked) return picked
  switch (scene.sceneType) {
    case 'react':
      return 'reactCode'
    case 'svg':
    case 'lottie':
      return 'svgContent'
    case 'canvas2d':
      return 'canvasCode'
    default:
      return 'sceneCode'
  }
}

function langForField(field: SceneCodeField): string {
  switch (field) {
    case 'reactCode':
      return 'typescript'
    case 'svgContent':
      return 'xml'
    case 'sceneStyles':
      return 'css'
    case 'sceneHTML':
      return 'html'
    default:
      return 'javascript'
  }
}

function fieldLabel(field: SceneCodeField): string {
  switch (field) {
    case 'reactCode':
      return 'Component (JSX)'
    case 'svgContent':
      return 'SVG'
    case 'canvasCode':
      return 'Canvas (JS)'
    case 'sceneHTML':
      return 'HTML'
    case 'sceneStyles':
      return 'Styles (CSS)'
    default:
      return 'Scene code (JS)'
  }
}

/** Build the editable code slots for a single scene. */
function slotsForScene(scene: Scene): CodeSlot[] {
  const out: CodeSlot[] = []
  const field = primarySceneField(scene)
  out.push({
    key: `scene:${scene.id}`,
    sceneId: scene.id,
    label: fieldLabel(field),
    language: langForField(field),
    kind: 'scene',
    field,
  })
  // CSS is composed into every scene via the template, so always offer it.
  out.push({
    key: `scenecss:${scene.id}`,
    sceneId: scene.id,
    label: 'Styles (CSS)',
    language: 'css',
    kind: 'css',
    field: 'sceneStyles',
  })
  return out
}

function slotIcon(slot: CodeSlot) {
  if (slot.kind === 'css') return <Palette size={12} className="shrink-0 text-[#4a90d9]" />
  if (slot.language === 'typescript') return <Braces size={12} className="shrink-0 text-[#e8a849]" />
  return <FileCode2 size={12} className="shrink-0 text-[var(--color-text-muted)]" />
}

export default function CodeEditorTab() {
  const scenes = useVideoStore((s) => s.scenes)
  const selectedSceneId = useVideoStore((s) => s.selectedSceneId)
  const updateScene = useVideoStore((s) => s.updateScene)
  const saveSceneHTML = useVideoStore((s) => s.saveSceneHTML)
  const focusKey = useVideoStore((s) => s.codeEditorFocusKey)

  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Whole-project tree: every scene and its code slots.
  const tree = useMemo(
    () =>
      scenes.map((scene, i) => ({
        scene,
        title: scene.name?.trim() || `Scene ${i + 1}`,
        slots: slotsForScene(scene),
      })),
    [scenes],
  )

  const allSlots = useMemo(() => tree.flatMap((t) => t.slots), [tree])

  // Honour a focus request from the "Edit code" action; fall back to the first
  // slot of the active (or first) scene so the editor is never blank.
  useEffect(() => {
    if (focusKey && allSlots.some((s) => s.key === focusKey)) {
      setSelectedKey(focusKey)
      return
    }
    setSelectedKey((prev) => {
      if (prev && allSlots.some((s) => s.key === prev)) return prev
      const active = tree.find((t) => t.scene.id === selectedSceneId) ?? tree[0]
      return active?.slots[0]?.key ?? null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, allSlots, selectedSceneId])

  const selected = useMemo(() => allSlots.find((s) => s.key === selectedKey) ?? null, [allSlots, selectedKey])

  const value = useMemo(() => {
    if (!selected) return ''
    const scene = scenes.find((s) => s.id === selected.sceneId)
    if (!scene) return ''
    return (scene[selected.field as keyof Scene] as string | undefined) ?? ''
  }, [selected, scenes])

  const handleChange = useCallback(
    (next: string | undefined) => {
      if (!selected) return
      updateScene(selected.sceneId, { [selected.field]: next ?? '' })
      // Debounced regen so the live preview reflects edits without thrashing.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const sceneId = selected.sceneId
      saveTimerRef.current = setTimeout(() => saveSceneHTML(sceneId), 800)
    },
    [selected, updateScene, saveSceneHTML],
  )

  const q = query.trim().toLowerCase()
  const filteredTree = useMemo(() => {
    if (!q) return tree
    return tree
      .map((t) => {
        const sceneMatch = t.title.toLowerCase().includes(q)
        const slots = sceneMatch ? t.slots : t.slots.filter((s) => s.label.toLowerCase().includes(q))
        return { ...t, slots }
      })
      .filter((t) => t.slots.length > 0)
  }, [tree, q])

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--color-bg)]">
      {/* ── Navigator ─────────────────────────────────────────────── */}
      <div className="flex w-[260px] min-w-[200px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-2.5 py-2">
          <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {filteredTree.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--color-text-muted)]">No matching files.</p>
          ) : (
            filteredTree.map(({ scene, title, slots }) => {
              const isCollapsed = !q && collapsed[scene.id]
              return (
                <div key={scene.id} className="select-none">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [scene.id]: !c[scene.id] }))}
                    className="no-style flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-medium text-[var(--color-text-primary)] hover:bg-[var(--agent-chat-user-surface)]"
                    title={title}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    ) : (
                      <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    )}
                    <Film size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                    <span className="truncate">{title}</span>
                  </button>
                  {!isCollapsed &&
                    slots.map((slot) => {
                      const active = slot.key === selectedKey
                      return (
                        <button
                          key={slot.key}
                          type="button"
                          onClick={() => setSelectedKey(slot.key)}
                          className={`no-style flex w-full items-center gap-1.5 py-1 pl-7 pr-2 text-left text-[11.5px] transition-colors ${
                            active
                              ? 'bg-[var(--agent-chat-user-surface)] text-[var(--color-text-primary)]'
                              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
                          }`}
                          title={slot.label}
                        >
                          {slotIcon(slot)}
                          <span className="truncate">{slot.label}</span>
                        </button>
                      )
                    })}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Editor ────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5">
              <span className="truncate text-[12px] text-[var(--color-text-primary)]">
                {tree.find((t) => t.scene.id === selected.sceneId)?.title}
                <span className="text-[var(--color-text-muted)]"> / {selected.label}</span>
              </span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                {selected.language}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <MonacoEditor
                path={selected.key}
                language={selected.language}
                value={value}
                onChange={handleChange}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  renderWhitespace: 'none',
                  folding: true,
                  automaticLayout: true,
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--color-text-muted)]">
            Select a file from the list, or add a scene to start editing code.
          </div>
        )}
      </div>
    </div>
  )
}
