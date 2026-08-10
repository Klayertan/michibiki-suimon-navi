import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { routes } from './routes'
import { useDroneBackendStatus } from '../services/drone/useDroneBackendStatus'
import { useActiveFieldReconciliation } from '../services/fields/useActiveField'
import { useGnssRuntime } from '../services/gnss/useGnssRuntime'
import { useWakeLockRuntime } from '../services/wakeLock/useWakeLockRuntime'

// import.meta.env.BASE_URL follows Vite's `base` build option, so building
// this app with `--base=/new/` (for a future same-origin production mount
// alongside the legacy app -- see docs/FRONTEND_ARCHITECTURE.md) just works
// without touching this file.
const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL })

export function App() {
  // Mounted once, outside the router, so real backend/drone status keeps
  // updating no matter which workspace is active -- acceptance criterion #11.
  useDroneBackendStatus()
  // Same reasoning: activeFieldId must self-heal after an external store
  // change whichever workspace the operator is looking at.
  useActiveFieldReconciliation()
  useGnssRuntime()
  useWakeLockRuntime()

  return <RouterProvider router={router} />
}
