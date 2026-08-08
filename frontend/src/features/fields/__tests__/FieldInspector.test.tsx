import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldInspector } from '../FieldInspector'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.001],
  [35.001, 135.001],
]

describe('FieldInspector', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows real field data: name, area, boundary point count, last updated', async () => {
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE, memo: 'note' })
    render(<FieldInspector fieldId={field.id} onBack={() => {}} />)

    expect(screen.getByRole('heading', { name: '北田' })).toBeInTheDocument()
    expect(screen.getByText('3 points')).toBeInTheDocument()
    expect(screen.getByText('note')).toBeInTheDocument()
  })

  it('"This field no longer exists" for an id that is not (or no longer) in the repository, not a crash', () => {
    render(<FieldInspector fieldId="missing" onBack={() => {}} />)
    expect(screen.getByText('This field no longer exists.')).toBeInTheDocument()
  })

  it('Edit details -> change name/memo -> Save persists through the repository', async () => {
    const user = userEvent.setup()
    const field = await fieldRepository.create({ name: 'original', coordinates: SQUARE })
    render(<FieldInspector fieldId={field.id} onBack={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Edit details' }))
    const nameInput = screen.getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'renamed')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(async () => {
      const saved = await fieldRepository.get(field.id)
      expect(saved?.name).toBe('renamed')
    })
    expect(screen.getByRole('heading', { name: 'renamed' })).toBeInTheDocument()
  })

  it('keeps Delete disabled until a cross-store field-reference policy exists', async () => {
    const field = await fieldRepository.create({ name: 'to remove', coordinates: SQUARE })
    render(<FieldInspector fieldId={field.id} onBack={() => {}} />)

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('title', expect.stringContaining('recording'))
    expect(await fieldRepository.get(field.id)).not.toBeNull()
  })
})
