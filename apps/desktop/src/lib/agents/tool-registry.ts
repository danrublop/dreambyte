import type { ToolResult } from './types'
import type { AgentLogger } from './logger'

export type ToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
  world: unknown,
  logger?: AgentLogger,
) => Promise<ToolResult>

class ToolRegistry {
  private handlers = new Map<string, ToolHandler>()
  private defaultHandler: ToolHandler | null = null

  register(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler)
  }

  registerMany(toolNames: string[], handler: ToolHandler): void {
    for (const toolName of toolNames) this.handlers.set(toolName, handler)
  }

  registerDefault(handler: ToolHandler): void {
    this.defaultHandler = handler
  }

  get(toolName: string): ToolHandler | null {
    return this.handlers.get(toolName) ?? this.defaultHandler
  }

  hasExplicit(toolName: string): boolean {
    return this.handlers.has(toolName)
  }

  canResolve(toolName: string): boolean {
    return this.handlers.has(toolName) || this.defaultHandler !== null
  }

  hasDefault(): boolean {
    return this.defaultHandler !== null
  }

  getRegisteredToolNames(): string[] {
    return [...this.handlers.keys()]
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    world: unknown,
    logger?: AgentLogger,
  ): Promise<ToolResult> {
    const handler = this.get(toolName)
    if (!handler) return { success: false, error: `No handler registered for tool: ${toolName}` }
    return handler(toolName, args, world, logger)
  }
}

export const toolRegistry = new ToolRegistry()
