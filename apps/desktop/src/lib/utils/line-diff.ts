/**
 * Minimal line-level diff for the chat tool-card inline view.
 *
 * No external dependency: an LCS over lines with common prefix/suffix
 * trimming, emitting unified-diff-style rows with `context` lines around
 * each change and `gap` markers between hunks. Output is BOUNDED — both the
 * DP table (perf) and the emitted rows (storage: diffs ride along on
 * ToolCallRecords that persist with chat history) are capped, with an
 * explicit `truncated` flag instead of silent loss.
 */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'gap'
  text: string
}

export interface CodeDiff {
  lines: DiffLine[]
  added: number
  removed: number
  truncated: boolean
}

/** Beyond this many middle (non-common) lines per side, skip the O(n*m) LCS
 *  and report counts only — a full rewrite reads better as a summary anyway. */
const MAX_DP_LINES = 1500

/** Cap on emitted rows (storage bound for persisted chat records). */
const MAX_OUTPUT_LINES = 400

const CONTEXT = 3

/**
 * Compute a line diff. Returns null when the inputs are identical — callers
 * use that to skip attaching anything to the tool card.
 */
export function computeLineDiff(before: string, after: string): CodeDiff | null {
  if (before === after) return null
  const a = before.split('\n')
  const b = after.split('\n')

  // Trim common prefix/suffix so the DP only sees the changed middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length > MAX_DP_LINES || midB.length > MAX_DP_LINES) {
    // Effectively a rewrite — emit a summary-only diff.
    return { lines: [], added: midB.length, removed: midA.length, truncated: true }
  }

  // LCS table over the middle.
  const n = midA.length
  const m = midB.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Walk the table into op rows (over the middle), then add context from the
  // trimmed prefix/suffix.
  type Op = { type: 'add' | 'del' | 'same'; text: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ type: 'same', text: midA[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: midA[i] })
      i++
    } else {
      ops.push({ type: 'add', text: midB[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: 'del', text: midA[i++] })
  while (j < m) ops.push({ type: 'add', text: midB[j++] })

  // Prepend/append up to CONTEXT lines of the trimmed common regions.
  const prefixCtx = a.slice(Math.max(0, start - CONTEXT), start).map((text): Op => ({ type: 'same', text }))
  const suffixCtx = a.slice(endA, Math.min(a.length, endA + CONTEXT)).map((text): Op => ({ type: 'same', text }))
  const full = [...prefixCtx, ...ops, ...suffixCtx]

  // Collapse long unchanged runs inside the middle into gap markers, keeping
  // CONTEXT lines on each side of every change.
  const keep = new Array<boolean>(full.length).fill(false)
  for (let k = 0; k < full.length; k++) {
    if (full[k].type !== 'same') {
      for (let c = Math.max(0, k - CONTEXT); c <= Math.min(full.length - 1, k + CONTEXT); c++) keep[c] = true
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let truncated = false
  let inGap = false
  for (let k = 0; k < full.length; k++) {
    const op = full[k]
    if (op.type === 'add') added++
    if (op.type === 'del') removed++
    if (!keep[k]) {
      if (!inGap) {
        lines.push({ type: 'gap', text: '⋯' })
        inGap = true
      }
      continue
    }
    inGap = false
    if (lines.length >= MAX_OUTPUT_LINES) {
      truncated = true
      continue // keep counting added/removed, stop emitting rows
    }
    lines.push({ type: op.type === 'same' ? 'ctx' : op.type, text: op.text })
  }

  if (added === 0 && removed === 0) return null
  return { lines, added, removed, truncated }
}
