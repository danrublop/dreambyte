import { describe, it, expect } from 'vitest'
import { isScratchDbUrl } from './run'

// The benchmark creates throwaway bench-* projects, so it must refuse real DBs —
// notably `DATABASE_URL=file:./dev.db`, which .env sets and the default
// `npm run eval:benchmark` therefore uses.
describe('isScratchDbUrl', () => {
  it('refuses the DBs a developer actually has data in', () => {
    for (const url of [
      'file:./dev.db',
      'file:/Users/dev/.dreambyte/studio.db',
      'file:./studio.db',
      '', // DATABASE_URL unset — the db layer would fall back to a real DB
      'libsql://prod.turso.io',
    ]) {
      expect(isScratchDbUrl(url), url || '(empty)').toBe(false)
    }
  })

  it('allows a DB the caller explicitly named as scratch', () => {
    for (const url of ['file:./bench.db', 'file:/tmp/scratch.db', ':memory:', 'file:./BENCH-run-3.db']) {
      expect(isScratchDbUrl(url), url).toBe(true)
    }
  })
})
