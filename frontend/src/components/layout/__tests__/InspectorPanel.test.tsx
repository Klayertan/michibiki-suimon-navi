import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InspectorPanel } from '../InspectorPanel'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  useSelectedEntityStore.setState({ selectedEntity: null })
})

describe('InspectorPanel', () => {
  it('renders the workspace content (children) when nothing is selected', () => {
    render(
      <InspectorPanel>
        <div data-testid="workspace-content">Overview content</div>
      </InspectorPanel>,
    )
    expect(screen.getByTestId('workspace-content')).toBeInTheDocument()
  })

  it('replaces the workspace content with the selection card once something is selected, regardless of workspace', () => {
    useSelectedEntityStore.getState().select({ type: 'mission', id: 'mission-1' })

    render(
      <InspectorPanel>
        <div data-testid="workspace-content">Overview content</div>
      </InspectorPanel>,
    )

    expect(screen.queryByTestId('workspace-content')).not.toBeInTheDocument()
    expect(screen.getByText('Mission')).toBeInTheDocument()
    expect(screen.getByText('mission-1')).toBeInTheDocument()
  })

  it('"Clear selection" restores the workspace content', async () => {
    useSelectedEntityStore.getState().select({ type: 'mission', id: 'mission-1' })
    const user = userEvent.setup()

    render(
      <InspectorPanel>
        <div data-testid="workspace-content">Overview content</div>
      </InspectorPanel>,
    )

    await user.click(screen.getByRole('button', { name: /clear selection/i }))

    expect(screen.getByTestId('workspace-content')).toBeInTheDocument()
    expect(useSelectedEntityStore.getState().selectedEntity).toBeNull()
  })

  it('a field selection renders the real FieldInspector (task section 12), not the generic placeholder', async () => {
    const field = await fieldRepository.create({
      name: '北田',
      coordinates: [[35, 135], [35, 135.001], [35.001, 135.001]],
    })
    useSelectedEntityStore.getState().select({ type: 'field', id: field.id })

    render(
      <InspectorPanel>
        <div data-testid="workspace-content">Field workspace content</div>
      </InspectorPanel>,
    )

    expect(screen.queryByTestId('workspace-content')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '北田' })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('workspace-content')).toBeInTheDocument()
    expect(useSelectedEntityStore.getState().selectedEntity).toBeNull()
  })
})
