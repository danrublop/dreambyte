#!/usr/bin/env node
/**
 * Thin MCP socket CLI — same wire protocol as scripts/mcp/mcp-connect.js, but
 * fire-one-tool-and-exit so we can drive the dreambyte MCP from Bash
 * when Claude Code's in-session MCP connection has dropped.
 *
 * Usage:
 *   node scripts/mcp/mcp-call.mjs <tool_name> '{"jsonArgs": "..."}'
 *
 * Args JSON may be omitted for parameterless tools.
 */
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'

const SOCKET = path.join(os.homedir(), '.dreambyte', 'mcp.sock')
const TIMEOUT_MS = 30_000

const tool = process.argv[2]
const argsJson = process.argv[3] ?? '{}'
if (!tool) {
  process.stderr.write('Usage: node scripts/mcp/mcp-call.mjs <tool_name> [jsonArgs]\n')
  process.exit(64)
}
let args
try {
  args = JSON.parse(argsJson)
} catch (e) {
  process.stderr.write(`Bad JSON args: ${(e instanceof Error ? e.message : String(e))}\n`)
  process.exit(65)
}

const socket = net.connect(SOCKET)
let buf = ''
let initSent = false
let callSent = false

const timer = setTimeout(() => {
  process.stderr.write(`Timeout after ${TIMEOUT_MS}ms\n`)
  process.exit(74)
}, TIMEOUT_MS)

socket.on('connect', () => {
  socket.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-call', version: '1.0' },
      },
    }) + '\n',
  )
  initSent = true
})

socket.on('error', (err) => {
  process.stderr.write(`Socket error: ${err.message}\n`)
  process.exit(75)
})

socket.on('data', (chunk) => {
  buf += chunk.toString()
  if (process.env.MCP_DEBUG) process.stderr.write(`[recv] ${chunk.toString().slice(0, 200)}\n`)
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) {
      if (process.env.MCP_DEBUG) process.stderr.write(`[parse-err] ${e.message} line=${line.slice(0, 100)}\n`)
      continue
    }
    if (process.env.MCP_DEBUG) process.stderr.write(`[msg] id=${msg.id} hasResult=${!!msg.result} hasError=${!!msg.error}\n`)
    if (msg.id === 1 && msg.result && initSent && !callSent) {
      socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      socket.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }) + '\n',
      )
      callSent = true
      continue
    }
    if (msg.id === 2) {
      clearTimeout(timer)
      if (msg.error) {
        process.stdout.write(JSON.stringify(msg.error, null, 2) + '\n')
        process.exit(1)
      }
      const content = msg.result?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') process.stdout.write(c.text + '\n')
          else process.stdout.write(JSON.stringify(c) + '\n')
        }
      } else {
        process.stdout.write(JSON.stringify(msg.result, null, 2) + '\n')
      }
      socket.destroy()
      process.exit(0)
    }
  }
})
