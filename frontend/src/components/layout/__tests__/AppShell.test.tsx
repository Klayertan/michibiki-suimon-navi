import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AppShell } from '../AppShell'
import { WORKSPACES } from '../../../app/workspaces'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { FieldWorkspace } from '../../../features/fields/FieldWorkspace'

describe('AppShell', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useActiveFieldStore.getState().setActiveFieldId(null)
    useSelectedEntityStore.getState().clear()
  })

  it('renders the top status bar, every workspace in the sidebar, the map, the inspector content, and the tray', () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <AppShell>
          <div data-testid="inspector-content">Overview inspector</div>
        </AppShell>
      </MemoryRouter>,
    )

    expect(screen.getByText('Michibiki Suimon Navi')).toBeInTheDocument()

    for (const workspace of WORKSPACES) {
      expect(screen.getByRole('link', { name: workspace.label })).toBeInTheDocument()
    }

    expect(screen.getByRole('region', { name: /map workspace/i })).toBeInTheDocument()
    expect(screen.getByTestId('inspector-content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /telemetry & layers/i })).toBeInTheDocument()
  })

  it('the sidebar highlights the current workspace via the router, not a duplicate store', () => {
    render(
      <MemoryRouter initialEntries={['/drone']}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Drone' })).toHaveClass('sidebar__item--active')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveClass('sidebar__item--active')
  })

  it('selecting from the compact UI opens the real field inspector without remounting the map', async () => {
    const user = userEvent.setup()
    const field = await fieldRepository.create({
      name: 'Selector field',
      coordinates: [[35, 135], [35, 135.001], [35.001, 135.001]],
    })

    const { container } = render(
      <MemoryRouter initialEntries={['/field']}>
        <AppShell>
          <FieldWorkspace />
        </AppShell>
      </MemoryRouter>,
    )
    const mapNode = await waitFor(() => {
      const node = container.querySelector('.leaflet-container')
      expect(node).not.toBeNull()
      return node
    })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Select field' }), field.id)

    expect(await screen.findByRole('heading', { name: 'Selector field' })).toBeInTheDocument()
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })

  it('switching workspace content (simulating a route change) does not recreate the map or its field layer (task section 14)', async () => {
    window.localStorage.clear()
    const field = await fieldRepository.create({
      name: 'Integration field',
      coordinates: [[35, 135], [35, 135.001], [35.001, 135.001]],
    })

    const { container, rerender } = render(
      <MemoryRouter initialEntries={['/overview']}>
        <AppShell>
          <div data-testid="inspector-content">Overview inspector</div>
        </AppShell>
      </MemoryRouter>,
    )

    const mapNode = await waitFor(() => {
      const node = container.querySelector('.leaflet-container')
      expect(node).not.toBeNull()
      return node
    })
    await waitFor(() => expect(container.querySelector('.leaflet-overlay-pane path.leaflet-interactive')).not.toBeNull())

    rerender(
      <MemoryRouter initialEntries={['/field']}>
        <AppShell>
          <div data-testid="inspector-content">Field inspector</div>
        </AppShell>
      </MemoryRouter>,
    )

    expect(screen.getByTestId('inspector-content')).toHaveTextContent('Field inspector')
    // Same DOM node -- MapWorkspace's mount effect (and therefore L.map())
    // never re-ran, and the field polygon is still there without a rebuild.
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    expect(container.querySelector('.leaflet-overlay-pane path.leaflet-interactive')).not.toBeNull()

    fireEvent.click(container.querySelector('.leaflet-overlay-pane path.leaflet-interactive')!)
    await waitFor(() => {
      expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'field', id: field.id })
    })
    expect(await screen.findByRole('heading', { name: 'Integration field' })).toBeInTheDocument()
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })
})
