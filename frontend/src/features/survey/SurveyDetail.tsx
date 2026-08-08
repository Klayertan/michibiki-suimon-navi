import { findSurveyById, surveyHdopRange, surveyPointCount, surveySatelliteRange, surveyTimeRange } from '../../domain/surveys/selectors'
import { useFields } from '../../services/fields/useFields'
import { useSurveySnapshot } from '../../services/surveys/useSurveys'

interface SurveyDetailProps {
  surveyId: string
  onBack: () => void
}

export function SurveyDetail({ surveyId, onBack }: SurveyDetailProps) {
  const { surveys } = useSurveySnapshot()
  const fields = useFields()
  const survey = findSurveyById(surveys, surveyId)
  if (!survey) {
    return (
      <div className="feature-placeholder">
        <h2 className="feature-placeholder__title">Survey</h2>
        <p className="feature-placeholder__summary">This saved survey no longer exists.</p>
        <button type="button" className="ghost-button" onClick={onBack}>Back</button>
      </div>
    )
  }

  const points = survey.session?.points ?? []
  const time = surveyTimeRange(points) ?? survey.session?.uploadedAt ?? survey.session?.createdAt ?? survey.track?.createdAt
  const field = survey.fieldId ? fields.find((candidate) => candidate.id === survey.fieldId) : null
  const hdop = surveyHdopRange(survey)
  const satellites = surveySatelliteRange(survey)

  return (
    <div className="survey-detail">
      <h2 className="feature-placeholder__title">{survey.name}</h2>
      <dl className="survey-detail__list">
        <div><dt>Points</dt><dd>{surveyPointCount(survey)}</dd></div>
        {time ? <div><dt>Time</dt><dd>{time}</dd></div> : null}
        {hdop ? <div><dt>HDOP (recorded)</dt><dd>{hdop}</dd></div> : null}
        {satellites ? <div><dt>Satellites (recorded)</dt><dd>{satellites}</dd></div> : null}
        {survey.fieldId ? <div><dt>Linked field</dt><dd>{field?.name || survey.fieldId}</dd></div> : null}
        {survey.session?.sourceFileName ? <div><dt>Source</dt><dd>{survey.session.sourceFileName}</dd></div> : null}
        {survey.session?.measurementType ? <div><dt>Measurement</dt><dd>{survey.session.measurementType}</dd></div> : null}
      </dl>
      <p className="survey-detail__quality-note">
        HDOP and satellite values are shown as recorded. QZ1 assurance is a separate legacy quality system and is not reclassified here.
      </p>
      <button type="button" className="ghost-button" onClick={onBack}>Back</button>
    </div>
  )
}
