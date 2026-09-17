import type { Config } from 'drizzle-kit'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env' })

// Migrations for the local SQLite database live under `src/lib/db/migrations/`.
export default {
  schema: 'src/lib/db/schema.ts',
  out: 'src/lib/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./dev.db',
  },
  verbose: true,
  strict: true,
} satisfies Config
