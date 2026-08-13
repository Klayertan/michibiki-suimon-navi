import type { StatusValue } from '../../types/systemStatus'
import './StatusBadge.css'

const LABELS: Record<StatusValue, string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  unknown: 'Unknown',
  warning: 'Warning',
  not_integrated: 'Not integrated',
}

interface StatusBadgeProps {
  label: string
  value: StatusValue
}

/**
 * Never render "connected" for a subsystem that hasn't actually been queried
 * -- see types/systemStatus.ts. The dot's color is purely derived from
 * `value`; nothing here invents a status.
 */
export function StatusBadge({ label, value }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${value}`} title={LABELS[value]}>
      <span className="status-badge__dot" aria-hidden="true" />
      <span className="status-badge__label">{label}</span>
      <span className="status-badge__value">{LABELS[value]}</span>
    </span>
  )
}
