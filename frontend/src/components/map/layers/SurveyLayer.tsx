import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { BOUNDARY_TRACK_STYLE } from '@legacy/fields/field-annotation-core.js'
import { useSurveySnapshot } from '../../../services/surveys/useSurveys'
import { useActiveSurveyStore } from '../../../store/useActiveSurveyStore'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useMapInstance } from '../MapContext'
import { toLeafletLatLngs } from './surveyCoordinates'

const ACTIVE_SURVEY_STYLE: L.PathOptions = { ...BOUNDARY_TRACK_STYLE, color: '#38bdf8', weight: 5 }

export function SurveyLayer() {
  const map = useMapInstance()
  const { surveys } = useSurveySnapshot()
  const activeSurveyId = useActiveSurveyStore((state) => state.activeSurveyId)
  const setActiveSurveyId = useActiveSurveyStore((state) => state.setActiveSurveyId)
  const select = useSelectedEntityStore((state) => state.select)
  const visible = useMapLayersStore((state) => state.visibility['survey-track'])
  const groupRef = useRef<L.LayerGroup | null>(null)
  const pathsBySurveyId = useRef(new Map<string, L.Polyline>())
  const hasFittedOnce = useRef(false)

  useEffect(() => {
    if (!map) return
    const group = L.layerGroup()
    const paths = pathsBySurveyId.current
    groupRef.current = group
    return () => {
      group.remove()
      groupRef.current = null
      paths.clear()
    }
  }, [map])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    group.clearLayers()
    pathsBySurveyId.current.clear()
    for (const survey of surveys) {
      if (survey.displayCoordinates.length < 2) continue
      const path = L.polyline(
        toLeafletLatLngs(survey.displayCoordinates),
        survey.id === activeSurveyId ? ACTIVE_SURVEY_STYLE : (BOUNDARY_TRACK_STYLE as L.PathOptions),
      )
      path.bindTooltip(survey.name, { sticky: true })
      path.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        setActiveSurveyId(survey.id)
        select({ type: 'survey', id: survey.id })
      })
      path.addTo(group)
      pathsBySurveyId.current.set(survey.id, path)
    }
  }, [map, surveys, activeSurveyId, select, setActiveSurveyId])

  useEffect(() => {
    if (!hasFittedOnce.current) {
      hasFittedOnce.current = true
      return
    }
    if (!map || !activeSurveyId) return
    const path = pathsBySurveyId.current.get(activeSurveyId)
    if (path) map.fitBounds(path.getBounds(), { maxZoom: 18, padding: [32, 32] })
  }, [map, activeSurveyId])

  return null
}
