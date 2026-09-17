// Play/pause/progress bar controls

export interface ControlsOptions {
  brandColor: string
  onPlay: () => void
  onPause: () => void
  onSeek: (t: number) => void
}

export class PlayerControls {
  private container: HTMLElement
  private bar: HTMLElement
  private progressFill: HTMLElement
  private playBtn: HTMLElement
  private timeDisplay: HTMLElement
  private totalDuration: number = 0
  private currentTime: number = 0
  private playing: boolean = false

  constructor(parent: HTMLElement, opts: ControlsOptions) {
    this.container = document.createElement('div')
    this.container.className = 'dreambyte-controls'
    this.container.style.cssText = `
      position: absolute; bottom: 0; left: 0; right: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%);
      z-index: 50;
    `

    // Play/Pause button
    this.playBtn = document.createElement('button')
    this.playBtn.style.cssText = `
      width: 32px; height: 32px; border-radius: 50%;
      border: none; background: ${opts.brandColor};
      color: white; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
    `
    this.playBtn.innerHTML = '▶'
    this.playBtn.addEventListener('click', () => {
      if (this.playing) {
        opts.onPause()
      } else {
        opts.onPlay()
      }
    })

    // Progress bar
    this.bar = document.createElement('div')
    this.bar.style.cssText = `
      flex: 1; height: 4px; background: rgba(255,255,255,0.3);
      border-radius: 2px; cursor: pointer; position: relative;
    `
    this.progressFill = document.createElement('div')
    this.progressFill.style.cssText = `
      position: absolute; left: 0; top: 0; bottom: 0;
      background: ${opts.brandColor}; border-radius: 2px;
      width: 0%;
    `
    this.bar.appendChild(this.progressFill)
    this.bar.addEventListener('click', (e) => {
      const rect = this.bar.getBoundingClientRect()
      const pct = (e.clientX - rect.left) / rect.width
      opts.onSeek(pct * this.totalDuration)
    })

    // Time display
    this.timeDisplay = document.createElement('span')
    this.timeDisplay.style.cssText = `
      color: rgba(255,255,255,0.8); font-size: 11px;
      font-family: monospace; white-space: nowrap; flex-shrink: 0;
    `
    this.timeDisplay.textContent = '0:00 / 0:00'

    this.container.appendChild(this.playBtn)
    this.container.appendChild(this.bar)
    this.container.appendChild(this.timeDisplay)
    parent.appendChild(this.container)
  }

  setPlaying(playing: boolean): void {
    this.playing = playing
    this.playBtn.innerHTML = playing ? '⏸' : '▶'
  }

  update(currentTime: number, totalDuration: number): void {
    this.currentTime = currentTime
    this.totalDuration = totalDuration
    const pct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0
    this.progressFill.style.width = `${pct}%`
    this.timeDisplay.textContent = `${fmt(currentTime)} / ${fmt(totalDuration)}`
  }

  show(): void {
    this.container.style.display = 'flex'
  }
  hide(): void {
    this.container.style.display = 'none'
  }
  destroy(): void {
    this.container.remove()
  }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
