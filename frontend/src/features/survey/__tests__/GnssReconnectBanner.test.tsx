import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GnssReconnectBanner } from '../GnssReconnectBanner'

describe('GnssReconnectBanner', () => {
  it('renders nothing for connected, disconnected, or stalled -- only reconnecting/reconnect_required show it', () => {
    for (const connectionState of ['connected', 'disconnected', 'stalled', 'unsupported', 'error'] as const) {
      const { container, unmount } = render(
        <GnssReconnectBanner
          connectionState={connectionState}
          reconnectAttempt={0}
          reconnectMaxAttempts={0}
          isRecording={false}
          onReconnect={vi.fn()}
          onStopRecording={vi.fn()}
        />,
      )
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('shows the attempt count while automatically reconnecting', () => {
    render(
      <GnssReconnectBanner
        connectionState="reconnecting"
        reconnectAttempt={2}
        reconnectMaxAttempts={4}
        isRecording={false}
        onReconnect={vi.fn()}
        onStopRecording={vi.fn()}
      />,
    )
    expect(screen.getByText(/Attempting reconnect… 2\/4/)).toBeInTheDocument()
  })

  it('shows a distinct message once automatic attempts are exhausted', () => {
    render(
      <GnssReconnectBanner
        connectionState="reconnect_required"
        reconnectAttempt={4}
        reconnectMaxAttempts={4}
        isRecording={false}
        onReconnect={vi.fn()}
        onStopRecording={vi.fn()}
      />,
    )
    expect(screen.getByText('Automatic reconnect unsuccessful.')).toBeInTheDocument()
  })

  it('shows "Recording remains open" and a Stop recording action only while actually recording', () => {
    const { rerender } = render(
      <GnssReconnectBanner
        connectionState="reconnecting"
        reconnectAttempt={1}
        reconnectMaxAttempts={4}
        isRecording={true}
        onReconnect={vi.fn()}
        onStopRecording={vi.fn()}
      />,
    )
    expect(screen.getByText(/Recording remains open/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()

    rerender(
      <GnssReconnectBanner
        connectionState="reconnecting"
        reconnectAttempt={1}
        reconnectMaxAttempts={4}
        isRecording={false}
        onReconnect={vi.fn()}
        onStopRecording={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Recording remains open/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument()
  })

  it('calls onReconnect and onStopRecording from their respective buttons', async () => {
    const onReconnect = vi.fn()
    const onStopRecording = vi.fn()
    render(
      <GnssReconnectBanner
        connectionState="reconnect_required"
        reconnectAttempt={4}
        reconnectMaxAttempts={4}
        isRecording={true}
        onReconnect={onReconnect}
        onStopRecording={onStopRecording}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(onReconnect).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(onStopRecording).toHaveBeenCalledOnce()
  })
})
