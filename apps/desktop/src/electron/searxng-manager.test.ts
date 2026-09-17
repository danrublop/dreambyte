// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildSearxngSettingsYaml } from './searxng-manager'

describe('buildSearxngSettingsYaml', () => {
  it('enables the JSON format our provider needs and inherits defaults', () => {
    const yaml = buildSearxngSettingsYaml('deadbeef')
    expect(yaml).toContain('use_default_settings: true')
    expect(yaml).toMatch(/formats:\s*\n\s*- html\s*\n\s*- json/)
    expect(yaml).toContain('secret_key: "deadbeef"')
  })
})
