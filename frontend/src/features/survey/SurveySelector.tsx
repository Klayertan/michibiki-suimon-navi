import { useSurveySnapshot } from '../../services/surveys/useSurveys'
import { useActiveSurveyStore } from '../../store/useActiveSurveyStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'

export function SurveySelector() {
  const { surveys } = useSurveySnapshot()
  const activeSurveyId = useActiveSurveyStore((state) => state.activeSurveyId)
  const setActiveSurveyId = useActiveSurveyStore((state) => state.setActiveSurveyId)
  const select = useSelectedEntityStore((state) => state.select)
  const clear = useSelectedEntityStore((state) => state.clear)

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value
    setActiveSurveyId(id || null)
    if (id) select({ type: 'survey', id })
    else clear()
  }

  return (
    <select
      className="survey-selector"
      aria-label="Select survey or session"
      value={activeSurveyId ?? ''}
      onChange={handleChange}
      disabled={surveys.length === 0}
    >
      <option value="">{surveys.length === 0 ? 'No saved surveys' : 'Select a survey or session…'}</option>
      {surveys.map((survey) => (
        <option key={survey.id} value={survey.id}>
          {survey.name}
        </option>
      ))}
    </select>
  )
}
