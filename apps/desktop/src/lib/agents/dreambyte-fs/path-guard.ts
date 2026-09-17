// Path containment guard for the scoped Tier 2 filesystem (W7).
//
// External agents (Claude Code, Cursor, Codex) will eventually drive a
// Dreambyte project via this module's tools. The plan's "Failure modes"
// table lists "MCP fs server escapes scope" as one of three critical
// gaps. This module is the load-bearing boundary — every read goes
// through `assertContained` first.
//
// The check is structural, not heuristic:
//   1. Resolve the candidate path with realpath (follows symlinks).
//   2. Resolve the root with realpath.
//   3. Assert candidate startsWith root + path.sep.
//
// path.relative or string-prefix without realpath are NOT sufficient —
// symlinks inside .dreambyte/ pointing to /etc/passwd would slip past.
// realpath collapses them to the absolute target, and we reject any
// target outside the root.

import path from 'node:path'
import fs from 'node:fs/promises'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export class PathNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathNotFoundError'
  }
}

/**
 * Throw if `candidate` would resolve outside `root`. Handles
 * not-yet-existing paths by walking up to the deepest existing
 * ancestor, realpathing that, and re-attaching the unresolved tail —
 * we still get the symlink-collapsing benefit of realpath without
 * crashing on ENOENT for paths the caller wants to write to or that
 * cross a non-existent intermediate.
 *
 * The `mustExist` option is informational only — even with `false` we
 * still walk to a real ancestor; with `true` the function additionally
 * asserts the candidate itself exists.
 */
export async function assertContained(
  root: string,
  candidate: string,
  opts: { mustExist?: boolean } = {},
): Promise<{ realRoot: string; realCandidate: string }> {
  const mustExist = opts.mustExist ?? true
  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch (err) {
    // Scope root itself missing — translate the raw ENOENT into the module's
    // taxonomy so callers map it to DreambyteFsError('NOT_FOUND') instead of
    // leaking a Node errno.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PathNotFoundError(`Scope root does not exist: "${root}".`)
    }
    throw err
  }
  const realCandidate = await realpathWithFallback(candidate)
  // Containment check FIRST — escape is the more dangerous condition,
  // so we want it to surface even when the file also doesn't exist.
  if (!isWithin(realRoot, realCandidate)) {
    throw new PathEscapeError(`Path "${candidate}" resolves outside the scope root "${root}".`)
  }
  if (mustExist) {
    try {
      await fs.stat(candidate)
    } catch {
      throw new PathNotFoundError(`Path "${candidate}" does not exist.`)
    }
  }
  return { realRoot, realCandidate }
}

/**
 * Resolve a path through symlinks, falling back gracefully when the
 * path doesn't exist: walk up to the deepest existing ancestor,
 * realpath that, then attach the unresolved tail. This still collapses
 * any symlink along the existing prefix, so an escape through a real
 * symlink is caught even if a child doesn't exist yet.
 */
async function realpathWithFallback(target: string): Promise<string> {
  const segments = path.resolve(target).split(path.sep)
  // Walk back from the full path until something exists.
  for (let i = segments.length; i > 0; i--) {
    const ancestor = segments.slice(0, i).join(path.sep) || path.sep
    try {
      const real = await fs.realpath(ancestor)
      const tail = segments.slice(i).join(path.sep)
      return tail ? path.join(real, tail) : real
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // try the next ancestor up
    }
  }
  // No existing ancestor — return the lexically resolved path.
  return path.resolve(target)
}

/**
 * Pure check: is `child` a descendant of (or equal to) `parent`? Both
 * paths must already be absolute + canonical. The trailing separator
 * dance avoids `/foo/bar` being treated as inside `/foo/ba`.
 */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true
  const normParent = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(normParent)
}

/**
 * Resolve a relative subpath under `root` and assert containment. This
 * is the typical entry point — pass user-supplied subpaths here rather
 * than calling `assertContained` directly.
 *
 * Defaults to `mustExist: false` since most callers use this to compute
 * a target path before reading or writing; pass `mustExist: true` to
 * also require the file already exist.
 */
export async function safeResolve(root: string, subpath: string, opts: { mustExist?: boolean } = {}): Promise<string> {
  if (typeof subpath !== 'string') {
    throw new PathEscapeError(`subpath must be a string`)
  }
  // Reject absolute subpaths early — they bypass the root.
  if (path.isAbsolute(subpath)) {
    throw new PathEscapeError(`Absolute subpath rejected: ${subpath}`)
  }
  // Reject null bytes — defense against C-string truncation tricks.
  if (subpath.includes('\0')) {
    throw new PathEscapeError(`Null byte rejected in subpath`)
  }
  const candidate = path.resolve(root, subpath)
  const { realCandidate } = await assertContained(root, candidate, { mustExist: opts.mustExist ?? false })
  return realCandidate
}
