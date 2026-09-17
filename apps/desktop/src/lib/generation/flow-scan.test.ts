import { describe, expect, it } from 'vitest'
import { scanForFlow } from './flow-scan'

// A condensed camera-travel scene (THE FLOW): interpolated translate+scale world,
// big text, multiple eased beats. This is the shape the React exemplar teaches.
const GOOD = `export default function Scene() {
  const t = useCurrentFrame() / 30;
  const seg = (s,e) => Math.max(0, Math.min(1, (t-s)/(e-s)));
  const push = seg(1.9, 3.5);
  const focusX = 760 + (2280-760)*push;
  const scale = 1.06 - 0.06*push;
  const s2In = seg(2.0, 3.2);
  const world = { transform: \`translate(\${960 - focusX*scale}px, 0px) scale(\${scale})\` };
  return <AbsoluteFill style={{ background:'#000' }}><div style={world}>
    <div style={{ fontSize: 96, fontWeight: 800 }}>Every AI video you generate</div>
    <div style={{ fontSize: 120, opacity: s2In }}>a cost you don't see</div>
  </div></AbsoluteFill>;
}`

// The anti-pattern: a static slideshow. Small text, one fade, no camera move.
const BAD = `export default function Scene() {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1]);
  return <AbsoluteFill style={{ background:'#111' }}>
    <div style={{ fontSize: 48, opacity, transform: 'translateY(0px)' }}>A title</div>
    <div style={{ fontSize: 32 }}>A subtitle that just sits there</div>
  </AbsoluteFill>;
}`

