/**
 * Codex CLI as an agent backend provider.
 *
 * Spawns `codex exec --json` as a subprocess, injects the Dreambyte MCP server via
 * config overrides, and translates Codex JSONL events into the app's SSE
 * stream contract.
 */

import { spawn, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { createLogger } from '../logger'

const log = createLogger('agent.codex-cli')
import type { SSEEvent, ToolCallRecord, ToolResult, UsageStats } from './types'
import { getMcpHostConfig, type McpBridgeHandle } from './mcp-host-config'

interface CodexCliOptions {
  message: string
  systemPrompt: string
  projectId: string
  agentType?: string
  model?: string
  emit: (event: SSEEvent) => void
  abortSignal?: AbortSignal
  cwd?: string
}

interface CodexCliResult {
  fullText: string
  toolCalls: ToolCallRecord[]
  usage: UsageStats
  durationMs: number
}

interface PendingToolCall {
  toolName: string
  toolInput: Record<string, unknown>
  startedAt: number
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function maybeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function getEventType(event: Record<string, unknown>): string {
  return asString(event.type) ?? asString(event.event_msg) ?? ''
}

function getToolCallId(event: Record<string, unknown>): string | null {
  return (
    asString(event.invocation_id) ??
    asString(event.tool_call_id) ??
    asString(event.call_id) ??
    asString(event.item_id) ??
    asString(event.id)
  )
}

function getToolName(event: Record<string, unknown>): string | null {
  return asString(event.tool_name) ?? asString(event.connector_name) ?? asString(event.name)
}

function getToolInput(event: Record<string, unknown>): Record<string, unknown> {
  return (
    maybeObject(event.arguments) ??
    maybeObject(event.input) ??
    maybeObject(event.tool_input) ??
    maybeObject(event.parsed_cmd) ??
    {}
  )
}

function extractTextDelta(event: Record<string, unknown>): string {
  for (const candidate of [
    event.delta,
    event.text,
    event.chunk,
    event.reasoning_text,
    event.summary_text,
    event.content,
  ]) {
    const text = asString(candidate)
    if (text) return text
  }

  const payload = maybeObject(event.payload)
  if (payload) {
    for (const key of ['delta', 'text', 'reasoning_text', 'summary_text', 'content']) {
      const text = asString(payload[key])
      if (text) return text
    }
  }

  const items = Array.isArray(event.content_items) ? event.content_items : null
  if (!items) return ''

  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
      const obj = item as Record<string, unknown>
      return asString(obj.text) ?? asString(obj.delta) ?? asString(obj.content) ?? ''
    })
    .filter(Boolean)
    .join('')
}

function extractToolResult(event: Record<string, unknown>): ToolResult {
  const message = asString(event.error) ?? asString(event.message)
  const isError = event.is_error === true || event.isError === true || Boolean(message)
  const data = event.result ?? event.structured_content ?? event.structuredContent ?? event.output ?? event.content

  return {
    success: !isError,
    error: isError ? (message ?? 'Tool failed') : undefined,
    data,
    changes: isError
      ? undefined
      : [{ type: 'scene_updated', description: String(data ?? 'Tool completed').slice(0, 200) }],
  }
}

function updateUsage(current: UsageStats, event: Record<string, unknown>): UsageStats {
  const usage = maybeObject(event.token_usage) ?? maybeObject(event.usage) ?? maybeObject(event.total_token_usage)
  if (!usage) return current

  return {
    ...current,
    inputTokens: Number(usage.input_tokens ?? current.inputTokens) || current.inputTokens,
    outputTokens: Number(usage.output_tokens ?? current.outputTokens) || current.outputTokens,
  }
}

async function prepareCodexHome(codexHome: string) {
  await fs.mkdir(codexHome, { recursive: true })
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

  for (const file of ['auth.json', 'config.toml', 'installation_id', 'version.json'] as const) {
    try {
      await fs.copyFile(path.join(sourceHome, file), path.join(codexHome, file))
    } catch {}
  }
}

/** Check if Codex CLI is available */
export async function isCodexCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['--version'], { stdio: 'pipe', timeout: 5000 })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

