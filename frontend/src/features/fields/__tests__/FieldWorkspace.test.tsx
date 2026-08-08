import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldWorkspace } from '../FieldWorkspace'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.001],
  [35.001, 135.001],
]
const LOCAL_STORAGE_KEY = 'suimonNaviFieldAnnotationsV2'

function notifyFieldStorageChanged() {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: LOCAL_STORAGE_KEY,
      storageArea: window.localStorage,
    }),
  )
}

describe('FieldWorkspace', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useActiveFieldStore.getState().setActiveFieldId(null)
  })

  it('shows an empty state, not an error, when no fields are registered', () => {
    render(<FieldWorkspace />)
    expect(screen.getByText(/Nothing registered yet/)).toBeInTheDocument()
    expect(screen.getByText(/creation is deferred to Stage 2B/i)).toBeInTheDocument()
  })

  it('surfaces malformed persistence as an error instead of an ordinary empty state', () => {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, '{not json')
    notifyFieldStorageChanged()

    render(<FieldWorkspace />)

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read/i)
    expect(screen.queryByText(/Nothing registered yet/)).not.toBeInTheDocument()
    expect(window.localStorage.getItem(LOCAL_STORAGE_KEY)).toBe('{not json')
  })

  it('shows the active field summary once one is set, and no empty-state message', async () => {
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    useActiveFieldStore.getState().setActiveFieldId(field.id)

    render(<FieldWorkspace />)

    expect(screen.queryByText(/Nothing registered yet/)).not.toBeInTheDocument()
    // '北田' also appears in the toolbar's <FieldSelector> <option>; the
    // summary card renders it in a <dd>.
    expect(screen.getByText('北田', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText(/points/)).toBeInTheDocument()
  })
})
