import { describe, expect, it } from 'vitest'
import { buildPublishedIndexHtml } from './publish-index'

describe('buildPublishedIndexHtml', () => {
  it('loads the bundled player and manifest from the same folder', () => {
    const html = buildPublishedIndexHtml('My Video')
    expect(html).toContain('<script src="player.js"></script>')
    expect(html).toContain(".load('manifest.json')")
    expect(html).toContain('<title>My Video</title>')
  })

  it('escapes the project name in the title', () => {
    const html = buildPublishedIndexHtml('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&#60;img src=x onerror=&#34;alert(1)&#34;&#62;')
  })
})
