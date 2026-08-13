import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { WORKSPACES } from '../../app/workspaces'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { StatusBadge } from '../status/StatusBadge'
import './TelemetryTray.css'

// Namespaced separately from every legacy localStorage key (see
// docs/UI_REDESIGN.md section 8) -- this is new-UI-only UI preference, not
// application data, and must never collide with the legacy schema-versioned
// keys (suimonNaviFieldAnnotationsV2, suimonNaviFieldMode, etc).
const COLLAPSED_KEY = 'suisuiNaviNewUi.trayCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Collapsible per task section 3/18. Content is workspace-aware (recommended
 * layers for the active route) plus the same real drone/backend status shown
 * in the top bar, at a glance, without opening the drone workspace.
 */
export function TelemetryTray() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const location = useLocation()
  const status = useSystemStatusStore((state) => state.status)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // Best-effort only; a blocked localStorage must not break the tray.
    }
  }, [collapsed])

  const workspace = WORKSPACES.find((entry) => entry.path === location.pathname)

  return (
    <footer className={`telemetry-tray${collapsed ? ' telemetry-tray--collapsed' : ''}`}>
      <button
        type="button"
        className="telemetry-tray__toggle"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        {collapsed ? '▲' : '▼'} Telemetry &amp; layers
      </button>
      {!collapsed && (
        <div className="telemetry-tray__body">
          <div className="telemetry-tray__section">
            <span className="telemetry-tray__section-title">Recommended layers ({workspace?.label ?? '—'})</span>
            <span className="telemetry-tray__layers">
              {workspace && workspace.recommendedLayers.length > 0
                ? workspace.recommendedLayers.join(', ')
                : 'none for this workspace'}
            </span>
          </div>
          <div className="telemetry-tray__section">
            <span className="telemetry-tray__section-title">Status</span>
            <div className="telemetry-tray__badges">
              <StatusBadge label="backend" value={status.backend.value} />
              <StatusBadge label="drone" value={status.drone.value} />
            </div>
          </div>
        </div>
      )}
    </footer>
  )
}
