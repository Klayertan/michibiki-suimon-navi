import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldSelector } from '../FieldSelector'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.001],
  [35.001, 135.001],
]

describe('FieldSelector', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useActiveFieldStore.getState().setActiveFieldId(null)
    useSelectedEntityStore.getState().clear()
  })

  it('is disabled with a "No fields registered" option when the repository is empty', () => {
    render(<FieldSelector />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByText('No fields registered')).toBeInTheDocument()
  })

  it('choosing a field sets both activeFieldId and selectedEntity (task section 18: one consistent model)', async () => {
    const user = userEvent.setup()
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    render(<FieldSelector />)

    await user.selectOptions(screen.getByRole('combobox'), field.id)

    expect(useActiveFieldStore.getState().activeFieldId).toBe(field.id)
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'field', id: field.id })
  })

  it('lists a compact ha area alongside each field name, without a full card list', async () => {
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    render(<FieldSelector />)

    const expectedHa = (field.properties.areaM2 / 10000).toFixed(3)
    expect(screen.getByRole('option', { name: `北田 · ${expectedHa} ha` })).toBeInTheDocument()
  })
})
