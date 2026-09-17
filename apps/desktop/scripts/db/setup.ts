// Local-first setup: provisions a SQLite dreambyte.db (or a libsql URL via
// DATABASE_URL) and applies migrations + built-in seed data.
//
// Pre-SQLite this script also booted a docker-compose Postgres. That step
// is gone — there's nothing to start when the DB is just a file.
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env' })
import { runMigrations } from '../../src/lib/db/migrate'

async function setup() {
  console.log('Dreambyte setup...\n')

  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./dev.db'
    console.log(`Using default DATABASE_URL=${process.env.DATABASE_URL}`)
  }

  console.log('Running migrations...')
  await runMigrations()
  console.log('Migrations complete\n')

  console.log('Setup complete. Run npm run dev to start.\n')
  process.exit(0)
}

setup().catch((e) => {
  console.error('Setup failed:', e)
  process.exit(1)
})
