import '@testing-library/jest-dom/vitest'

// Stub DATABASE_URL so tests that transitively import src/lib/db/index.ts don't
// throw at module load. Tests that actually need DB access should mock Drizzle.
process.env.DATABASE_URL ??= 'postgres://stub:stub@localhost/stub'