describe('scanForFlow', () => {
  it('passes a camera-travel scene (FLOW present)', () => {
    const r = scanForFlow(GOOD)
    expect(r.hasCameraMove).toBe(true)
    expect(r.hasBigText).toBe(true)
    expect(r.maxFontSize).toBe(120)
    expect(r.hasSequentialBeats).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('flags a static slideshow (no camera move, small text)', () => {
    const r = scanForFlow(BAD)
    expect(r.hasCameraMove).toBe(false)
    expect(r.hasBigText).toBe(false)
    expect(r.warnings.length).toBeGreaterThanOrEqual(2)
    expect(r.warnings.some((w) => w.includes('camera move'))).toBe(true)
  })

  it('treats a structured cameraMotion track as a camera move (③.4)', () => {
    // Same static BAD code, but the scene carries a set_camera_motion track that
    // lives outside the code fields — it IS a camera move, so no slideshow warning.
    const r = scanForFlow(BAD, { hasCameraMotionTrack: true })
    expect(r.hasCameraMove).toBe(true)
    expect(r.warnings.some((w) => w.includes('camera move'))).toBe(false)
    // Empty code + a camera track still reports the move (no code to scan).
    expect(scanForFlow('', { hasCameraMotionTrack: true }).hasCameraMove).toBe(true)
    expect(scanForFlow('', { hasCameraMotionTrack: false }).hasCameraMove).toBe(false)
  })

  it('detects a 3D camera animation as a camera move', () => {
    const code = `update={(scene, camera, frame) => { camera.position.z = 10 - frame*0.1; }}
      <div style={{ fontSize: 90 }}>Big</div>`
    expect(scanForFlow(code).hasCameraMove).toBe(true)
  })

  it('ACCEPTS a tinted dark "almost-black" background (graded ground, reconciled with the grade craft)', () => {
    const r = scanForFlow(`<AbsoluteFill style={{ background: '#04111c', fontSize: 96 }}><div/></AbsoluteFill>`)
    expect(r.bgFlatMono).toBe(true)
    expect(r.warnings.some((w) => w.includes('mid-tone'))).toBe(false)
  })

  it('accepts flat true black / true white / near-neutral dark', () => {
    expect(scanForFlow(`<AbsoluteFill style={{ background: '#000' }}/>`).bgFlatMono).toBe(true)
    expect(scanForFlow(`<AbsoluteFill style={{ background: '#fff' }}/>`).bgFlatMono).toBe(true)
    expect(scanForFlow(`<AbsoluteFill style={{ background: '#06070a' }}/>`).bgFlatMono).toBe(true)
    expect(scanForFlow(`<AbsoluteFill style={{ background: 'black' }}/>`).bgFlatMono).toBe(true)
  })

  it('ACCEPTS a gradient root background (depth is good, not slop)', () => {
    const r = scanForFlow(`<AbsoluteFill style={{ background: 'radial-gradient(circle, #123, #000)' }}/>`)
    expect(r.bgFlatMono).toBe(true)
    expect(r.warnings.some((w) => w.includes('mid-tone'))).toBe(false)
  })

  it('flags a flat MID-TONE solid fill (the real muddy slop)', () => {
    const r = scanForFlow(`<AbsoluteFill style={{ background: '#7a6a55', fontSize: 96 }}/>`)
    expect(r.bgFlatMono).toBe(false)
    expect(r.warnings.some((w) => w.includes('mid-tone'))).toBe(true)
  })

  it('estimates a canvas-scaled font against the REAL (vertical) dimensions', () => {
    // HEIGHT*0.05 on a 9:16 1080x1920 canvas = 96px (big) — not 54px (old fixed-1080 bug)
    expect(scanForFlow(`<div style={{ fontSize: HEIGHT * 0.05 }}>T</div>`, { width: 1080, height: 1920 }).hasBigText).toBe(
      true,
    )
  })

  it('reads a ternary/expression font size (not 0px)', () => {
    expect(scanForFlow(`<div style={{ fontSize: isBig ? 132 : 100 }}>Q</div>`).maxFontSize).toBe(132)
  })

  it('returns empty for blank input', () => {
    expect(scanForFlow('').warnings).toEqual([])
    expect(scanForFlow('   ').maxFontSize).toBe(0)
    expect(scanForFlow('').bgFlatMono).toBe(true)
  })

  it('does not count a static transform as a camera move', () => {
    const code = `<div style={{ transform: 'translate(10px, 0) scale(1.1)', fontSize: 80 }}>x</div>`
    expect(scanForFlow(code).hasCameraMove).toBe(false) // no ${} interpolation = not a move
  })

  // Regression — the World Cup benchmark false-positives (2/2 per scene): the old scan
  // read a canvas-scaled hero (fontSize: H*0.36) as 0px and only matched the COMBINED
  // translate() form, so a real camera-travel scene using a computed font + separate-axis
  // translateX/translateY got flagged "static slideshow, tiny text". It must pass clean.
  const SCALED_AND_SEPARATE_AXIS = `export default function Scene() {
    const t = useCurrentFrame()/30;
    const seg=(s,e)=>Math.max(0,Math.min(1,(t-s)/(e-s)));
    const camX = -1920*seg(1,3); const camY = -400*seg(1,3); const s = 1 + 0.1*seg(0,1);
    const world = { transform: \`translateX(\${camX}px) translateY(\${camY}px) scale(\${s})\` };
    return <AbsoluteFill style={{ background:'#fff' }}><div style={world}>
      <div style={{ fontSize: H*0.36, fontWeight: 800 }}>48</div>
    </div></AbsoluteFill>;
  }`

  it('estimates a canvas-scaled hero font instead of reading it as 0px', () => {
    const r = scanForFlow(SCALED_AND_SEPARATE_AXIS)
    expect(r.maxFontSize).toBeGreaterThanOrEqual(72) // H*0.36 ≈ 389px on a 1080 canvas
    expect(r.hasBigText).toBe(true)
    expect(r.warnings.some((w) => w.includes('headline'))).toBe(false)
  })

  it('recognizes a separate translateX/translateY + scale camera world', () => {
    const r = scanForFlow(SCALED_AND_SEPARATE_AXIS)
    expect(r.hasCameraMove).toBe(true)
    expect(r.warnings.some((w) => w.includes('camera move'))).toBe(false)
  })

  it('still flags a genuinely small canvas-scaled font (HEIGHT*0.04 ≈ 43px < 72)', () => {
    const r = scanForFlow(
      `<AbsoluteFill style={{ background:'#000' }}><div style={{ fontSize: HEIGHT*0.04 }}>x</div></AbsoluteFill>`,
    )
    expect(r.hasBigText).toBe(false)
    expect(r.warnings.some((w) => w.includes('headline'))).toBe(true)
  })
})
