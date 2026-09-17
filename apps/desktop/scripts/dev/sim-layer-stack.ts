/**
 * Dev simulator: takes a scene's React source code, replays the same
 * extraction + dedup walk that SceneLayersStackPanel performs, and prints
 * the exact rx:* keys the layer stack would show, plus what RxTextBody
 * would resolve them to in extractCodeTextSlots.
 *
 * Use to validate test scenes BEFORE clicking through the editor.
 */
import { extractElementsFromReactCode } from '../../src/lib/react-extract'
import { extractCodeTextSlots, type CodeTextSlot, type CodeTextSlotKind } from '../../src/lib/code-text-slots'

function legacyToNewKinds(kind: string): CodeTextSlotKind[] {
  if (kind === 'heading') return ['jsx-heading']
  if (kind === 'paragraph') return ['jsx-paragraph']
  if (kind === 'button') return ['jsx-button']
  if (kind === 'listItem') return ['jsx-li']
  if (kind === 'text') return ['jsx-div', 'jsx-span', 'svg-text', 'canvas-text', 'three-text']
  return []
}

function simulate(name: string, code: string) {
  console.log(`\n━━━ ${name} ━━━`)
  const els = extractElementsFromReactCode(code)

  // SceneLayersStackPanel dedup walk
  const seen = new Set<string>()
  let rxIdx = 0
  const stackRows: Array<{ key: string; legacyKind: string; label: string; raw: string | undefined }> = []
  for (const el of els) {
    const editable =
      el.kind === 'heading' ||
      el.kind === 'paragraph' ||
      el.kind === 'image' ||
      el.kind === 'button' ||
      el.kind === 'listItem' ||
      el.kind === 'text'
    if (!editable) continue
    const dedupKey = `${el.kind}:${el.label}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    stackRows.push({ key: `rx:${el.kind}:${rxIdx}`, legacyKind: el.kind, label: el.label, raw: el.raw })
    rxIdx++
  }

  console.log(`Layer stack rows (after dedup): ${stackRows.length}`)
  for (const r of stackRows) {
    console.log(`  ${r.key}   "${r.label}"   raw=${JSON.stringify(r.raw ?? null)}`)
  }

  // resolveRxSlot equivalent for each row
  const allSlots = extractCodeTextSlots(code)
  console.log(`\nextractCodeTextSlots total: ${allSlots.length}`)
  for (const s of allSlots) {
    console.log(`  [${s.kind}#${s.index}] text="${s.text.slice(0, 40)}" style=${JSON.stringify(s.style)}`)
  }

  console.log(`\nrxIndex → resolved slot:`)
  stackRows.forEach((row, i) => {
    const targetKinds = legacyToNewKinds(row.legacyKind)
    const candidates = allSlots.filter((s) => targetKinds.includes(s.kind))
    let resolved: CodeTextSlot | null = null
    if (row.raw) {
      resolved = candidates.find((s) => s.text === row.raw) ?? null
    }
    if (!resolved) resolved = candidates[0] ?? null
    console.log(`  ${row.key} → ${resolved ? `${resolved.kind}#${resolved.index} "${resolved.text.slice(0, 30)}"` : 'NULL'}`)
  })

  // Duplicate-detection report — slots that share kind+text
  const dupBuckets = new Map<string, CodeTextSlot[]>()
  for (const s of allSlots) {
    const k = `${s.kind}::${s.text}`
    const arr = dupBuckets.get(k) ?? []
    arr.push(s)
    dupBuckets.set(k, arr)
  }
  const dups = Array.from(dupBuckets.entries()).filter(([, v]) => v.length > 1)
  if (dups.length) {
    console.log(`\nDuplicate-text groups (Layer 3 override needed):`)
    for (const [k, arr] of dups) console.log(`  ${k} → ${arr.length} occurrences`)
  }
}

async function main() {
  const ids = [
    ['Scene 1 JSX Variety', '4e82e104-694e-4a16-b70d-7cebbdc0b2f9'],
    ['Scene 2 Tailwind', '8c2c59e6-d5cf-4539-b959-ce6f7cb7103f'],
    ['Scene 3 Repeated', 'bf70dd08-4ff4-4723-addc-d148a7964b69'],
    ['Scene 4 SVG', 'eb757d63-48bc-4079-82df-a77bc5f80a7b'],
    ['Scene 5 Canvas', 'a536eb73-a146-4445-b648-bc7b4239c96d'],
  ] as const

  for (const [name, id] of ids) {
    const inPath = `${process.env.HOME}/Library/Application Support/dreambyte/scenes/${id}.html`
    // We need the source reactCode, not the rendered HTML. Read it from the
    // generated HTML's embedded <script type="text/babel"> tag for now.
    const fs = await import('fs/promises')
    const html = await fs.readFile(inPath, 'utf8')
    // Extract the user's React code from the <script type="text/babel"> block.
    const m = html.match(/<script id="scene-jsx" type="text\/dreambyte-jsx">([\s\S]*?)<\/script>/)
    if (!m) {
      console.log(`\n━━━ ${name} ━━━\nNo babel script found in HTML.`)
      continue
    }
    // The babel block includes our wrapper. Strip everything except the
    // function Scene body and the export. Approximate by finding "function Scene".
    const scenePos = m[1].indexOf('function Scene')
    if (scenePos < 0) {
      console.log(`\n━━━ ${name} ━━━\nfunction Scene not found.`)
      continue
    }
    // Find the END of the user code: look for the export default Scene line.
    const exportPos = m[1].indexOf('export default Scene', scenePos)
    const userCode = exportPos > 0 ? m[1].slice(scenePos, exportPos + 'export default Scene'.length) : m[1].slice(scenePos)
    simulate(name, userCode)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
