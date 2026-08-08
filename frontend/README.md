# Michibiki Suimon Navi — React frontend

This package is the incremental React/TypeScript/Vite replacement UI. The legacy static application at the repository root remains intact.

From the repository root:

```powershell
npm run backend:mock
npm run dev:new-ui
```

The new UI runs at `http://localhost:5173/`. The legacy app normally runs at `http://localhost:4173/`; because ports are part of the browser origin, those two default development URLs do not share localStorage. Stage 2 uses the legacy field key/schema and provides the sequential same-origin mode below; only concurrent sharing still requires later integration.

For a same-storage compatibility check, stop the legacy dev server and run the React app sequentially on the legacy origin:

```powershell
npm run backend:mock
npm run dev:new-ui:shared-storage
```

Open `http://localhost:4173/`. Because this is exactly the legacy app's origin, it reads the same browser localStorage. This mode is sequential; a concurrent `/new/` mount is still future integration work.

Checks:

```powershell
npm run test:new-ui
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend run lint
```

Stage 2 supports viewing, selecting, mapping, inspecting, and editing field name/memo. Map creation, boundary editing, and deletion are deliberately disabled; see [`../docs/FRONTEND_ARCHITECTURE.md`](../docs/FRONTEND_ARCHITECTURE.md) and [`../docs/HANDOFF.md`](../docs/HANDOFF.md).
