/**
 * Chat slash command system for the Dreambyte agent.
 *
 * Commands are typed as `/command [args]` in the chat input.
 * They either expand into a full agent prompt (agent-routed commands)
 * or execute directly and return a result (immediate commands).
 *
 * Usage:
 *   const result = parseCommand(userMessage)
 *   if (result) {
 *     if (result.type === 'agent') — override message/agent and run normally
 *     if (result.type === 'immediate') — execute result.execute() and return
 *   }
 */

import type { MessageContent } from './types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentCommandResult {
  type: 'agent'
  /** Expanded message to send to the agent instead of the raw command */
  message: MessageContent
  /** Run this turn in plan-first mode (the one agent wears the read-only/plan
   *  toolset until the plan is approved). Replaces the legacy planner. */
  planFirstMode?: boolean
  /** Description shown in the UI while the command runs */
  description: string
}

export interface ImmediateCommandResult {
  type: 'immediate'
  /** Execute the command and return a response message */
  execute: (ctx: CommandContext) => Promise<string> | string
  /** Description shown in the UI */
  description: string
}

export type CommandResult = AgentCommandResult | ImmediateCommandResult

export interface CommandContext {
  scenes: Array<{ id: string; name: string }>
  projectName: string
  messageHistory?: Array<{ role: string; content: any }>
}

interface CommandDefinition {
  name: string
  aliases?: string[]
  description: string
  usage: string
  parse: (args: string) => CommandResult | null
}

// ── Command Registry ────────────────────────────────────────────────────────

const commands: CommandDefinition[] = [
  {
    name: 'plan',
    description: 'Create a written plan for a topic',
    usage: '/plan <topic>',
    parse: (args) => {
      if (!args.trim()) return null
      return {
        type: 'agent',
        message: `Write a detailed plan for an explainer video about: ${args.trim()}. Plan all scenes with descriptions, durations, and visual approach. Do NOT build the scenes yet — just write the plan.`,
        planFirstMode: true,
        description: `Planning video about "${args.trim()}"`,
      }
    },
  },
  {
    name: 'style',
    description: 'Apply a style preset to the project',
    usage: '/style <preset-name>',
    parse: (args) => {
      const preset = args.trim().toLowerCase()
      if (!preset) return null
      return {
        type: 'agent',
        message: `Apply the "${preset}" style preset to this project. Set the global style, palette, font, and any relevant visual parameters for the ${preset} look.`,
        description: `Applying ${preset} style`,
      }
    },
  },
  {
    name: 'redo',
    description: 'Regenerate the last scene or layer',
    usage: '/redo [scene-name]',
    parse: (args) => {
      const target = args.trim()
      const message = target
        ? `Regenerate the scene "${target}" with a fresh approach. Keep the same concept but improve the visual quality and animation.`
        : `Regenerate the most recently created or edited scene with a fresh approach. Keep the same concept but improve the visual quality and animation.`
      return {
        type: 'agent',
        message,
        description: 'Regenerating scene',
      }
    },
  },
  {
    name: 'batch',
    description: 'Apply an instruction to all scenes',
    usage: '/batch <instruction>',
    parse: (args) => {
      if (!args.trim()) return null
      return {
        type: 'agent',
        message: `Apply the following change to ALL scenes in the project: ${args.trim()}. Process each scene one by one.`,
        description: `Batch editing: ${args.trim().slice(0, 50)}`,
      }
    },
  },
  {
    name: 'compact',
    description: 'Request session history compaction on next agent turn',
    usage: '/compact',
    parse: () => ({
      type: 'agent',
      message:
        '[SYSTEM: Force compaction on this turn. Summarize the conversation so far into a structured summary, then continue normally.]',
      description: 'Requesting session compaction',
    }),
  },
  {
    name: 'scenes',
    description: 'List all scenes in the project',
    usage: '/scenes',
    parse: () => ({
      type: 'immediate',
      description: 'Listing scenes',
      execute: (ctx) => {
        if (ctx.scenes.length === 0) return 'No scenes in this project yet.'
        return `**${ctx.scenes.length} scenes:**\n${ctx.scenes.map((s, i) => `${i + 1}. ${s.name || 'Untitled'} (${s.id.slice(0, 8)})`).join('\n')}`
      },
    }),
  },
  {
    name: 'help',
    aliases: ['commands'],
    description: 'Show available slash commands',
    usage: '/help',
    parse: () => ({
      type: 'immediate',
      description: 'Showing help',
      execute: () => {
        const lines = commands.map((cmd) => `**${cmd.usage}** — ${cmd.description}`)
        return `**Available commands:**\n${lines.join('\n')}`
      },
    }),
  },
]

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a user message to check if it's a slash command.
 * Returns null if the message is not a command.
 */
export function parseCommand(message: MessageContent): CommandResult | null {
  const text =
    typeof message === 'string'
      ? message
      : message
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join(' ')

  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  // Parse: /command args
  const spaceIdx = trimmed.indexOf(' ')
  const commandName = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase()
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : ''

  // Find matching command
  const cmd = commands.find((c) => c.name === commandName || c.aliases?.includes(commandName))

  if (!cmd) return null

  return cmd.parse(args)
}

/**
 * Get command definitions for UI display.
 */
export function getCommandDefinitions(): Array<{ name: string; description: string; usage: string }> {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    usage: c.usage,
  }))
}
