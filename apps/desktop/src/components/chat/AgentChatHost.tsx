'use client'

import { useLayoutEffect, useRef } from 'react'
import { useVideoStore } from '@/lib/store'
import AgentChat from '../AgentChat'
import { useAgentChatSlot, getOpenSceneCodeEditor } from './agent-chat-slot'

interface Props {
  /** Whether the Chat view surface is the visible one (projectView==='chat'
   *  and no settings/library/workspaces overlay is covering the main area). */
  visible: boolean
}

/**
 * Single persistent AgentChat instance shared by the Chat view and the editor's
 * Agent panel. The chat DOM is REPARENTED (raw appendChild) into the editor's
 * slot instead of conditionally rendering a second instance, so an in-flight
 * agent SSE stream — and its live streaming UI — survives Chat ⇄ Editor
 * switches in both directions, plus the editor's right panel closing and the
 * settings/library overlays. Same motivation as the keep-mounted note in
 * SceneEditor (PromptTab stays CSS-hidden so AgentChat doesn't unmount).
 *
 * Reparenting invariant: React only ever removes this component's top-level
 * `homeRef` div, so the movable node must be back inside it before any React
 * mutation that could drop it — the layout-effect cleanup restores it.
 */
/** appendChild resets scroll positions inside the moved subtree — capture and
 *  restore them so the message list doesn't jump to top on every view switch.
 *  Bounded walk (#124 post-merge review): a 500+ message transcript makes the
 *  naive every-descendant scan O(n) per view switch; in practice the chat has
 *  a handful of scrollers (message list, code blocks near the viewport), so
 *  cap both the nodes visited and the scrollers captured. Worst case past the
 *  caps: a deep scroller below the fold rests at top after a switch — benign
 *  next to per-switch jank. */
const REPARENT_MAX_VISITED = 2000
const REPARENT_MAX_SCROLLERS = 8
function reparentPreservingScroll(node: HTMLElement, target: HTMLElement) {
  const scrolled: Array<[Element, number, number]> = []
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT)
  let visited = 0
  while (walker.nextNode() && visited < REPARENT_MAX_VISITED && scrolled.length < REPARENT_MAX_SCROLLERS) {
    visited++
    const el = walker.currentNode as Element
    if (el.scrollTop > 0 || el.scrollLeft > 0) scrolled.push([el, el.scrollTop, el.scrollLeft])
  }
  target.appendChild(node)
  for (const [el, top, left] of scrolled) {
    el.scrollTop = top
    el.scrollLeft = left
  }
}

export default function AgentChatHost({ visible }: Props) {
  const projectView = useVideoStore((s) => s.projectView)
  const setProjectView = useVideoStore((s) => s.setProjectView)
  // Narrow selector: returns undefined in Chat view and a stable scene object
  // in Editor view, so unrelated scene-array churn (agent streaming, thumbnail
  // updates) doesn't re-render the permanently-mounted AgentChat subtree.
  const selectedScene = useVideoStore((s) =>
    s.projectView === 'editor' ? s.scenes.find((sc) => sc.id === s.selectedSceneId) : undefined,
  )
  const slot = useAgentChatSlot()
  const homeRef = useRef<HTMLDivElement>(null)
  const movableRef = useRef<HTMLDivElement>(null)

  const chatViewActive = projectView === 'chat'

  useLayoutEffect(() => {
    const node = movableRef.current
    const home = homeRef.current
    if (!node || !home) return
    // `slot.isConnected` guard (#124 post-merge review): if the slot's DOM
    // was already detached (its owner unmounted before this effect re-ran),
    // appending into it would leave the chat node out of the document for
    // the window until the next slot change. Treat a disconnected slot as
    // "no slot" and bring the node home instead.
    if (!chatViewActive && slot && slot.isConnected) {
      reparentPreservingScroll(node, slot)
    } else if (node.parentElement !== home) {
      reparentPreservingScroll(node, home)
    }
    return () => {
      // Restore React's expected structure before the next commit mutation
      // (slot unmount, view flip, or host unmount).
      if (node.parentElement !== home && home) reparentPreservingScroll(node, home)
    }
  }, [chatViewActive, slot])

  return (
    <div ref={homeRef} className={`flex-1 overflow-hidden ${visible && chatViewActive ? '' : 'hidden'}`}>
      <div ref={movableRef} className="h-full">
        <AgentChat
          scene={selectedScene}
          onOpenEditor={() => {
            // Context-dependent: in Chat view the affordance jumps to the
            // editor; in the editor panel it opens PromptTab's code modal.
            if (useVideoStore.getState().projectView === 'chat') setProjectView('editor')
            else getOpenSceneCodeEditor()?.()
          }}
        />
      </div>
    </div>
  )
}
