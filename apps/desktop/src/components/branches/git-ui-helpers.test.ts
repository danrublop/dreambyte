// @vitest-environment node

import { describe, it, expect } from 'vitest'

import {
  isNotInitialisedError,
  summariseFileStatuses,
  colorForFileStatus,
  colorForActionKind,
  remoteAuthKind,
  remoteTransportLabel,
} from './git-ui-helpers'
import type { DiffEntry } from '@/lib/git/repo'

describe('isNotInitialisedError', () => {
  it('matches the tier2Path-missing message from the IPC handler', () => {
    expect(isNotInitialisedError('Project has no tier2Path; configure a folder first')).toBe(true)
  })

  it('matches "not a git repository" from system git', () => {
    expect(
      isNotInitialisedError('git status failed: fatal: not a git repository (or any parent up to mount point /)'),
    ).toBe(true)
  })

  it('matches bare "fatal: not" stems for safety', () => {
    expect(isNotInitialisedError('fatal: not a git repo')).toBe(true)
  })

  it('returns false for arbitrary errors so they surface verbatim', () => {
    expect(isNotInitialisedError('Permission denied')).toBe(false)
    expect(isNotInitialisedError('rate limited')).toBe(false)
    expect(isNotInitialisedError('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isNotInitialisedError('FATAL: NOT a git repository')).toBe(true)
  })
})

describe('summariseFileStatuses', () => {
  function entry(status: string, path = 'x'): DiffEntry {
    return { status, path }
  }

  it('returns zero counts for an empty list', () => {
    expect(summariseFileStatuses([])).toEqual({
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      other: 0,
    })
  })

  it('counts each git name-status letter into its slot', () => {
    const entries = [
      entry('A', 'a.txt'),
      entry('A', 'b.txt'),
      entry('M', 'c.txt'),
      entry('D', 'd.txt'),
      entry('R', 'e.txt'),
      entry('C', 'f.txt'),
      entry('X', 'g.txt'), // bogus status — buckets into `other`
    ]
    expect(summariseFileStatuses(entries)).toEqual({
      added: 2,
      modified: 1,
      deleted: 1,
      renamed: 1,
      copied: 1,
      other: 1,
    })
  })
})

describe('colorForFileStatus', () => {
  it('maps A/D/M to the conventional add/delete/modify hues', () => {
    expect(colorForFileStatus('A')).toContain('green')
    expect(colorForFileStatus('D')).toContain('red')
    expect(colorForFileStatus('M')).toContain('yellow')
  })

  it('falls through to the muted CSS variable for unknown statuses', () => {
    expect(colorForFileStatus('R')).toContain('color-text-muted')
    expect(colorForFileStatus('')).toContain('color-text-muted')
  })
})

describe('colorForActionKind', () => {
  it('maps action-diff kinds to the same colour scheme as file diff', () => {
    expect(colorForActionKind('added')).toContain('green')
    expect(colorForActionKind('removed')).toContain('red')
    expect(colorForActionKind('changed')).toContain('yellow')
  })
})

describe('remoteAuthKind', () => {
  it('classifies https URLs as https (needs a PAT for private)', () => {
    expect(remoteAuthKind('https://github.com/foo/bar.git')).toBe('https')
    expect(remoteAuthKind('http://gitlab.local/x.git')).toBe('https')
  })

  it('classifies ssh URLs (and shorthand git@ form) as ssh', () => {
    expect(remoteAuthKind('ssh://git@github.com/foo/bar.git')).toBe('ssh')
    expect(remoteAuthKind('git@github.com:foo/bar.git')).toBe('ssh')
  })

  it('classifies local file paths as local', () => {
    expect(remoteAuthKind('file:///tmp/origin.git')).toBe('local')
    expect(remoteAuthKind('/tmp/origin.git')).toBe('local')
    expect(remoteAuthKind('C:\\repos\\origin.git')).toBe('local')
  })

  it('falls through to "other" for unknown transports', () => {
    expect(remoteAuthKind('s3://bucket/repo')).toBe('other')
    expect(remoteAuthKind('')).toBe('other')
  })
})

describe('remoteTransportLabel', () => {
  it('echoes the auth kind for known transports', () => {
    expect(remoteTransportLabel('https://x')).toBe('https')
    expect(remoteTransportLabel('git@x:y.git')).toBe('ssh')
    expect(remoteTransportLabel('/tmp/x')).toBe('local')
  })

  it('returns "unknown" for unrecognised URLs', () => {
    expect(remoteTransportLabel('mystery://x')).toBe('unknown')
  })
})
