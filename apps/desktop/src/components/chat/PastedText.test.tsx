// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ComposerAttachmentChips, type PastedText } from './ComposerAttachmentChips'
import { PastedTextModal } from './PastedTextModal'
import { MessagePastedChips } from './MessagePastedChips'

const noop = () => {}

function Chips({ texts }: { texts: PastedText[] }) {
  const [pendingPastedTexts, setPendingPastedTexts] = useState<PastedText[]>(texts)
  const onEdit = vi.fn()
  return (
    <ComposerAttachmentChips
      pendingImages={[]}
      setPendingImages={noop}
      pendingAssetRefs={[]}
      setPendingAssetRefs={noop}
      pendingReferenceMedia={[]}
      setPendingReferenceMedia={noop}
      pendingPastedTexts={pendingPastedTexts}
      setPendingPastedTexts={setPendingPastedTexts}
      onEditPastedText={onEdit}
      uploadingAssets={{}}
      setPreviewImage={noop}
    />
  )
}

describe('pasted-text chip (paste-to-chip)', () => {
  it('renders nothing when there is no pending content', () => {
    const { container } = render(<Chips texts={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a chip showing the char count for a pasted block', () => {
    render(<Chips texts={[{ id: 'p1', text: 'x'.repeat(1234) }]} />)
    expect(screen.getByText(/Pasted text/)).toBeTruthy()
    expect(screen.getByText(/1,234 chars/)).toBeTruthy()
  })

  it('removes the chip when its X is clicked', () => {
    render(<Chips texts={[{ id: 'p1', text: 'hello world' }]} />)
    const chip = screen.getByText(/Pasted text/).closest('div')!
    // the X is the last clickable span in the chip
    const removers = chip.querySelectorAll('span.cursor-pointer')
    fireEvent.click(removers[removers.length - 1])
    expect(screen.queryByText(/Pasted text/)).toBeNull()
  })
})

describe('PastedTextModal', () => {
  it('saves the edited draft back to the caller', () => {
    const onSave = vi.fn()
    render(<PastedTextModal text="original" onSave={onSave} onClose={noop} />)
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.value).toBe('original')
    fireEvent.change(ta, { target: { value: 'edited content' } })
    fireEvent.click(screen.getByText('Save'))
    expect(onSave).toHaveBeenCalledWith('edited content')
  })

  it('Cancel closes without saving', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<PastedTextModal text="original" onSave={onSave} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('readOnly mode shows Close, no Save, and a non-editable textarea', () => {
    render(<PastedTextModal text="sent text" readOnly onClose={noop} />)
    expect(screen.queryByText('Save')).toBeNull()
    expect(screen.getByText('Close')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).readOnly).toBe(true)
  })
})

describe('MessagePastedChips (sent-message chips)', () => {
  it('renders nothing with no chips', () => {
    const { container } = render(<MessagePastedChips chips={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a chip per block and opens a read-only viewer on click', () => {
    render(<MessagePastedChips chips={[{ id: 'p0', text: 'z'.repeat(3210) }]} />)
    const chip = screen.getByText(/3,210 chars/)
    expect(chip).toBeTruthy()
    fireEvent.click(chip)
    // viewer open, read-only (Close, no Save)
    expect(screen.getByText('Close')).toBeTruthy()
    expect(screen.queryByText('Save')).toBeNull()
  })
})
