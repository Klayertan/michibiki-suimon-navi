import type { ComponentType } from 'react'
import { Navigate, Outlet, type RouteObject } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { WORKSPACES } from './workspaces'
import { OverviewInspector } from '../features/overview/OverviewInspector'
import { FieldWorkspace } from '../features/fields/FieldWorkspace'
import { SurveyInspector } from '../features/survey/SurveyInspector'
import { WaterWorkspace } from '../features/water/WaterWorkspace'
import { DroneInspector } from '../features/drone/DroneInspector'
import { AiInspector } from '../features/ai/AiInspector'
import { DataInspector } from '../features/data/DataInspector'
import { ReportsInspector } from '../features/reports/ReportsInspector'
import { SettingsInspector } from '../features/settings/SettingsInspector'

const INSPECTORS: Record<string, ComponentType> = {
  overview: OverviewInspector,
  field: FieldWorkspace,
  survey: SurveyInspector,
  water: WaterWorkspace,
  drone: DroneInspector,
  ai: AiInspector,
  data: DataInspector,
  reports: ReportsInspector,
  settings: SettingsInspector,
}

function Layout() {
  // AppShell mounts the map, top bar, sidebar and tray exactly once; only the
  // Outlet's content (the inspector) changes as the route changes -- task
  // section 4's "workspace changes without destroying the main map/shell".
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to={WORKSPACES[0].path} replace /> },
      ...WORKSPACES.map((workspace) => {
        const Inspector = INSPECTORS[workspace.id]
        return { path: workspace.path.slice(1), element: <Inspector /> }
      }),
    ],
  },
]
