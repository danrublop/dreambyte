// Interaction overlay rendering + event handling

import type { InteractionElement, PublishedScene, PlayerOptions } from './types'
import type { VariableStore } from './variables'
import { renderHotspot } from './ui/hotspot'
import { renderChoice } from './ui/choice'
import { renderQuiz } from './ui/quiz'
import { renderGate } from './ui/gate'
import { renderTooltip } from './ui/tooltip'
import { renderForm } from './ui/form'

export type InteractionCallback = (
  type: string,
  elementId: string,
  payload: { sceneId?: string; correct?: boolean; selectedId?: string; variables?: Record<string, string> },
) => void

export class InteractionOverlay {
  private overlay: HTMLElement
  private elements: Map<string, HTMLElement> = new Map()
  private gateActive: boolean = false
  private onFired: InteractionCallback
  private variables: VariableStore
  private brandColor: string
  private rafId: number = 0
  private currentTime: number = 0
  private paused: boolean = false

  constructor(parent: HTMLElement, variables: VariableStore, brandColor: string, onFired: InteractionCallback) {
    this.variables = variables
    this.brandColor = brandColor
    this.onFired = onFired

    this.overlay = document.createElement('div')
    this.overlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 1920px; height: 1080px;
      pointer-events: none; z-index: 100;
      isolation: isolate;
    `
    parent.appendChild(this.overlay)
  }

  loadScene(scene: PublishedScene): void {
    this.clear()
    this.gateActive = false
    this.currentTime = 0

    scene.interactions.forEach((el) => {
      const node = this.createElementNode(el)
      if (node) {
        node.style.display = 'none'
        this.overlay.appendChild(node)
        this.elements.set(el.id, node)
      }
    })
  }

  tick(currentTime: number): void {
    if (this.gateActive) return
    this.currentTime = currentTime

    for (const [id, node] of this.elements) {
      // We stored the element on the node for lookup
      const el = (node as any).__interactionData as InteractionElement
      if (!el) continue
      const visible = currentTime >= el.appearsAt && (el.hidesAt === null || currentTime <= el.hidesAt)
      node.style.display = visible ? 'block' : 'none'
    }
  }

  private createElementNode(el: InteractionElement): HTMLElement | null {
    let node: HTMLElement | null = null

    switch (el.type) {
      case 'hotspot':
        node = renderHotspot(el, () => {
          this.onFired('hotspot', el.id, { sceneId: el.jumpsToSceneId ?? undefined })
        })
        node.style.pointerEvents = 'auto'
        break

      case 'choice':
        node = renderChoice(el, this.brandColor, (optionId, jumpsToSceneId) => {
          this.onFired('choice', el.id, { sceneId: jumpsToSceneId })
        })
        node.style.pointerEvents = 'auto'
        break

      case 'quiz':
        node = renderQuiz(el, (correct, selectedId) => {
          this.onFired('quiz', el.id, { correct, selectedId })
        })
        node.style.pointerEvents = 'auto'
        break

      case 'gate':
        node = renderGate(el, this.brandColor, () => {
          this.gateActive = false
          node!.style.display = 'none'
          this.onFired('gate', el.id, {})
        })
        node.style.pointerEvents = 'auto'
        this.gateActive = true
        break

      case 'tooltip':
        node = renderTooltip(el)
        node.style.pointerEvents = 'auto'
        break

      case 'form':
        node = renderForm(el, this.variables, this.brandColor, (jumpsToSceneId) => {
          this.onFired('form', el.id, {
            sceneId: jumpsToSceneId ?? undefined,
            variables: this.variables.getAll(),
          })
        })
        node.style.pointerEvents = 'auto'
        break
    }

    if (node) {
      ;(node as any).__interactionData = el
    }
    return node
  }

  hide(): void {
    this.overlay.style.visibility = 'hidden'
  }

  show(): void {
    this.overlay.style.visibility = 'visible'
  }

  clear(): void {
    this.overlay.innerHTML = ''
    this.elements.clear()
  }

  destroy(): void {
    this.overlay.remove()
    this.elements.clear()
  }
}

// Inject shared CSS keyframes once
export function injectPlayerStyles(brandColor: string): void {
  if (document.getElementById('dreambyte-player-styles')) return
  const style = document.createElement('style')
  style.id = 'dreambyte-player-styles'
  style.textContent = `
    @keyframes dreambyte-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.7; transform: scale(1.06); }
    }
    @keyframes dreambyte-glow {
      0%, 100% { box-shadow: 0 0 8px 2px currentColor; }
      50% { box-shadow: 0 0 16px 6px currentColor; }
    }
    .dreambyte-controls button { font-family: sans-serif; }
  `
  document.head.appendChild(style)
}
