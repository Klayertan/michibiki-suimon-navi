import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import type { RecoverableSession } from '../../../services/recording/recordingService'
import { RecoveryPanel } from '../RecoveryPanel'

function session(overrides: Partial<RecoverableSession> = {}): RecoverableSession {
  return {
    sessionId: 'rec-1',
    startedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:05:00.000Z',
    rawLineCount: 12,
    validFixCount: 8,
    lastValidFix: { timestamp: '090500', lat: 34.65, lon: 135.83, fixQuality: 1 },
    fieldId: null,
    fieldName: null,
    ...overrides,
  }
}

function seedField(): void {
  window.localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({
    schemaVersion: 3,
    fields: [{ id: 'field-1', name: 'Linked rice field', coordinates: [], properties: {} }],
    boundaryTracks: [], waterControlPoints: [], fieldObservations: [], workflowState: {},
    surveySessions: [],
  }))
  fieldRepository.refresh()
}

describe('RecoveryPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    fieldRepository.refresh()
  })

  it('renders nothing when there are no unfinished sessions', () => {
    const { container } = render(
      <RecoveryPanel sessions={[]} inProgress={false} warning={null} onResume={vi.fn()} onFinalize={vi.fn()} onDiscard={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows session metadata including last point and unlinked field', () => {
    render(
      <RecoveryPanel sessions={[session()]} inProgress={false} warning={null} onResume={vi.fn()} onFinalize={vi.fn()} onDiscard={vi.fn()} />,
    )
    expect(screen.getByText('Unfinished recording found')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText(/34\.650000, 135\.830000/)).toBeInTheDocument()
    expect(screen.getByText('Not linked')).toBeInTheDocument()
  })

  it('shows the pluralized heading for multiple sessions', () => {
    render(
      <RecoveryPanel
        sessions={[session({ sessionId: 'rec-1' }), session({ sessionId: 'rec-2' })]}
        inProgress={false}
        warning={null}
        onResume={vi.fn()}
        onFinalize={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByText('2 unfinished recordings found')).toBeInTheDocument()
  })

  it('resolves a linked field name from useFields', () => {
    seedField()
    render(
      <RecoveryPanel
        sessions={[session({ fieldId: 'field-1' })]}
        inProgress={false}
        warning={null}
        onResume={vi.fn()}
        onFinalize={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByText('Linked rice field')).toBeInTheDocument()
  })

  it('shows a preserved-identifier fallback when the linked field no longer exists', () => {
    render(
      <RecoveryPanel
        sessions={[session({ fieldId: 'ghost-field' })]}
        inProgress={false}
        warning={null}
        onResume={vi.fn()}
        onFinalize={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByText('Linked field no longer exists (ghost-field)')).toBeInTheDocument()
  })

  it('shows "None yet" when no valid fix has been recorded', () => {
    render(
      <RecoveryPanel
        sessions={[session({ lastValidFix: null })]}
        inProgress={false}
        warning={null}
        onResume={vi.fn()}
        onFinalize={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByText('None yet')).toBeInTheDocument()
  })

  it('calls onResume with the session id', async () => {
    const onResume = vi.fn()
    render(
      <RecoveryPanel sessions={[session()]} inProgress={false} warning={null} onResume={onResume} onFinalize={vi.fn()} onDiscard={vi.fn()} />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledWith('rec-1')
  })

  it('calls onFinalize with the session id', async () => {
    const onFinalize = vi.fn()
    render(
      <RecoveryPanel sessions={[session()]} inProgress={false} warning={null} onResume={vi.fn()} onFinalize={onFinalize} onDiscard={vi.fn()} />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Finish & Save' }))
    expect(onFinalize).toHaveBeenCalledWith('rec-1')
  })

  it('requires a two-step confirmation before calling onDiscard', async () => {
    const onDiscard = vi.fn()
    render(
      <RecoveryPanel sessions={[session()]} inProgress={false} warning={null} onResume={vi.fn()} onFinalize={vi.fn()} onDiscard={onDiscard} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByText('Discard this recording permanently?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm Discard' }))
    expect(onDiscard).toHaveBeenCalledWith('rec-1')
  })

  it('cancels the discard confirmation without calling onDiscard', async () => {
    const onDiscard = vi.fn()
    render(
      <RecoveryPanel sessions={[session()]} inProgress={false} warning={null} onResume={vi.fn()} onFinalize={vi.fn()} onDiscard={onDiscard} />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.queryByText('Discard this recording permanently?')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('disables all action buttons while a recovery action is in progress', () => {
    render(
      <RecoveryPanel sessions={[session()]} inProgress={true} warning={null} onResume={vi.fn()} onFinalize={vi.fn()} onDiscard={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Finish & Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
  })

  it('renders the warning message as an alert', () => {
    render(
      <RecoveryPanel
        sessions={[session()]}
        inProgress={false}
        warning="1 unfinished recording could not be read and was skipped."
        onResume={vi.fn()}
        onFinalize={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('1 unfinished recording could not be read and was skipped.')
  })
})
