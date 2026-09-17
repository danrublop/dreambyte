#!/usr/bin/env tsx
/**
 * gen-memory-okf — generate the OKF `memory/` export VIEW from SQLite.
 *
 * The `user_memory`
 * SQLite table is the STORE OF RECORD; this script writes a generated, READ-ONLY
 * markdown bundle (`~/.dreambyte/memory/`) so learned preferences are
 * portable/inspectable. It is ONE-WAY (SQLite → files); nothing is read back.
 *
 * It writes a SEPARATE bundle in a DIFFERENT dir from the skills-library OKF
 * index, so it never touches `scripts/okf/gen-okf-index.ts`'s stale-gate.
 *
 * Usage:
 *   npx tsx scripts/okf/gen-memory-okf.ts                 # desktop user, user-global memory
 *   npx tsx scripts/okf/gen-memory-okf.ts --user <id>     # explicit user id
 *   npx tsx scripts/okf/gen-memory-okf.ts --project <id>  # scoped (narrowest-wins) view
 *
 * DATABASE_URL is honoured if set; otherwise it defaults to the desktop DB path
 * (mirrors scripts/debug-list-projects.ts).
 */

import os from 'node:os'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${os.homedir()}/Library/Application Support/dreambyte/dreambyte.db`
}

import { generateMemoryOkfView, getMemoryBundleDir } from '../../src/lib/memory/okf-view'
import { getDesktopUserId } from '../../src/lib/db/queries/desktop-user'
import { closeDb } from '../../src/lib/db'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const projectId = argValue('--project') ?? null
  let userId = argValue('--user')
  if (!userId) {
    userId = await getDesktopUserId()
  }

  const result = await generateMemoryOkfView(userId, { projectId })

  console.log(`✓ Wrote memory OKF view (${result.conceptCount} concept${result.conceptCount === 1 ? '' : 's'})`)
  console.log(`  dir: ${getMemoryBundleDir()}`)
  for (const f of result.written) console.log('  - ' + f)
  if (result.removed.length) {
    console.log('  removed (stale):')
    for (const f of result.removed) console.log('  - ' + f)
  }
}

main()
  .catch((err) => {
    console.error('✗ Failed to generate memory OKF view:', (err as Error).message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await closeDb()
    } catch {
      // best-effort close
    }
  })
