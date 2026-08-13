import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { recordingService } from '../../../services/recording/recordingService'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useMapInstance } from '../MapContext'

interface LiveTrackSource {
  subscribeLiveTrack: typeof recordingService.subscribeLiveTrack
}

export function LiveSurveyLayer({ service = recordingService }: { service?: LiveTrackSource }) {
  const map = useMapInstance()
  const visible = useMapLayersStore((state) => state.visibility['survey-track'])
  const groupRef = useRef<L.LayerGroup | null>(null)
  const pathRef = useRef<L.Polyline | null>(null)

  useEffect(() => {
    if (!map) return
    const group = L.layerGroup()
    groupRef.current = group
    const unsubscribe = service.subscribeLiveTrack((event) => {
      if (event.type === 'start' || event.type === 'stop') {
        pathRef.current?.remove()
        pathRef.current = null
        return
      }
      if (!pathRef.current) {
        pathRef.current = L.polyline([[event.point.lat, event.point.lon]], { color: '#e11d48', weight: 4 }).addTo(group)
        pathRef.current.bindTooltip('Live recording')
      } else {
        pathRef.current.addLatLng([event.point.lat, event.point.lon])
      }
    })
    return () => {
      unsubscribe()
      group.remove()
      groupRef.current = null
      pathRef.current = null
    }
  }, [map, service])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  return null
}