/** Get Codex CLI version string */
export async function getCodexCliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('codex', ['--version'], { stdio: 'pipe', timeout: 5000 })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => {
      output += d.toString()
    })
    proc.on('close', (code) => resolve(code === 0 ? output.trim() : null))
    proc.on('error', () => resolve(null))
  })
}

export async function runWithCodexCli(opts: CodexCliOptions): Promise<CodexCliResult> {
  const { message, systemPrompt, projectId, model, emit, abortSignal, cwd = process.cwd() } = opts
  const agentType = opts.agentType ?? 'scene-maker'

  const runId = uuidv4()
  const startTime = Date.now()
  const toolCalls: ToolCallRecord[] = []
  const pendingToolCalls = new Map<string, PendingToolCall>()
  let fullText = ''
  let fullThinking = ''
  let isThinking = false

  let usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    apiCalls: 1,
    costUsd: 0,
    totalDurationMs: 0,
  }

  emit({ type: 'run_start', runId })
  emit({ type: 'agent_routed', agentType: agentType as any, routeMethod: 'override' })

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dreambyte-codex-'))
  const codexHome = path.join(tmpRoot, 'home')
  await prepareCodexHome(codexHome)

  const prompt = [
    `You are operating inside Codex CLI for Dreambyte.`,
    `Use the configured MCP tools for Dreambyte instead of shell commands whenever possible.`,
    ``,
    `<system_instructions>`,
    systemPrompt,
    `</system_instructions>`,
    ``,
    `<user_request>`,
    message,
    `</user_request>`,
  ].join('\n')

  // Resolve packaged-desktop launch + per-invocation MCP bridge. If the
  // bridge fails to start, degrade to chat-only — drop the mcp_servers.* -c
  // flags entirely. Codex still runs, just without scene-mutation tools.
  const host = getMcpHostConfig()
  let bridge: McpBridgeHandle | null = null
  try {
    if (host?.startBridge) {
      bridge = await host.startBridge()
    }
  } catch (e) {
    log.warn('failed to start MCP bridge; falling back to chat-only', { error: e })
  }
  const baseUrl = bridge?.url ?? process.env.NEXT_PUBLIC_BASE_URL ?? null
  const mcpLaunch = host?.launch ?? {
    command: 'npx',
    args: ['tsx', path.join(cwd, 'scripts', 'mcp', 'mcp-server.ts')],
  }

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
    '-c',
    'approval_policy="never"',
  ]
  if (baseUrl) {
    // Codex expects args as a JSON array literal inside the TOML-ish -c form.
    const serializedArgs = JSON.stringify(mcpLaunch.args).replace(/\\/g, '\\\\')
    const envKV = Object.entries({
      ...(mcpLaunch.env ?? {}),
      DREAMBYTE_BASE_URL: baseUrl,
      DREAMBYTE_STUDIO_URL: baseUrl,
      // Bridge auth token — only populated when we spawned a bridge. The MCP
      // adapter forwards it as `Authorization: Bearer <token>`.
      ...(bridge?.token ? { DREAMBYTE_BRIDGE_TOKEN: bridge.token } : {}),
      PROJECT_ID: projectId,
    })
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(',')
    args.push(
      '-c',
      `mcp_servers.dreambyte_studio.command="${mcpLaunch.command.replace(/"/g, '\\"')}"`,
      '-c',
      `mcp_servers.dreambyte_studio.args=${serializedArgs}`,
      '-c',
      `mcp_servers.dreambyte_studio.env={${envKV}}`,
    )
  } else {
    log.warn('Codex run starting without MCP tools (no bridge / no base URL)')
  }
  if (model) args.push('--model', model)

  const cleanup = async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    } catch {}
    if (bridge) {
      try {
        await bridge.close()
      } catch {}
      bridge = null
    }
  }

  return new Promise<CodexCliResult>((resolve, reject) => {
    let proc: ChildProcess

    try {
      proc = spawn('codex', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      })
    } catch (err) {
      void cleanup()
      reject(new Error(`Failed to spawn Codex CLI: ${(err as Error).message}`))
      return
    }

    proc.stdin?.write(prompt)
    proc.stdin?.end()

    if (abortSignal) {
      const onAbort = () => {
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 3000)
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      proc.on('close', () => abortSignal.removeEventListener('abort', onAbort))
    }

    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const event = parseJsonLine(line)
        if (!event) continue

        usage = updateUsage(usage, event)
        const type = getEventType(event)

        if (type === 'thread.started' || type === 'turn.started' || type === 'token_count') continue

        if (
          type === 'agent_reasoning_delta' ||
          type === 'reasoning_content_delta' ||
          type === 'agent_reasoning_raw_content_delta' ||
          type === 'reasoning_raw_content_delta'
        ) {
          const delta = extractTextDelta(event)
          if (!delta) continue
          if (!isThinking) {
            isThinking = true
            emit({ type: 'thinking_start' })
          }
          fullThinking += delta
          emit({ type: 'thinking_token', token: delta })
          continue
        }

        if (type === 'agent_message_delta' || type === 'agent_message_content_delta' || type === 'agent_message') {
          const delta = extractTextDelta(event)
          if (!delta) continue
          if (isThinking) {
            emit({ type: 'thinking_complete', fullThinking })
            isThinking = false
          }
          fullText += delta
          emit({ type: 'token', token: delta })
          continue
        }

        if (type === 'mcp_tool_call_begin') {
          const toolCallId = getToolCallId(event) ?? uuidv4()
          const toolName = getToolName(event) ?? 'mcp_tool'
          const toolInput = getToolInput(event)
          pendingToolCalls.set(toolCallId, { toolName, toolInput, startedAt: Date.now() })
          emit({ type: 'tool_start', toolName, toolInput })
          continue
        }

        if (type === 'mcp_tool_call_end') {
          const toolCallId = getToolCallId(event) ?? ''
          const pending = pendingToolCalls.get(toolCallId)
          const toolName = pending?.toolName ?? getToolName(event) ?? 'mcp_tool'
          const toolInput = pending?.toolInput ?? getToolInput(event)
          const toolResult = extractToolResult(event)
          pendingToolCalls.delete(toolCallId)

          const toolCall: ToolCallRecord = {
            id: toolCallId || uuidv4(),
            toolName,
            input: toolInput,
            output: toolResult,
            durationMs: pending ? Date.now() - pending.startedAt : undefined,
          }
          toolCalls.push(toolCall)

          emit({ type: 'tool_complete', toolName, toolInput, toolResult })
          if (
            toolResult.success &&
            /create_scene|add_layer|verify_scene|delete_scene|patch_layer|scene_props/i.test(toolName)
          ) {
            emit({ type: 'state_change', changes: toolResult.changes })
          }
          emit({
            type: 'run_progress',
            runProgress: {
              toolCallsUsed: toolCalls.length,
              toolCallsMax: 25,
              costUsd: usage.costUsd,
              costMax: 2.0,
              iteration: toolCalls.length,
              iterationMax: 25,
            },
          })
          continue
        }

        if (type === 'error' || type === 'stream_error') {
          const message = asString(event.message) ?? asString(event.error) ?? 'Codex CLI error'
          emit({ type: 'error', error: message })
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.error('stderr from codex-cli', { extra: { text } })
    })

    proc.on('close', async (code) => {
      const durationMs = Date.now() - startTime
      usage.totalDurationMs = durationMs

      if (isThinking) {
        emit({ type: 'thinking_complete', fullThinking })
      }

      emit({
        type: 'done',
        agentType: agentType as any,
        modelId: 'codex-cli' as any,
        fullText: fullText.trim(),
        toolCalls,
        usage,
      })

      if (code !== 0 && code !== null && !fullText && toolCalls.length === 0) {
        emit({ type: 'error', error: `Codex CLI exited with code ${code}` })
      }

      await cleanup()
      resolve({ fullText: fullText.trim(), toolCalls, usage, durationMs })
    })

    proc.on('error', async (err) => {
      await cleanup()
      emit({ type: 'error', error: `Codex CLI process error: ${err.message}` })
      reject(err)
    })
  })
}
