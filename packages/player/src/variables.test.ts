import { describe, it, expect } from 'vitest'

import { VariableStore } from './variables'

// Form values are interpolated into the scene srcdoc,
// which runs with allow-scripts. Values must be HTML-escaped so a viewer can't
// inject executable markup.
describe('VariableStore.interpolate — HTML escaping', () => {
  it('escapes a script-injection payload in a variable value', () => {
    const store = new VariableStore()
    store.set('name', '</script><script>alert(1)</script>')
    const out = store.interpolate('<div>Hi {name}</div>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('escapes quotes and ampersands (attribute-context safety)', () => {
    const store = new VariableStore()
    store.set('v', `" onmouseover="alert(1)" x="`)
    const out = store.interpolate('<img alt="{v}">')
    expect(out).not.toContain('onmouseover="alert(1)"')
    expect(out).toContain('&quot;')
  })

  it('leaves benign values readable', () => {
    const store = new VariableStore()
    store.set('name', 'Ada')
    expect(store.interpolate('Hello {name}')).toBe('Hello Ada')
  })
})
