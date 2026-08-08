import type { MapLayerId } from '../store/useMapLayersStore'

export interface WorkspaceDescriptor {
  id: string
  path: string
  label: string
  /** One-line description shown in the sidebar tooltip / overview. */
  summary: string
  /** Layers this workspace suggests turning on. Stage 1: descriptive only, not yet wired to real layers. */
  recommendedLayers: MapLayerId[]
}

// Order here drives both the sidebar nav order and the route table in
// app/routes.tsx -- keep them in sync if a workspace is added or reordered.
export const WORKSPACES: WorkspaceDescriptor[] = [
  {
    id: 'overview',
    path: '/overview',
    label: 'Overview',
    summary: 'Active field, GNSS/drone status, latest observations, warnings.',
    recommendedLayers: ['field-boundary', 'gnss-position', 'drone-position'],
  },
  {
    id: 'field',
    path: '/field',
    label: 'Field',
    summary: 'Boundary, area, metadata, planting density.',
    recommendedLayers: ['field-boundary'],
  },
  {
    id: 'survey',
    path: '/survey',
    label: 'Survey',
    summary: 'GNSS connection, recording, boundary/observation capture.',
    recommendedLayers: ['field-boundary', 'survey-track', 'gnss-position'],
  },
  {
    id: 'water',
    path: '/water',
    label: 'Water',
    summary: 'Water level, sluice/gate locations, irrigation decisions.',
    recommendedLayers: ['field-boundary', 'water-points'],
  },
  {
    id: 'drone',
    path: '/drone',
    label: 'Drone',
    summary: 'Pixhawk/MAVLink telemetry, mission planning.',
    recommendedLayers: ['field-boundary', 'drone-position', 'mission-grid'],
  },
  {
    id: 'ai',
    path: '/ai',
    label: 'AI Inspection',
    summary: 'Camera preview and weed/pest/disease detections.',
    recommendedLayers: ['field-boundary', 'observations'],
  },
  {
    id: 'data',
    path: '/data',
    label: 'Data',
    summary: 'Recorded sessions, observations, imports/exports.',
    recommendedLayers: ['field-boundary'],
  },
  {
    id: 'reports',
    path: '/reports',
    label: 'Reports',
    summary: 'Field, survey-quality, water, and decision reports.',
    recommendedLayers: ['field-boundary'],
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    summary: 'Device, connection, and map/unit configuration.',
    recommendedLayers: [],
  },
]
