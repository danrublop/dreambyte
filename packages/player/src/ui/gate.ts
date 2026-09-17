import type { GateElement } from '../types'

export function renderGate(el: GateElement, brandColor: string, onContinue: () => void): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `
    position: absolute;
    left: ${el.x}%; top: ${el.y}%;
    transform: translate(-50%, -50%);
    display: flex; align-items: center; justify-content: center;
    pointer-events: auto;
  `

  const btn = document.createElement('button')

  if (el.buttonStyle === 'primary') {
    btn.style.cssText = `
      padding: 12px 28px;
      border-radius: 8px;
      border: none;
      background: ${brandColor};
      color: white;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 16px ${brandColor}66;
      transition: transform 0.1s, box-shadow 0.1s;
    `
  } else if (el.buttonStyle === 'outline') {
    btn.style.cssText = `
      padding: 12px 28px;
      border-radius: 8px;
      border: 2px solid ${brandColor};
      background: transparent;
      color: ${brandColor};
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    `
    btn.addEventListener('mouseenter', () => {
      btn.style.background = `${brandColor}22`
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent'
    })
  } else {
    // minimal
    btn.style.cssText = `
      padding: 12px 28px;
      border: none; background: transparent;
      color: white; font-size: 16px; font-weight: 600;
      cursor: pointer; text-decoration: underline;
    `
  }

  btn.textContent = el.buttonLabel

  btn.addEventListener('mousedown', () => {
    btn.style.transform = 'scale(0.97)'
  })
  btn.addEventListener('mouseup', () => {
    btn.style.transform = 'scale(1)'
  })
  btn.addEventListener('click', onContinue)

  wrapper.appendChild(btn)
  return wrapper
}
