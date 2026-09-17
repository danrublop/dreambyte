import { db } from '../index'
import { users } from '../schema'
import { eq } from 'drizzle-orm'

/**
 * The single local desktop user.
 *
 * A desktop install has no auth/session, but several tables hang per-user rows off a FK to
 * `users.id` — notably `permission_rules.userId`. So we seed ONE deterministic user row lazily and
 * own all local rows under it. This is the desktop analogue of "the signed-in user" the web app
 * would have. Idempotent + memoized, so it's safe to call on every IPC.
 */
export const DESKTOP_USER_ID = '00000000-0000-4000-8000-000000000001'
const DESKTOP_USER_EMAIL = 'desktop@dreambyte.local'

let ensured = false

/** Get the desktop user id, seeding the row on first use. */
export async function getDesktopUserId(): Promise<string> {
  if (ensured) return DESKTOP_USER_ID
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, DESKTOP_USER_ID)).limit(1)
  if (existing.length === 0) {
    // onConflictDoNothing covers the race where two IPCs seed at once, and the unique-email guard.
    await db
      .insert(users)
      .values({ id: DESKTOP_USER_ID, email: DESKTOP_USER_EMAIL, name: 'Desktop User' })
      .onConflictDoNothing()
  }
  ensured = true
  return DESKTOP_USER_ID
}
