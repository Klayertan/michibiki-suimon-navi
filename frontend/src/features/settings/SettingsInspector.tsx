import { FeaturePlaceholder } from '../common/FeaturePlaceholder'

export function SettingsInspector() {
  return (
    <FeaturePlaceholder
      title="Settings"
      summary="GNSS device, WebSerial, QZ1 configuration, drone connection, camera configuration, Jetson/backend configuration, map configuration, units, developer/debug options."
      migrationNote="Grows alongside each subsystem's migration stage rather than all at once."
    />
  )
}
