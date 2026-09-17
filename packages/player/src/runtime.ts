// Scene sequencer + state machine

import type { PublishedProject, PublishedScene, SceneEdge, PlayerEvent } from './types'
import type { VariableStore } from './variables'
import type { Renderer } from './renderer'
import type { InteractionCallback } from './interactions'
import { InteractionOverlay } from './interactions'

export class Runtime {
  private project: PublishedProject
  private variables: VariableStore
  private renderer: Renderer
  private overlay: InteractionOverlay
  private currentSceneId: string = ''
  private playing: boolean = false
  private rafId: number = 0
  private startTime: number = 0
  private sceneStartTime: number = 0
  private listeners: Map<PlayerEvent, Set<(...args: unknown[]) => void>> = new Map()
  private onTimeUpdate: (current: number, total: number) => void
  private onPlayingChange: (playing: boolean) => void

  constructor(
    project: PublishedProject,
    variables: VariableStore,
    renderer: Renderer,
    overlay: InteractionOverlay,
    onTimeUpdate: (current: number, total: number) => void,
    onPlayingChange: (playing: boolean) => void,
  ) {
    this.project = project
    this.variables = variables
    this.renderer = renderer
    this.overlay = overlay
    this.onTimeUpdate = onTimeUpdate
    this.onPlayingChange = onPlayingChange
  }

  async start(sceneId?: string): Promise<void> {
    const startId = sceneId ?? this.project.sceneGraph.startSceneId
    await this.loadScene(startId)
    this.play()
  }

  async loadScene(sceneId: string): Promise<void> {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.playing = false
    this.onPlayingChange(false)

    const scene = this.getScene(sceneId)
    if (!scene) return

    this.currentSceneId = sceneId
    this.emit('sceneChange', { sceneId })

    this.overlay.hide()
    await this.renderer.loadScene(scene)
    this.overlay.loadScene(scene)
    this.overlay.show()
    this.sceneStartTime = 0
  }

  play(): void {
    this.playing = true
    this.onPlayingChange(true)
    this.renderer.resume()
    this.startTime = performance.now() - this.sceneStartTime * 1000
    this.tick()
  }

  pause(): void {
    this.playing = false
    this.onPlayingChange(false)
    this.renderer.pause()
    if (this.rafId) cancelAnimationFrame(this.rafId)
  }

  goToScene(sceneId: string): void {
    this.loadScene(sceneId).then(() => this.play())
  }

  /** Scrub the currently loaded scene to `time` (seconds, scene-local).
   * Preserves the playing/paused state — a scrub during playback keeps
   * playing from the new position, a scrub while paused stays paused. */
  seek(time: number): void {
    const scene = this.getScene(this.currentSceneId)
    if (!scene) return
    const clamped = Math.max(0, Math.min(scene.duration, time))
    this.sceneStartTime = clamped
    // Realign the RAF clock so the next tick() computes elapsed = clamped
    this.startTime = performance.now() - clamped * 1000
    this.renderer.seek(clamped)
    this.overlay.tick(clamped)
    this.onTimeUpdate(clamped, scene.duration)
  }

  private tick(): void {
    const scene = this.getScene(this.currentSceneId)
    if (!scene) return

    const elapsed = (performance.now() - this.startTime) / 1000
    this.sceneStartTime = elapsed
    this.onTimeUpdate(elapsed, scene.duration)
    this.overlay.tick(elapsed)

    if (elapsed >= scene.duration) {
      this.onSceneEnd()
      return
    }

    if (this.playing) {
      this.rafId = requestAnimationFrame(() => this.tick())
    }
  }

  private onSceneEnd(): void {
    const edge = this.resolveEdge(this.currentSceneId)
    if (edge) {
      this.loadScene(edge.toSceneId).then(() => this.play())
    } else {
      this.playing = false
      this.onPlayingChange(false)
      this.emit('completed', {})
    }
  }

  onInteractionFired: InteractionCallback = (type, elementId, payload) => {
    this.emit('interactionFired', { type, elementId, ...payload })

    if (payload.sceneId) {
      this.goToScene(payload.sceneId)
      return
    }

    // Look up edge by interactionId
    const edge = this.project.sceneGraph.edges.find(
      (e) => e.fromSceneId === this.currentSceneId && e.condition.interactionId === elementId,
    )
    if (edge) {
      this.goToScene(edge.toSceneId)
    } else if (type === 'gate') {
      // Resume playback
      this.play()
    }
  }

  private resolveEdge(fromSceneId: string): SceneEdge | null {
    const edges = this.project.sceneGraph.edges.filter((e) => e.fromSceneId === fromSceneId)
    // Check variable conditions first
    for (const edge of edges) {
      if (edge.condition.type === 'variable') {
        const val = this.variables.get(edge.condition.variableName!)
        if (val === edge.condition.variableValue) return edge
      }
    }
    // Fall back to auto
    return edges.find((e) => e.condition.type === 'auto') ?? null
  }

  private getScene(id: string): PublishedScene | undefined {
    return this.project.scenes.find((s) => s.id === id)
  }

  emit(event: PlayerEvent, data: any): void {
    this.listeners.get(event)?.forEach((h) => h(data))
  }

  on(event: PlayerEvent, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
  }

  off(event: PlayerEvent, handler: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler)
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.listeners.clear()
  }
}
