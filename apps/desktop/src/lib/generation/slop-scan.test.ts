import { describe, it, expect } from 'vitest'
import { scanForSlop } from './slop-scan'

describe('scanForSlop', () => {
  it('flags emoji used as on-screen content', () => {
    const code = `<div>{'🏦'}</div><div>🛒</div>`
    const out = scanForSlop(code)
    expect(out.some((w) => w.includes('emoji'))).toBe(true)
  })

  it('does NOT flag the Bitcoin sign or arrows (legit text glyphs)', () => {
    const code = `<div>₿</div><div>you → shop</div>`
    expect(scanForSlop(code)).toEqual([])
  })

  it('flags a scene-number / section kicker label', () => {
    expect(scanForSlop(`<div>02 — DOUBLE SPENDING</div>`).some((w) => w.includes('kicker'))).toBe(true)
    expect(scanForSlop(`<div>{'01 — THE PROBLEM'}</div>`).some((w) => w.includes('kicker'))).toBe(true)
    expect(scanForSlop(`<div>STEP 3</div>`).some((w) => w.includes('kicker'))).toBe(true)
  })

  it('does NOT flag ordinary prose containing numbers/slashes', () => {
    const code = `<div>Open 24/7</div><div>Q3 Results</div><div>3 ideas</div>`
    expect(scanForSlop(code).some((w) => w.includes('kicker'))).toBe(false)
  })

  it('flags 3+ UPPERCASE eyebrow/section labels (slide chrome)', () => {
    const code = `
      <div style={{ textTransform: 'uppercase', letterSpacing: 6 }}>The bottleneck</div>
      <div style={{ textTransform: 'uppercase', letterSpacing: 8 }}>Solana's answer</div>
      <div style={{ textTransform: 'uppercase', letterSpacing: 4 }}>The result</div>`
    expect(scanForSlop(code).some((w) => w.includes('eyebrow'))).toBe(true)
  })

  it('does NOT flag 2 uppercase labels (can be legit data labels, e.g. REVENUE / QoQ GROWTH)', () => {
    const code = `
      <div style={{ textTransform: 'uppercase' }}>Revenue</div>
      <div style={{ textTransform: 'uppercase' }}>QoQ Growth</div>`
    expect(scanForSlop(code).some((w) => w.includes('eyebrow'))).toBe(false)
  })

  it('does NOT flag a single uppercase label', () => {
    const code = `<div style={{ textTransform: 'uppercase' }}>Solana</div>`
    expect(scanForSlop(code).some((w) => w.includes('eyebrow'))).toBe(false)
  })

  it('does NOT flag a kicker pattern that lives only in a code comment', () => {
    const code = `{/* STATION 1 — TEXT: the hook */}<div>The World Cup got bigger</div>`
    expect(scanForSlop(code).some((w) => w.includes('kicker'))).toBe(false)
  })

  it('still flags a real kicker in rendered JSX text', () => {
    expect(scanForSlop(`<div>02 — DOUBLE SPENDING</div>`).some((w) => w.includes('kicker'))).toBe(true)
  })

  it('does NOT flag flag emojis (countries/teams are legit content)', () => {
    const code = `<div>{'🇧🇷'}</div><div>🇫🇷</div><div>🇦🇷</div>`
    expect(scanForSlop(code).some((w) => w.includes('emoji'))).toBe(false)
  })

  it('still flags decorative non-flag emoji even alongside flags', () => {
    const code = `<div>🇧🇷</div><div>🏆</div>`
    expect(scanForSlop(code).some((w) => w.includes('emoji'))).toBe(true)
  })

  it('does NOT flag an emoji that appears only in a comment', () => {
    expect(scanForSlop(`// use a 🏦 here later\n<div>clean</div>`).some((w) => w.includes('emoji'))).toBe(false)
  })

  it('flags a frame % N whole-scene loop', () => {
    expect(scanForSlop(`const t = frame % cyc;`).some((w) => w.includes('loop'))).toBe(true)
    expect(scanForSlop(`const x = (frame%90);`).some((w) => w.includes('loop'))).toBe(true)
  })

  it('passes clean, contract-compliant code with no findings', () => {
    const code = `
      export default function Scene() {
        const frame = useCurrentFrame();
        const o = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: 'clamp' });
        return <AbsoluteFill style={{ background: '#fafaf8' }}><h1 style={{ opacity: o }}>Always a middleman.</h1></AbsoluteFill>;
      }`
    expect(scanForSlop(code)).toEqual([])
  })

  it('returns no findings for empty input', () => {
    expect(scanForSlop('')).toEqual([])
    expect(scanForSlop('   ')).toEqual([])
  })
})
