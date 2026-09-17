/**
 * gen-okf-mirror — keep `.agents/skills/dreambyte/` a generated MIRROR of the
 * canonical `.claude/skills/dreambyte/` knowledge dirs so the two can't drift.
 *
 * Mirrors the consumer-AGNOSTIC knowledge tree only — `rules/` (incl. its generated
 * index.md). Deliberately does NOT touch SKILL.md, which is
 * legitimately consumer-specific (Claude Code vs other harnesses).
 *
 * Run:  npx tsx scripts/okf/gen-okf-mirror.ts          (write the mirror)
 *       npx tsx scripts/okf/gen-okf-mirror.ts --check   (CI stale-gate; exit 1 on drift)
 */
import fs from 'fs'
import path from 'path'

const CWD = process.cwd()
const SRC = path.join(CWD, '.claude', 'skills', 'dreambyte')
const DST = path.join(CWD, '.agents', 'skills', 'dreambyte')
const DIRS = ['rules']

export function mirrorDrift(sub: string): string[] {
  const srcDir = path.join(SRC, sub)
  const dstDir = path.join(DST, sub)
  let srcFiles: string[]
  try {
    srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const dstFiles = fs.existsSync(dstDir) ? fs.readdirSync(dstDir).filter((f) => f.endsWith('.md')) : []
  const drift: string[] = []
  for (const f of srcFiles) {
    const s = fs.readFileSync(path.join(srcDir, f), 'utf8')
    const dp = path.join(dstDir, f)
    const d = fs.existsSync(dp) ? fs.readFileSync(dp, 'utf8') : null
    if (d !== s) drift.push(`${sub}/${f}`)
  }
  for (const f of dstFiles) {
    if (!srcFiles.includes(f)) drift.push(`${sub}/${f} (stale)`)
  }
  return drift
}

/** Compute drift across all mirrored dirs (used by the stale-gate test). */
export function allMirrorDrift(): string[] {
  return DIRS.flatMap(mirrorDrift)
}

function writeMirror(): string[] {
  const changed: string[] = []
  for (const sub of DIRS) {
    const srcDir = path.join(SRC, sub)
    const dstDir = path.join(DST, sub)
    let srcFiles: string[]
    try {
      srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    // Safety: never let an empty/partial source wipe the mirror (wrong cwd,
    // mid-rebase). A real bundle dir always has files.
    if (srcFiles.length === 0) continue
    fs.mkdirSync(dstDir, { recursive: true })
    for (const f of srcFiles) {
      const s = fs.readFileSync(path.join(srcDir, f), 'utf8')
      const dp = path.join(dstDir, f)
      const d = fs.existsSync(dp) ? fs.readFileSync(dp, 'utf8') : null
      if (d !== s) {
        fs.writeFileSync(dp, s)
        changed.push(`${sub}/${f}`)
      }
    }
    for (const f of fs.readdirSync(dstDir).filter((x) => x.endsWith('.md'))) {
      if (!srcFiles.includes(f)) {
        fs.unlinkSync(path.join(dstDir, f))
        changed.push(`${sub}/${f} (removed stale)`)
      }
    }
  }
  return changed
}

function main() {
  if (process.argv.includes('--check')) {
    const drift = allMirrorDrift()
    if (drift.length) {
      console.error(`[gen-okf-mirror] .agents is STALE — run \`npm run gen:okf-mirror\`:\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    console.log('[gen-okf-mirror] .agents mirror is up to date.')
    return
  }
  const changed = writeMirror()
  console.log(
    changed.length
      ? `[gen-okf-mirror] synced ${changed.length} file(s) to .agents:\n  ${changed.join('\n  ')}`
      : '[gen-okf-mirror] .agents already up to date.',
  )
}

main()
