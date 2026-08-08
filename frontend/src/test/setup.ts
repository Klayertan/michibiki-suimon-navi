import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// vitest's config here does not set `test.globals: true`, so
// @testing-library/react's own auto-cleanup (which looks for a *global*
// afterEach) never registers. Do it explicitly instead, or every test file
// that renders more than one component accumulates DOM across tests.
afterEach(cleanup)
