import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CompactToolCall } from './CompactToolCall'
import type { ToolCallRecord } from '@/lib/agents/types'

function call(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id: 'c1', toolName: 'generate_video', input: {}, ...over } as ToolCallRecord
}

describe('CompactToolCall — A7 collapsed error reason', () => {
  it('shows the output.error one-liner when collapsed (no need to expand)', () => {
    render(<CompactToolCall call={call({ output: { success: false, error: 'veo3 quota exceeded' } as any })} />)
    // Header badge…
    expect(screen.getByText('Error')).toBeTruthy()
    // …AND the collapsed reason line.
    expect(screen.getByText('veo3 quota exceeded')).toBeTruthy()
  })

  it('does NOT show the reason for a successful call', () => {
    render(<CompactToolCall call={call({ output: { success: true } as any })} />)
    expect(screen.queryByText('Error')).toBeNull()
  })

  it('an aborted (user Stop) call shows Cancelled, not the error reason', () => {
    render(
      <CompactToolCall
        call={call({ output: { success: false, aborted: true, error: 'Run aborted by user' } as any })}
      />,
    )
    expect(screen.getByText('Cancelled')).toBeTruthy()
    // The red error reason line is suppressed for aborted (it's not an error).
    expect(screen.queryByText('Run aborted by user')).toBeNull()
  })

  it('still expands to show full output on click (regression)', () => {
    render(<CompactToolCall call={call({ output: { success: false, error: 'boom' } as any })} />)
    fireEvent.click(screen.getByText('Generating video clip'))
    expect(screen.getByText('Input')).toBeTruthy()
    expect(screen.getByText('Output')).toBeTruthy()
  })
})
