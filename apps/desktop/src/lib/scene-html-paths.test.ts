// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import path from 'path'
import { resolveScenesDir } from './scene-html-paths'

const ORIGINAL_DREAMBYTE_SCENES_DIR = process.env.DREAMBYTE_SCENES_DIR

afterEach(() => {
  if (ORIGINAL_DREAMBYTE_SCENES_DIR === undefined) {
    delete process.env.DREAMBYTE_SCENES_DIR
  } else {
    process.env.DREAMBYTE_SCENES_DIR = ORIGINAL_DREAMBYTE_SCENES_DIR
  }
})

describe('resolveScenesDir', () => {
  it('uses DREAMBYTE_SCENES_DIR when desktop runtime provides it', () => {
    process.env.DREAMBYTE_SCENES_DIR = '/tmp/dreambyte-user-scenes'

    expect(resolveScenesDir()).toBe('/tmp/dreambyte-user-scenes')
  })

  it('falls back to public/scenes for dev/runtime without override', () => {
    delete process.env.DREAMBYTE_SCENES_DIR

    expect(resolveScenesDir()).toBe(path.join(process.cwd(), 'public', 'scenes'))
  })
})
