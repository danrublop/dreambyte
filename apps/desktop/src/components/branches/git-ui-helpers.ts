/**
 * Pure helpers extracted from GitBranchesPanel + GitDiffViewer.
 *
 * Kept separate so we can unit-test the bits that have real logic
 * without spinning up React. The components themselves only render +
 * call IPC; everything that needs reasoning is here.
 */

import type { DiffEntry } from '@/lib/git/repo'

/**
 * Classify an error message coming back from `dreambyteApi.git.*`. We want
 * to show a "git init" CTA when the repo doesn't exist yet, vs surface
 * arbitrary errors verbatim.
 */
export function isNotInitialisedError(message: string): boolean {
  return /tier2Path|not a git repository|fatal: not/i.test(message)
}

export interface FileStatusCounts {
  added: number
  modified: number
  deleted: number
  renamed: number
  copied: number
  other: number
}

/** Count git name-status entries by their status letter. */
export function summariseFileStatuses(entries: readonly DiffEntry[]): FileStatusCounts {
  const counts: FileStatusCounts = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    other: 0,
  }
  for (const e of entries) {
    switch (e.status) {
      case 'A':
        counts.added++
        break
      case 'M':
        counts.modified++
        break
      case 'D':
        counts.deleted++
        break
      case 'R':
        counts.renamed++
        break
      case 'C':
        counts.copied++
        break
      default:
        counts.other++
    }
  }
  return counts
}

/** Pick the CSS-variable class for a status letter (tailwind colour util). */
export function colorForFileStatus(status: string): string {
  switch (status) {
    case 'A':
      return 'text-green-400'
    case 'D':
      return 'text-red-400'
    case 'M':
      return 'text-yellow-400'
    default:
      return 'text-[var(--color-text-muted)]'
  }
}

/** Pick the CSS class for an action-diff kind. */
export function colorForActionKind(kind: 'added' | 'removed' | 'changed'): string {
  return kind === 'added' ? 'text-green-400' : kind === 'removed' ? 'text-red-400' : 'text-yellow-400'
}

/**
 * Bucket a remote URL by transport: https remotes need a PAT to push to
 * private repos, ssh remotes use the OS-level key, file/git/local need
 * neither. The UI uses this to decide whether to surface the "set token"
 * button next to a remote.
 */
export function remoteAuthKind(url: string): 'https' | 'ssh' | 'local' | 'other' {
  if (/^https?:\/\//i.test(url)) return 'https'
  if (/^ssh:\/\//i.test(url) || /^git@/i.test(url)) return 'ssh'
  if (/^file:\/\//i.test(url) || url.startsWith('/') || /^[a-zA-Z]:\\/.test(url)) return 'local'
  return 'other'
}

/**
 * Short label shown next to a remote: "needs token" / "ssh" / "local".
 * The actual token-presence query goes through IPC; this helper only
 * decides what label *kind* applies before that probe resolves.
 */
export function remoteTransportLabel(url: string): string {
  switch (remoteAuthKind(url)) {
    case 'https':
      return 'https'
    case 'ssh':
      return 'ssh'
    case 'local':
      return 'local'
    default:
      return 'unknown'
  }
}
