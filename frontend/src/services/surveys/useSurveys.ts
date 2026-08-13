import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { surveyRepository } from './legacySurveyRepository'
import type { SurveyRepositorySnapshot } from '../../domain/surveys/types'
import { recordedSurveyRepository } from '../recording/recordedSurveyRepository'

export function useSurveySnapshot(): SurveyRepositorySnapshot {
  const annotations = useSyncExternalStore(surveyRepository.subscribe, surveyRepository.getSnapshot, surveyRepository.getSnapshot)
  const recordings = useSyncExternalStore(recordedSurveyRepository.subscribe, recordedSurveyRepository.getSnapshot, recordedSurveyRepository.getSnapshot)
  useEffect(() => recordedSurveyRepository.ensureLoaded(), [])
  return useMemo(() => ({
    surveys: [...annotations.surveys, ...recordings.surveys],
    warnings: annotations.warnings,
    error: annotations.error ?? recordings.error,
    loading: recordings.loading,
  }), [annotations, recordings])
}
