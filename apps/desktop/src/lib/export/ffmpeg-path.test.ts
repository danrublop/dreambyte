// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findFfmpeg } from '@dreambyte/render-server/ffmpeg-path.js'

// Fake binaries in temp dirs. platform 'linux' keeps the macOS Homebrew fallback
// (real /opt/homebrew) out of the lookup; darwin cases pass fake brew prefixes.
describe.skipIf(process.platform === 'win32')('findFfmpeg', () => {
  let root: string
  let envDir: string
  let pathDir: string
  const touch = (dir: string, name: string, mode = 0o755) => {
    const p = path.join(dir, name)
    writeFileSync(p, '#!/bin/sh\n')
    chmodSync(p, mode)
    return p
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-path-'))
    envDir = path.join(root, 'custom')
    pathDir = path.join(root, 'bin')
    mkdirSync(envDir)
    mkdirSync(pathDir)
    touch(envDir, 'ffmpeg')
    touch(envDir, 'ffprobe')
    touch(pathDir, 'ffmpeg')
    touch(pathDir, 'ffprobe', 0o644) // not executable → ignored
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('prefers DREAMBYTE_FFMPEG_PATH, then FFMPEG_PATH, over PATH', () => {
    const custom = path.join(envDir, 'ffmpeg')
    expect(findFfmpeg('ffmpeg', { DREAMBYTE_FFMPEG_PATH: custom, PATH: pathDir }, 'linux')).toBe(custom)
    expect(findFfmpeg('ffmpeg', { FFMPEG_PATH: custom, PATH: pathDir }, 'linux')).toBe(custom)
  })

  it('finds ffprobe next to an overridden ffmpeg', () => {
    const env = { DREAMBYTE_FFMPEG_PATH: path.join(envDir, 'ffmpeg'), PATH: pathDir }
    expect(findFfmpeg('ffprobe', env, 'linux')).toBe(path.join(envDir, 'ffprobe'))
  })

  it('falls back to PATH when the override is wrong, skipping non-executables', () => {
    const env = { DREAMBYTE_FFMPEG_PATH: path.join(root, 'nope', 'ffmpeg'), PATH: pathDir }
    expect(findFfmpeg('ffmpeg', env, 'linux')).toBe(path.join(pathDir, 'ffmpeg'))
    expect(findFfmpeg('ffprobe', { PATH: pathDir }, 'linux')).toBeNull()
  })

  it('prefers Homebrew ffmpeg-full over plain ffmpeg on macOS, after the override', () => {
    const prefix = path.join(root, 'brew')
    const fullDir = path.join(prefix, 'opt', 'ffmpeg-full', 'bin')
    mkdirSync(fullDir, { recursive: true })
    mkdirSync(path.join(prefix, 'bin'))
    touch(fullDir, 'ffmpeg')
    touch(path.join(prefix, 'bin'), 'ffmpeg')
    expect(findFfmpeg('ffmpeg', { PATH: pathDir }, 'darwin', [prefix])).toBe(path.join(fullDir, 'ffmpeg'))
    expect(findFfmpeg('ffmpeg', {}, 'darwin', [prefix])).toBe(path.join(fullDir, 'ffmpeg'))
    const custom = path.join(envDir, 'ffmpeg')
    expect(findFfmpeg('ffmpeg', { DREAMBYTE_FFMPEG_PATH: custom }, 'darwin', [prefix])).toBe(custom)
    // Without ffmpeg-full: PATH first, then the Homebrew bin dir.
    const plainOnly = path.join(root, 'brew-plain')
    mkdirSync(path.join(plainOnly, 'bin'), { recursive: true })
    touch(path.join(plainOnly, 'bin'), 'ffmpeg')
    expect(findFfmpeg('ffmpeg', { PATH: pathDir }, 'darwin', [plainOnly])).toBe(path.join(pathDir, 'ffmpeg'))
    expect(findFfmpeg('ffmpeg', {}, 'darwin', [plainOnly])).toBe(path.join(plainOnly, 'bin', 'ffmpeg'))
  })

  it('returns null when nothing is installed', () => {
    expect(findFfmpeg('ffmpeg', { PATH: path.join(root, 'empty') }, 'linux')).toBeNull()
    expect(findFfmpeg('ffmpeg', {}, 'linux')).toBeNull()
  })
})
