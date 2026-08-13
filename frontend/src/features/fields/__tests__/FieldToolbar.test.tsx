import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldToolbar } from '../FieldToolbar'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'

const TRIANGLE: [number, number][] = [
  [35, 135],
  [35, 135.001],
  [35.001, 135.001],
]

describe('FieldToolbar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useActiveFieldStore.getState().setActiveFieldId(null)
  })

  it('keeps optional creation and boundary editing visibly deferred to Stage 2B', () => {
    render(<FieldToolbar />)

    expect(screen.getByRole('button', { name: 'New Field' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New Field' })).toHaveAttribute('title', expect.stringContaining('Stage 2B'))
    expect(screen.getByRole('button', { name: 'Edit Boundary' })).toBeDisabled()
  })

  it('keeps deletion disabled even with an active field because references exist outside the annotation store', async () => {
    const field = await fieldRepository.create({ name: 'existing', coordinates: TRIANGLE })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    render(<FieldToolbar />)

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('title', expect.stringContaining('cross-store'))
  })
})
