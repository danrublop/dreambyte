import type { TooltipElement } from '../types'

function triggerBorderRadius(shape: TooltipElement['triggerShape'] | undefined): string {
  switch (shape) {
    case 'circle':
      return '50%'
    case 'pill':
      return '9999px'
    case 'rounded':
      return '12px'
    case 'square':
      return '0'
    case 'rectangle':
    default:
      return '6px'
  }
}

export function renderTooltip(el: TooltipElement): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `
    position: absolute;
    left: ${el.x}%; top: ${el.y}%;
    width: ${el.width}%; height: ${el.height}%;
    box-sizing: border-box;
    pointer-events: auto;
  `

  // Trigger area
  const trigger = document.createElement('div')
  trigger.style.cssText = `
    width: 100%; height: 100%;
    border-radius: ${triggerBorderRadius(el.triggerShape)};
    background: ${el.triggerColor}33;
    border: 2px solid ${el.triggerColor};
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    animation: dreambyte-pulse 2s infinite;
  `

  if (el.triggerLabel) {
    const label = document.createElement('span')
    label.textContent = el.triggerLabel
    label.style.cssText = 'color:white;font-size:11px;font-weight:700;pointer-events:none;'
    trigger.appendChild(label)
  }

  // Tooltip card
  const card = document.createElement('div')
  const isTop = el.tooltipPosition === 'top'
  const isLeft = el.tooltipPosition === 'left'
  const isRight = el.tooltipPosition === 'right'

  card.style.cssText = `
    display: none;
    position: absolute;
    max-width: ${el.tooltipMaxWidth}px;
    background: rgba(0,0,0,0.92);
    border: 1px solid #444;
    border-radius: 8px;
    padding: 10px 14px;
    z-index: 100;
    pointer-events: none;
    ${isTop ? 'bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);' : ''}
    ${el.tooltipPosition === 'bottom' ? 'top: calc(100% + 8px); left: 50%; transform: translateX(-50%);' : ''}
    ${isLeft ? 'right: calc(100% + 8px); top: 50%; transform: translateY(-50%);' : ''}
    ${isRight ? 'left: calc(100% + 8px); top: 50%; transform: translateY(-50%);' : ''}
  `

  const title = document.createElement('p')
  title.textContent = el.tooltipTitle
  title.style.cssText = 'color:white;font-size:13px;font-weight:700;margin:0 0 4px;'
  card.appendChild(title)

  const body = document.createElement('p')
  body.textContent = el.tooltipBody
  body.style.cssText = 'color:#aaa;font-size:12px;margin:0;line-height:1.5;'
  card.appendChild(body)

  trigger.appendChild(card)

  trigger.addEventListener('mouseenter', () => {
    card.style.display = 'block'
  })
  trigger.addEventListener('mouseleave', () => {
    card.style.display = 'none'
  })

  wrapper.appendChild(trigger)
  return wrapper
}
