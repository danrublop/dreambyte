import type { FormInputElement } from '../types'
import type { VariableStore } from '../variables'

export function renderForm(
  el: FormInputElement,
  variables: VariableStore,
  brandColor: string,
  onSubmit: (jumpsToSceneId: string | null) => void,
): HTMLElement {
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

  const fieldValues: Record<string, string> = {}

  el.fields.forEach((field) => {
    const group = document.createElement('div')
    group.style.cssText = 'display:flex;flex-direction:column;gap:4px;'

    const label = document.createElement('label')
    label.textContent = field.label + (field.required ? ' *' : '')
    label.style.cssText = 'color:#ccc;font-size:12px;font-weight:600;'
    group.appendChild(label)

    if (field.type === 'text') {
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = field.placeholder ?? ''
      input.style.cssText = `
        padding: 8px 12px; border-radius: 6px;
        border: 1px solid #444; background: #1a1a1a;
        color: white; font-size: 13px; outline: none;
      `
      input.addEventListener('focus', () => {
        input.style.borderColor = brandColor
      })
      input.addEventListener('blur', () => {
        input.style.borderColor = '#444'
      })
      input.addEventListener('input', () => {
        fieldValues[field.id] = input.value
      })
      group.appendChild(input)
    } else if (field.type === 'select') {
      const select = document.createElement('select')
      select.style.cssText = `
        padding: 8px 12px; border-radius: 6px;
        border: 1px solid #444; background: #1a1a1a;
        color: white; font-size: 13px;
      `
      const emptyOpt = document.createElement('option')
      emptyOpt.value = ''
      emptyOpt.textContent = 'Select...'
      select.appendChild(emptyOpt)
      field.options.forEach((opt) => {
        const o = document.createElement('option')
        o.value = opt
        o.textContent = opt
        select.appendChild(o)
      })
      select.addEventListener('change', () => {
        fieldValues[field.id] = select.value
      })
      group.appendChild(select)
    } else if (field.type === 'radio') {
      field.options.forEach((opt) => {
        const row = document.createElement('label')
        row.style.cssText = 'display:flex;align-items:center;gap:8px;color:white;font-size:13px;cursor:pointer;'
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = field.id
        radio.value = opt
        radio.style.accentColor = brandColor
        radio.addEventListener('change', () => {
          if (radio.checked) fieldValues[field.id] = opt
        })
        row.appendChild(radio)
        row.appendChild(document.createTextNode(opt))
        group.appendChild(row)
      })
    }

    wrapper.appendChild(group)
  })

  const submitBtn = document.createElement('button')
  submitBtn.textContent = el.submitLabel
  submitBtn.style.cssText = `
    padding: 10px 24px;
    border-radius: 8px; border: none;
    background: ${brandColor};
    color: white; font-size: 14px; font-weight: 700;
    cursor: pointer; margin-top: 4px;
    transition: transform 0.1s;
  `
  submitBtn.addEventListener('click', () => {
    // Set variables from form
    el.setsVariables.forEach(({ fieldId, variableName }) => {
      const value = fieldValues[fieldId]
      if (value !== undefined) variables.set(variableName, value)
    })
    onSubmit(el.jumpsToSceneId)
  })
  wrapper.appendChild(submitBtn)

  return wrapper
}
