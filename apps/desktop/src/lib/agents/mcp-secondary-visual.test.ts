// @vitest-environment node
process.env.DATABASE_URL = 'file::memory:'

// T9 secondary-visual: after a code-write tool / verify_scene succeeds over MCP,
// the handler attaches a rendered frame (data.image) so the agent SEES its edit.
// The frame is emitted as a separate MCP image content block by the server, so
// its base64 must NOT leak into the text content (a multi-KB data URI would bury
// the real result and waste tokens). These tests pin assembleMcpResultText — the
// text-assembly seam where that leak would happen — plus the caption behavior.
import { describe, it, expect } from 'vitest'
import { assembleMcpResultText } from './mcp-handler'

const bigDataUri = 'data:image/png;base64,' + 'A'.repeat(5000)
const image = { dataUri: bigDataUri, mimeType: 'image/png', width: 1280, height: 720 }

describe('assembleMcpResultText (T9 secondary-visual)', () => {
  it('a failed tool returns its error; arbitrary data is NOT dumped', () => {
    expect(assembleMcpResultText({ success: false, error: 'boom', data: { x: 1 } }, null)).toBe('boom')
    expect(assembleMcpResultText({ success: false }, null)).toBe('Tool execution failed')
  })

  it('a FAILED verify_scene surfaces its data.report verbatim (not a bare "Tool execution failed")', () => {
    // verify_scene returns success:false with NO error field and the verdict in data.report.
    const report = '── VERIFY: "Intro" ──\nISSUES FOUND (1) — Fix these:\n  ⚠ RUNTIME ERROR: foo is not defined (line 12)'
    const text = assembleMcpResultText(
      { success: false, data: { clientAction: 'capture_frame', sceneId: 's1', time: 1, report, issues: ['x'] } },
      null,
    )
    expect(text).toBe(report) // verbatim, no JSON-escaping of the multi-line string
    expect(text).not.toBe('Tool execution failed')
    expect(text).toMatch(/RUNTIME ERROR: foo is not defined \(line 12\)/)
    // The internal clientAction signal / structured fields are NOT dumped as noise.
    expect(text).not.toMatch(/clientAction/)
  })

  it('a failed tool with BOTH error and report shows both', () => {
    const text = assembleMcpResultText({ success: false, error: 'boom', data: { report: 'the verdict' } }, null)
    expect(text).toMatch(/boom/)
    expect(text).toMatch(/the verdict/)
  })

  it('a failed tool with an empty/blank report falls back to the generic message', () => {
    expect(assembleMcpResultText({ success: false, data: { report: '   ' } }, null)).toBe('Tool execution failed')
    expect(assembleMcpResultText({ success: false, data: { report: 42 } }, null)).toBe('Tool execution failed')
  })

  it('strips the image base64 out of the text content (no data-URI leak)', () => {
    const text = assembleMcpResultText(
      { success: true, data: { report: 'verify ok', clientAction: 'capture_frame', sceneId: 's1', image } },
      1,
    )
    // The real result survives...
    expect(text).toMatch(/verify ok/)
    expect(text).toMatch(/s1/)
    // ...but the giant base64 data URI is NOT in the text.
    expect(text).not.toContain('AAAA')
    expect(text).not.toContain('data:image/png;base64')
    expect(text.length).toBeLessThan(1000)
  })

  it('appends a caption that names the frame size + capture time', () => {
    const text = assembleMcpResultText({ success: true, data: { report: 'ok', image } }, 2.5)
    expect(text).toMatch(/Attached a rendered frame \(1280×720px\) at t=2\.5s/)
    expect(text).toMatch(/review it to confirm/i)
  })

  it('a native image (no secondary capture) gets NO "edited scene" caption, but base64 is still stripped', () => {
    // e.g. generate_image: data.image is the generated asset, not an edit frame.
    const text = assembleMcpResultText({ success: true, data: { report: 'ok', image } }, null)
    expect(text).toMatch(/report/)
    expect(text).not.toMatch(/Attached a rendered frame/)
    expect(text).not.toContain('AAAA')
    expect(text).not.toContain('data:image/png;base64')
  })

  it('no image -> no caption, data still serialized', () => {
    const text = assembleMcpResultText({ success: true, data: { sceneId: 's1', report: 'ok' } }, null)
    expect(text).toMatch(/s1/)
    expect(text).not.toMatch(/Attached a rendered frame/)
  })

  it('changes descriptions lead the content', () => {
    const text = assembleMcpResultText(
      { success: true, changes: [{ description: 'Wrote scene code' }], data: { image } },
      1,
    )
    expect(text.indexOf('Wrote scene code')).toBe(0)
    expect(text).toMatch(/Attached a rendered frame/)
  })

  it('image-only data (no other fields) -> caption only, no empty JSON blob', () => {
    const text = assembleMcpResultText({ success: true, data: { image } }, 1)
    expect(text).toMatch(/Attached a rendered frame/)
    // No bare "{}" from serializing an otherwise-empty object.
    expect(text).not.toContain('{}')
  })

  it("empty successful result falls back to 'Done'", () => {
    expect(assembleMcpResultText({ success: true }, null)).toBe('Done')
    expect(assembleMcpResultText({ success: true, data: {} }, null)).toBe('Done')
  })
})
