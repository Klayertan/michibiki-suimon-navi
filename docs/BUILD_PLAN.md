# Build Plan

Roadmap detail for the app itself; fieldwork/drone plans live in the README.

## July — core loop (done)

- [x] Pivot the app shell from Michibiki Pond Map to Suimon Navi (Japanese-first UI).
- [x] Static JSON skeleton: `data/field.json` (boundary / channel / gate), `data/gate_rules.json` (thresholds), `data/weather.json` (weather input), with embedded fallbacks so `file://` still works.
- [x] Field layer: boundary polygon, channel polyline, gate marker.
- [x] Survey tagging re-scoped from pond statuses to field features (水門 / 畦 / 水路 / 圃場の角 / その他); export/import schema uses `feature`.
- [x] Core loop end-to-end: QZ1 NMEA → parsed GGA point on map → tag as 水門 → becomes the app's gate location.
- [x] Gate decision panel: 開ける / 閉める / 様子見 from weather inputs + farmer-tunable thresholds.
- [x] QZ1 live recording via Web Serial (PC Chrome/Edge): serial monitor tail, live GGA plotting, raw `.nmea` download, screen Wake Lock while connected; graceful fallback message on phones.
- [x] Leaflet.markercluster for logs >400 points (1Hz surveys); Turf.js field-area display (m² / 反).
- [x] Responsive pass: verified at 412×915 (Pixel 6a), 390×844 (iPhone), and 1280×800 desktop — no horizontal overflow, ≥40px touch targets, `dvh` heights, safe-area insets.

## August — real data

- [ ] Replace placeholder `field.json` geometry with the walked QZ1 survey (with companion, after consent).
- [ ] Record real thresholds from the grandfather interview into `gate_rules.json` (keep his reasoning in `description`).
- [ ] Capture a real SLAS-augmented log (fix=2) and keep it in `data/samples/` as demo evidence.
- [ ] Phone-vs-QZ1 comparison capture on site for the accuracy story.

## Stretch

- [ ] Drone payload survey data (post school test + field consent).
- [ ] Weather auto-fill from a forecast API (design stays static-JSON-first; API only overwrites the same inputs).
- [ ] Derive field boundary polygon from 畦-tagged survey points.

## Known constraints

- No cloud DB / login — static JSON only, by design (完成度 focus).
- SLAS is a conditional upside; every feature must degrade gracefully to fix=1 data.
- App advises only; gate operation stays manual (liability + hackathon fit).
