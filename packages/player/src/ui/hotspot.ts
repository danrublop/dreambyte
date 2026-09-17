import type { HotspotElement } from '../types'

export function renderHotspot(el: HotspotElement, onClick: () => void): HTMLElement {
  const div = document.createElement('div')
  const borderRadius = el.shape === 'circle' ? '50%' : el.shape === 'pill' ? '999px' : '8px'
  div.style.cssText = `
    position: absolute;
    left: ${el.x}%; top: ${el.y}%;
    width: ${el.width}%; height: ${el.height}%;
    cursor: pointer;
    pointer-events: auto;
    border-radius: ${borderRadius};
    background: ${el.color}33;
    border: 2px solid ${el.color};
    display: flex; align-items: center; justify-content: center;
    box-sizing: border-box;
  `
  if (el.style === 'pulse') {
    div.style.animation = 'dreambyte-pulse 2s infinite'
  } else if (el.style === 'glow') {
    div.style.boxShadow = `0 0 12px 4px ${el.color}66`
  } else if (el.style === 'filled') {
    div.style.background = el.color
  }

  if (el.label) {
    const label = document.createElement('span')
    label.textContent = el.label
    label.style.cssText = 'color:white;font-size:14px;font-weight:600;pointer-events:none;'
    div.appendChild(label)
  }

  div.addEventListener('click', onClick)
  return div
}
