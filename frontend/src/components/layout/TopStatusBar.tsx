import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { StatusBadge } from '../status/StatusBadge'
import type { ServiceId } from '../../types/systemStatus'
import './TopStatusBar.css'

const ORDER: ServiceId[] = ['gnss', 'serial', 'recording', 'drone', 'camera', 'backend']

/**
 * Compact, persistent, always visible -- task section 7. Every badge here is
 * driven by useSystemStatusStore. Backend/drone and Stage 3B GNSS/serial/
 * recording are wired to real services; camera remains not_integrated.
 */
export function TopStatusBar() {
  const status = useSystemStatusStore((state) => state.status)

  return (
    <header className="top-status-bar">
      <div className="top-status-bar__brand">Michibiki Suimon Navi</div>
      <div className="top-status-bar__badges">
        {ORDER.map((service) => (
          <StatusBadge key={service} label={service} value={status[service].value} />
        ))}
      </div>
    </header>
  )
}
