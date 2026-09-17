// Dreambyte Player — entry point

import type { PlayerOptions, PublishedProject, PlayerEvent } from './types'
import { VariableStore } from './variables'
import { Renderer } from './renderer'
import { Runtime } from './runtime'
import { InteractionOverlay, injectPlayerStyles } from './interactions'
import { PlayerControls } from './ui/controls'

export type { PlayerOptions, PublishedProject, PlayerEvent }
export { VariableStore }

export class DreambyteStudioPlayer {
  private container: HTMLElement
  private options: PlayerOptions
  private variables: VariableStore
  private renderer!: Renderer
  private overlay!: InteractionOverlay
  private runtime!: Runtime
  private controls?: PlayerControls
  private wrapper!: HTMLElement
  private stage!: HTMLElement
  private resizeObserver!: ResizeObserver

  constructor(container: HTMLElement, options: Partial<PlayerOptions> = {}) {
    this.container = container
    this.options = {
      theme: options.theme ?? 'dark',
      showProgressBar: options.showProgressBar ?? true,
      showSceneNav: options.showSceneNav ?? false,
      allowFullscreen: options.allowFullscreen ?? true,
      brandColor: options.brandColor ?? '#e84545',
      autoplay: options.autoplay ?? false,
    }
    this.variables = new VariableStore()
    injectPlayerStyles(this.options.brandColor)
    this.setupContainer()
  }

  private setupContainer(): void {
    this.wrapper = document.createElement('div')
    this.wrapper.style.cssText = `
      position: relative; width: 100%; height: 100%;
      background: ${this.options.theme === 'dark' ? '#000' : '#fff'};
      overflow: hidden;
      isolation: isolate;
      contain: strict;
    `
    this.container.appendChild(this.wrapper)

    // Inner stage: fixed 1920×1080, scaled via CSS transform to fit the wrapper.
    // Both the iframe and the interaction overlay live inside this stage so that
    // percentage-based interaction coordinates map exactly to pixel positions.
    this.stage = document.createElement('div')
    this.stage.style.cssText = `
      position: absolute;
      width: 1920px; height: 1080px;
      transform-origin: top left;
    `
    this.wrapper.appendChild(this.stage)

    this.scaleStage()
    this.resizeObserver = new ResizeObserver(() => this.scaleStage())
    this.resizeObserver.observe(this.wrapper)
  }

  private scaleStage(): void {
    const w = this.wrapper.clientWidth
    const h = this.wrapper.clientHeight
    if (w === 0 || h === 0) return
    const scaleX = w / 1920
    const scaleY = h / 1080
    const scale = Math.min(scaleX, scaleY)
    const offsetX = (w - 1920 * scale) / 2
    const offsetY = (h - 1080 * scale) / 2
    this.stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
  }

  async load(projectUrl: string): Promise<void> {
    const res = await fetch(projectUrl)
    const project: PublishedProject = await res.json()
    this.loadData(project)
  }

  loadData(project: PublishedProject): void {
    this.renderer = new Renderer(this.stage, this.variables)
    this.overlay = new InteractionOverlay(
      this.stage,
      this.variables,
      this.options.brandColor,
      (type, elementId, payload) => {
        this.runtime.onInteractionFired(type, elementId, payload)
      },
    )

    if (this.options.showProgressBar) {
      this.controls = new PlayerControls(this.wrapper, {
        brandColor: this.options.brandColor,
        onPlay: () => this.play(),
        onPause: () => this.pause(),
        onSeek: (t) => this.runtime?.seek(t),
      })
    }

    const totalDuration = project.scenes.reduce((a, s) => a + s.duration, 0)

    this.runtime = new Runtime(
      project,
      this.variables,
      this.renderer,
      this.overlay,
      (current, sceneDuration) => {
        this.controls?.update(current, sceneDuration)
      },
      (playing) => {
        this.controls?.setPlaying(playing)
      },
    )

    if (this.options.autoplay) {
      this.runtime.start()
    }
  }

  play(): void {
    this.runtime?.play()
  }

  pause(): void {
    this.runtime?.pause()
  }

  goToScene(sceneId: string): void {
    this.runtime?.goToScene(sceneId)
  }

  setVariable(name: string, value: string): void {
    this.variables.set(name, value)
    this.runtime?.emit('variableSet', { name, value })
  }

  getVariable(name: string): string | undefined {
    return this.variables.get(name)
  }

  on(event: PlayerEvent, handler: (...args: unknown[]) => void): void {
    this.runtime?.on(event, handler)
  }

  destroy(): void {
    this.resizeObserver?.disconnect()
    this.runtime?.destroy()
    this.renderer?.destroy()
    this.overlay?.destroy()
    this.controls?.destroy()
    this.variables.clear()
    this.wrapper.remove()
  }
}

// Auto-init from data attributes
if (typeof window !== 'undefined') {
  ;(window as any).DreambyteStudioPlayer = DreambyteStudioPlayer
}

export default DreambyteStudioPlayer
