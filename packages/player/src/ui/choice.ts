import type { ChoiceElement } from '../types'

export function renderChoice(
  el: ChoiceElement,
  brandColor: string,
  onChoice: (optionId: string, jumpsToSceneId: string) => void,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `
    position: absolute;
    left: ${el.x}%; top: ${el.y}%;
    width: ${el.width}%;
    display: flex; flex-direction: column; align-items: center;
    gap: 12px; padding: 20px;
    background: rgba(0,0,0,0.85);
    border-radius: 12px;
    box-sizing: border-box;
    pointer-events: auto;
  `

  if (el.question) {
    const q = document.createElement('p')
    q.textContent = el.question
    q.style.cssText = 'color:white;font-size:16px;font-weight:600;margin:0;text-align:center;'
    wrapper.appendChild(q)
  }

  const buttonsDiv = document.createElement('div')
  const isHorizontal = el.layout === 'horizontal'
  const isGrid = el.layout === 'grid'
  buttonsDiv.style.cssText = `
    display: flex;
    flex-direction: ${isHorizontal ? 'row' : 'column'};
    flex-wrap: ${isGrid ? 'wrap' : 'nowrap'};
    gap: 10px;
    width: 100%;
    justify-content: center;
  `

  el.options.forEach((opt) => {
    const btn = document.createElement('button')
    btn.textContent = (opt.icon ? opt.icon + ' ' : '') + opt.label
    const color = opt.color || brandColor
    btn.style.cssText = `
      padding: 10px 20px;
      border-radius: 8px;
      border: 2px solid ${color};
      background: ${color}22;
      color: white;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      ${isGrid ? 'flex: 1 1 40%;' : 'flex: 1;'}
    `
    btn.addEventListener('mouseenter', () => {
      btn.style.background = `${color}55`
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = `${color}22`
    })
    btn.addEventListener('click', () => onChoice(opt.id, opt.jumpsToSceneId))
    buttonsDiv.appendChild(btn)
  })

  wrapper.appendChild(buttonsDiv)
  return wrapper
}
