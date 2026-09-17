// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ClarificationCard } from './ClarificationCard'

const clar = { id: 'clarify-format', question: 'Is this a 16:9 explainer or a 9:16 short?', options: ['16:9 explainer', '9:16 short'] }

describe('ClarificationCard (#okf-clarify-gate P1b)', () => {
  it('renders the question and the option buttons', () => {
    render(<ClarificationCard clarification={clar} onAnswer={() => {}} />)
    expect(screen.getByText(/16:9 explainer or a 9:16 short/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '16:9 explainer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '9:16 short' })).toBeTruthy()
  })

  it('clicking an option answers with that option', () => {
    const onAnswer = vi.fn()
    render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: '9:16 short' }))
    expect(onAnswer).toHaveBeenCalledWith('9:16 short')
  })

  it('typing free-text and submitting answers with the trimmed text', () => {
    const onAnswer = vi.fn()
    render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />)
    const input = screen.getByPlaceholderText(/type an answer/i)
    fireEvent.change(input, { target: { value: '  4:5 carousel  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onAnswer).toHaveBeenCalledWith('4:5 carousel')
  })

  it('a blank free-text answer cannot be submitted', () => {
    const onAnswer = vi.fn()
    render(<ClarificationCard clarification={{ id: 'q', question: 'q?' }} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('the answered state renders quietly with no inputs', () => {
    render(<ClarificationCard clarification={clar} answered onAnswer={() => {}} />)
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })
})
