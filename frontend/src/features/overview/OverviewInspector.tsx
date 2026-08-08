import { FeaturePlaceholder } from '../common/FeaturePlaceholder'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { StatusBadge } from '../../components/status/StatusBadge'

export function OverviewInspector() {
  const status = useSystemStatusStore((state) => state.status)
  const select = useSelectedEntityStore((state) => state.select)

  return (
    <FeaturePlaceholder
      title="Overview"
      summary="Active field, area, planting estimate, GNSS/drone status, latest observations, warnings, and quick actions land here."
      migrationNote="Populated from real field/GNSS/observation data starting Stage 2-3."
    >
      <ul className="status-summary-list">
        {Object.entries(status).map(([service, entry]) => (
          <li key={service}>
            <StatusBadge label={service} value={entry.value} />
            {entry.detail ? <span className="status-summary-list__detail">{entry.detail}</span> : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ghost-button"
        onClick={() => select({ type: 'field', id: 'demo-field-1' })}
      >
        Preview inspector: select a field
      </button>
    </FeaturePlaceholder>
  )
}
