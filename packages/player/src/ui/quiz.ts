import type { QuizElement } from '../types'

export function renderQuiz(el: QuizElement, onAnswered: (correct: boolean, selectedId: string) => void): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.style.cssText = `
    position: absolute;
    left: ${el.x}%; top: ${el.y}%;
    width: ${el.width}%;
    display: flex; flex-direction: column;
    gap: 12px; padding: 20px;
    background: rgba(0,0,0,0.9);
    border-radius: 12px;
    box-sizing: border-box;
    pointer-events: auto;
  `

  const q = document.createElement('p')
  q.textContent = el.question
  q.style.cssText = 'color:white;font-size:15px;font-weight:600;margin:0;'
  wrapper.appendChild(q)

  const letters = ['A', 'B', 'C', 'D', 'E']
  let answered = false

  el.options.forEach((opt, i) => {
    const btn = document.createElement('button')
    btn.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 2px solid #444;
      background: #222;
      color: white;
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, background 0.15s;
    `

    const badge = document.createElement('span')
    badge.textContent = letters[i] ?? String(i + 1)
    badge.style.cssText = `
      width: 24px; height: 24px; border-radius: 50%;
      background: #444; display: flex; align-items: center;
      justify-content: center; font-size: 11px; font-weight: 700;
      flex-shrink: 0;
    `
    btn.appendChild(badge)

    const text = document.createElement('span')
    text.textContent = opt.label
    btn.appendChild(text)

    btn.addEventListener('click', () => {
      if (answered) return
      answered = true
      const correct = opt.id === el.correctOptionId

      // Highlight all buttons
      wrapper.querySelectorAll('button').forEach((b, idx) => {
        const isCorrect = el.options[idx].id === el.correctOptionId
        if (isCorrect) {
          b.style.borderColor = '#22c55e'
          b.style.background = '#16803022'
        } else if (b === btn && !correct) {
          b.style.borderColor = '#ef4444'
          b.style.background = '#dc262622'
        }
        ;(b as HTMLButtonElement).disabled = true
      })

      // Show explanation
      if (el.explanation) {
        const exp = document.createElement('p')
        exp.textContent = el.explanation
        exp.style.cssText = `
          color: #aaa; font-size: 12px; margin: 4px 0 0;
          padding: 8px; background: #1a1a1a; border-radius: 6px;
        `
        wrapper.appendChild(exp)
      }

      // Fire callback after 1.5s
      setTimeout(() => onAnswered(correct, opt.id), 1500)
    })

    wrapper.appendChild(btn)
  })

  return wrapper
}
