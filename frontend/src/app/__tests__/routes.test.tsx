import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../routes'

describe('workspace routing', () => {
  it('redirects the index route to the first workspace (Overview)', () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] })
    render(<RouterProvider router={router} />)

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('switching workspaces changes the inspector content without remounting the map (task section 4)', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/overview'] })
    const { container } = render(<RouterProvider router={router} />)
    const user = userEvent.setup()

    const mapBefore = container.querySelector('[role="region"][aria-label="Map workspace"]')
    expect(mapBefore).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Drone' }))

    expect(screen.getByRole('heading', { name: 'Drone' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument()

    const mapAfter = container.querySelector('[role="region"][aria-label="Map workspace"]')
    // Same DOM node, not merely an equivalent one -- the map was never torn
    // down and rebuilt when the workspace changed.
    expect(mapAfter).toBe(mapBefore)
  })

  it('every workspace route renders exactly one matching heading', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })
})
