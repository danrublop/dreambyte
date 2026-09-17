// @vitest-environment node
/**
 * Exercises the Marlin sidecar host's stdio JSON-RPC framing and failure
 * handling using a real Node subprocess as a stand-in for the Python server
 * (no CUDA/Python needed). Verifies the actual line protocol, not a mock.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  checkMarlinRuntime,
  createMarlinSidecar,
  resolveMarlinScriptPath,
  type MarlinSidecar,
} from './marlin-sidecar-host'

// A tiny stand-in "server": reads newline JSON requests, echoes a caption result.
const ECHO_SERVER = `
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.source === '__crash__') { process.exit(1) }
    process.stdout.write(JSON.stringify({
      id: req.id, ok: true,
      result: { scene: 'echo:' + req.source, events: [{ start: 0, end: 1, description: 'x' }] },
    }) + '\\n')
  }
})
`

let scriptPath: string
let sidecar: MarlinSidecar | null = null

afterEach(async () => {
  sidecar?.dispose()
  sidecar = null
  if (scriptPath) await fs.rm(scriptPath, { force: true }).catch(() => {})
})

async function writeEcho(): Promise<string> {
  scriptPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marlin-test-')), 'echo.js')
  await fs.writeFile(scriptPath, ECHO_SERVER)
  return scriptPath
}

describe('createMarlinSidecar', () => {
  it('frames a caption request/response over stdio', async () => {
    const script = await writeEcho()
    sidecar = createMarlinSidecar({ pythonPath: process.execPath, scriptPath: script })
    const result = await sidecar.caption('dreambyte://uploads/v.mp4')
    expect(result.scene).toBe('echo:dreambyte://uploads/v.mp4')
    expect(result.events).toEqual([{ start: 0, end: 1, description: 'x' }])
  })

  it('reuses one child across multiple requests', async () => {
    const script = await writeEcho()
    sidecar = createMarlinSidecar({ pythonPath: process.execPath, scriptPath: script })
    const [a, b] = await Promise.all([sidecar.caption('a'), sidecar.caption('b')])
    expect(a.scene).toBe('echo:a')
    expect(b.scene).toBe('echo:b')
  })

  it('rejects when the interpreter is missing (degrades, never hangs)', async () => {
    sidecar = createMarlinSidecar({ pythonPath: '/nonexistent/python-xyz', scriptPath: 'x.py' })
    await expect(sidecar.caption('v.mp4')).rejects.toThrow()
  })

  it('rejects in-flight requests when the child exits', async () => {
    const script = await writeEcho()
    sidecar = createMarlinSidecar({ pythonPath: process.execPath, scriptPath: script })
    await expect(sidecar.caption('__crash__')).rejects.toThrow(/exited/)
  })
})

describe('resolveMarlinScriptPath', () => {
  it('uses the resources dir when packaged (Python cannot read app.asar)', () => {
    expect(
      resolveMarlinScriptPath({
        isPackaged: true,
        resourcesPath: '/Applications/Dreambyte.app/Contents/Resources',
        moduleDir: '/Applications/Dreambyte.app/Contents/Resources/app.asar/dist-electron',
      }),
    ).toBe('/Applications/Dreambyte.app/Contents/Resources/sidecars/marlin/marlin_server.py')
  })

  it('uses the repo root in dev (one level up from dist-electron/)', () => {
    const repo = path.resolve(__dirname, '..', '..')
    const resolved = resolveMarlinScriptPath({
      isPackaged: false,
      resourcesPath: '/unused',
      moduleDir: path.join(repo, 'dist-electron'),
    })
    expect(resolved).toBe(path.join(repo, 'sidecars', 'marlin', 'marlin_server.py'))
    expect(existsSync(resolved)).toBe(true)
  })

  it('matches what electron-builder ships via extraResources', () => {
    const repo = path.resolve(__dirname, '..', '..')
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
    const entry = pkg.build.extraResources.find((r: { from: string }) => r.from === 'sidecars/marlin')
    expect(entry).toBeDefined()
    expect(entry.to).toBe('sidecars/marlin')
    for (const file of ['marlin_server.py', 'requirements.txt']) {
      expect(entry.filter).toContain(file)
      expect(existsSync(path.join(repo, 'sidecars', 'marlin', file))).toBe(true)
    }
  })
})

describe('checkMarlinRuntime', () => {
  const realScript = path.resolve(__dirname, '..', '..', 'sidecars', 'marlin', 'marlin_server.py')
  const fakePython =
    (code: string): Parameters<typeof checkMarlinRuntime>[0]['spawnImpl'] =>
    () =>
      spawn(process.execPath, ['-e', code]) as ReturnType<NonNullable<Parameters<typeof checkMarlinRuntime>[0]['spawnImpl']>>

  it('passes when every module imports', async () => {
    await expect(checkMarlinRuntime({ scriptPath: realScript, spawnImpl: fakePython('process.exit(0)') })).resolves.toEqual({
      ok: true,
    })
  })

  it('names the missing module and how to install the requirements', async () => {
    const r = await checkMarlinRuntime({
      scriptPath: realScript,
      pythonPath: 'python3',
      spawnImpl: fakePython(`process.stderr.write("ModuleNotFoundError: No module named 'torch'\\n"); process.exit(1)`),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/"torch" is missing/)
      expect(r.reason).toContain(path.join(path.dirname(realScript), 'requirements.txt'))
    }
  })

  it('fails clearly when the interpreter does not exist', async () => {
    const r = await checkMarlinRuntime({ scriptPath: realScript, pythonPath: '/nonexistent/python-xyz' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Python not found/)
  })

  it('fails when the script was not shipped', async () => {
    const r = await checkMarlinRuntime({ scriptPath: '/nonexistent/sidecars/marlin/marlin_server.py' })
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/script not found/) })
  })
})
