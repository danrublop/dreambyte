#!/usr/bin/env node
/**
 * CLI entry point for `npm run db:migrate`.
 *
 * Kept separate from `src/lib/db/migrate.ts` so the importable library can be
 * pulled into the Electron main bundle without firing migrations as a side
 * effect (esbuild hoists import side-effects, which would crash boot before
 * main.ts has a chance to default DATABASE_URL).
 */
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })
import { runMigrations } from '../../src/lib/db/migrate'

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./dev.db'
  console.log(`Defaulting DATABASE_URL=${process.env.DATABASE_URL}`)
}

runMigrations()
  .then(() => {
    console.log('Migrations applied.')
  })
  .catch((err) => {
    console.error('Migrations failed:', err)
    process.exit(1)
  })
