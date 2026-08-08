import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MapWorkspace } from '../MapWorkspace'

describe('MapWorkspace', () => {
  it('mounts a Leaflet map into its container without throwing, and tears down cleanly on unmount', () => {
    const { container, unmount } = render(<MapWorkspace />)

    const host = container.querySelector('[role="region"][aria-label="Map workspace"]')
    expect(host).not.toBeNull()
    // Leaflet stamps its own class onto the container it initializes.
    expect(host?.className).toContain('leaflet-container')

    expect(() => unmount()).not.toThrow()
  })
})
