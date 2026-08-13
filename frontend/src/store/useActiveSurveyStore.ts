import { create } from 'zustand'

interface ActiveSurveyState {
  activeSurveyId: string | null
  setActiveSurveyId: (id: string | null) => void
}

export const useActiveSurveyStore = create<ActiveSurveyState>((set) => ({
  activeSurveyId: null,
  setActiveSurveyId: (activeSurveyId) => set({ activeSurveyId }),
}))
