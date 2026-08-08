import type { ReactNode } from 'react'
import { TopStatusBar } from './TopStatusBar'
import { Sidebar } from './Sidebar'
import { InspectorPanel } from './InspectorPanel'
import { TelemetryTray } from './TelemetryTray'
import { MapWorkspace } from '../map/MapWorkspace'
import { FieldLayer } from '../map/layers/FieldLayer'
import { SurveyLayer } from '../map/layers/SurveyLayer'
import { CurrentGnssLayer } from '../map/layers/CurrentGnssLayer'
import { LiveSurveyLayer } from '../map/layers/LiveSurveyLayer'
import { ObservationLayer } from '../map/layers/ObservationLayer'
import { ObservationPlacementLayer } from '../map/layers/ObservationPlacementLayer'
import { SurveyBoundaryPreviewLayer } from '../map/layers/SurveyBoundaryPreviewLayer'
import './AppShell.css'

interface AppShellProps {
  /** The active workspace's inspector content (the router's <Outlet/>). */
  children: ReactNode
}

/**
 * The whole Stage 1 layout (task section 3): top status bar, sidebar, one
 * persistently-mounted map, contextual inspector, collapsible tray. The map
 * is rendered here -- once -- not inside each workspace route, so switching
 * workspaces never remounts it (task section 4: "do not duplicate the map
 * independently inside every route").
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <TopStatusBar />
      <div className="app-shell__body">
        <Sidebar />
        <main className="app-shell__map">
          <MapWorkspace>
            <FieldLayer />
            <SurveyLayer />
            <LiveSurveyLayer />
            <CurrentGnssLayer />
            <ObservationLayer />
            <ObservationPlacementLayer />
            <SurveyBoundaryPreviewLayer />
          </MapWorkspace>
        </main>
        <InspectorPanel>{children}</InspectorPanel>
      </div>
      <TelemetryTray />
    </div>
  )
}
