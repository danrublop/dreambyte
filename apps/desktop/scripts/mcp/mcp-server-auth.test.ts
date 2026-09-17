import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { authenticateSocket } from './mcp-server'

/**
 * The MCP Unix socket handed a full MCP tool surface to ANY connection — a
 * malicious postinstall or compromised editor extension could enumerate the
 * socket and call set_max_run_cost / approve_pending_generation to spend the
 * user's API credits. These pin the handshake.
 */
const TOKEN = 'a'.repeat(64)
const servers: net.Server[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** Start a socket server that authenticates one connection and reports the result. */
async function serve(token: string): Promise<{
  connect: () => net.Socket
  result: Promise<{ authed: boolean; body: string }>
}> {
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-')), 's.sock')
  let settle!: (v: { authed: boolean; body: string }) => void
  const result = new Promise<{ authed: boolean; body: string }>((r) => (settle = r))

  const server = net.createServer(async (socket) => {
    const inbound = await authenticateSocket(socket, token, 300)
    if (!inbound) {
      socket.destroy()
      settle({ authed: false, body: '' })
      return
    }
    let body = ''
    inbound.on('data', (c: Buffer) => {
      body += c.toString()
      if (body.includes('\n')) settle({ authed: true, body })
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(sockPath, r))
  return { connect: () => net.connect(sockPath), result }
}

describe('MCP socket authentication', () => {
  it('rejects a client that sends no token at all', async () => {
    const { connect, result } = await serve(TOKEN)
    const c = connect()
    c.on('error', () => {})
    c.write('{"jsonrpc":"2.0","method":"tools/list","id":1}\n')
    expect((await result).authed).toBe(false)
  })

  it('rejects a wrong token', async () => {
    const { connect, result } = await serve(TOKEN)
    const c = connect()
    c.on('error', () => {})
    c.write(`AUTH ${'b'.repeat(64)}\n`)
    expect((await result).authed).toBe(false)
  })

  it('rejects a token of the right shape but wrong value, and one that is a prefix', async () => {
    for (const bad of ['AUTH \n', `AUTH ${'a'.repeat(63)}\n`, `AUTH ${'a'.repeat(65)}\n`]) {
      const { connect, result } = await serve(TOKEN)
      const c = connect()
      c.on('error', () => {})
      c.write(bad)
      expect((await result).authed, bad).toBe(false)
    }
  })

  it('accepts the right token and passes the rest of the stream through intact', async () => {
    const { connect, result } = await serve(TOKEN)
    const c = connect()
    c.on('error', () => {})
    // Auth line and first JSON-RPC frame in ONE write — the remainder after the
    // newline must not be swallowed by the handshake reader.
    c.write(`AUTH ${TOKEN}\n{"jsonrpc":"2.0","method":"tools/list","id":1}\n`)
    const r = await result
    expect(r.authed).toBe(true)
    expect(r.body).toContain('tools/list')
    expect(r.body).not.toContain('AUTH')
  })

  it('times out a peer that connects and says nothing', async () => {
    const { connect, result } = await serve(TOKEN)
    const c = connect()
    c.on('error', () => {})
    expect((await result).authed).toBe(false)
  })

  it('accepts unauthenticated clients only when no token is configured', async () => {
    const { connect, result } = await serve('')
    const c = connect()
    c.on('error', () => {})
    c.write('{"jsonrpc":"2.0","method":"tools/list","id":1}\n')
    expect((await result).authed).toBe(true)
  })
})
