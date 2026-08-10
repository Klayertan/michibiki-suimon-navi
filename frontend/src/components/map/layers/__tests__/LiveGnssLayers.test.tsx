import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import L from 'leaflet'
import type { GnssSerialSnapshot, LiveGnssFix } from '../../../../services/gnss/serialGnssService'
import type { LiveTrackEvent } from '../../../../services/recording/recordingService'
import { fieldRepository } from '../../../../services/fields/legacyFieldRepository'
import { MapWorkspace } from '../../MapWorkspace'
import { FieldLayer } from '../FieldLayer'
import { CurrentGnssLayer } from '../CurrentGnssLayer'
import { LiveSurveyLayer } from '../LiveSurveyLayer'

function fix(lat: number, lon: number): LiveGnssFix {
  return { id: 'live', lat, lon, timestamp: '120000', timestampUtcMs: null, fixQuality: 2, fixValid: true, satellites: 12, hdop: 0.8, altitudeMsl: 10, augmented: true, receivedAtMs: Date.now(), rawLine: '$GNGGA,...' }
}

function currentSource() {
  let snapshot: GnssSerialSnapshot = { connectionState: 'connected', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: 'test', reconnectAttempt: 0, reconnectMaxAttempts: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: (currentFix: LiveGnssFix | null) => { snapshot = { ...snapshot, currentFix }; listeners.forEach((listener) => listener()) },
  }
}

function trackSource() {
  const listeners = new Set<(event: LiveTrackEvent) => void>()
  return {
    subscribeLiveTrack: (listener: (event: LiveTrackEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: (event: LiveTrackEvent) => listeners.forEach((listener) => listener(event)),
  }
}

describe('live GNSS map layers', () => {
  beforeEach(() => window.localStorage.clear())

  it('updates the current marker locally without recreating the map', async () => {
    const source = currentSource()
    const circleSpy = vi.spyOn(L, 'circleMarker')
    const { container } = render(<MapWorkspace><CurrentGnssLayer service={source} /></MapWorkspace>)
    const mapNode = container.querySelector('.leaflet-container')
    source.emit(fix(34.65, 135.83))
    await waitFor(() => expect(circleSpy).toHaveBeenCalledOnce())
    const marker = circleSpy.mock.results[0].value
    expect(marker.getLatLng()).toMatchObject({ lat: 34.65, lng: 135.83 })
    source.emit(fix(34.651, 135.831))
    await waitFor(() => expect(marker.getLatLng()).toMatchObject({ lat: 34.651, lng: 135.831 }))
    expect(circleSpy).toHaveBeenCalledOnce()
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })

  it('draws and clears a live recording beside FieldLayer on the same map', async () => {
    await fieldRepository.create({ name: 'Field', coordinates: [[34.65, 135.83], [34.65, 135.84], [34.66, 135.84]] })
    const source = trackSource()
    const { container } = render(<MapWorkspace><FieldLayer /><LiveSurveyLayer service={source} /></MapWorkspace>)
    const mapNode = container.querySelector('.leaflet-container')
    source.emit({ type: 'start' })
    source.emit({ type: 'point', point: fix(34.65, 135.83) })
    source.emit({ type: 'point', point: fix(34.651, 135.831) })
    await waitFor(() => expect(container.querySelector('path[stroke="#e11d48"]')).not.toBeNull())
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(2)
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    source.emit({ type: 'stop' })
    await waitFor(() => expect(container.querySelector('path[stroke="#e11d48"]')).toBeNull())
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(1)
  })

  it('starts a fresh live segment on resume without recreating the map or duplicating the track', async () => {
    const source = trackSource()
    const { container } = render(<MapWorkspace><LiveSurveyLayer service={source} /></MapWorkspace>)
    const mapNode = container.querySelector('.leaflet-container')

    source.emit({ type: 'start' })
    source.emit({ type: 'point', point: fix(34.65, 135.83) })
    await waitFor(() => expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(1))
    const preCrashPath = container.querySelector('path[stroke="#e11d48"]')

    // Simulated crash + reload + Resume: recordingService.resumeRecovery()
    // fires a 'start' event for the resumed session (see recordingService.ts),
    // which must clear the stale in-memory polyline rather than append to it --
    // the persisted portion already reloaded from storage lives on SurveyLayer,
    // not here.
    source.emit({ type: 'start' })
    await waitFor(() => expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(0))

    source.emit({ type: 'point', point: fix(34.652, 135.832) })
    await waitFor(() => expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(1))
    const resumedPath = container.querySelector('path[stroke="#e11d48"]')

    expect(resumedPath).not.toBeNull()
    expect(resumedPath).not.toBe(preCrashPath)
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })
})
