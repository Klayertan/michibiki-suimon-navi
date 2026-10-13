# AGENTS.md

Instructions for **every** AI coding agent working in this repository (Claude Code, Codex, or any other).
`CLAUDE.md` imports this file, so there is one set of rules, not two.

## 1. Start of every session

1. Read this file.
2. Read the **last 5 entries** of [`docs/AGENT_LOG.md`](docs/AGENT_LOG.md). That is the running record of what changed and why.
3. Run `git status` and `git branch --show-current`. Several branches and worktrees are in use at once, so never assume you are on `main`.

## 2. End of every task that changes files: update the log

Before you commit, append one entry to the **bottom** of `docs/AGENT_LOG.md`, in the same commit as the change. Use this template:

```markdown
## YYYY-MM-DD — short title
- **Agent:** Claude Code / Codex / other (model if known)
- **Branch:** branch name
- **What changed:** the files or areas touched, in plain words
- **Why:** the reason or the user's request
- **Verified:** what you ran and the result, or "not verified" and why
- **Open / next:** unfinished work, known problems, decisions waiting on the user
```

Rules for the log:

- **Append only.** Never edit or delete another entry. If an old entry is wrong, add a new one that corrects it.
- Keep an entry under about 12 lines. Link to a doc for detail.
- Record decisions the user made in chat, including hardware and plan decisions. They are not in the code, so the log is the only place the next agent can find them.
- Say plainly when something is untested. Do not write "works" for something you did not run.
- No entry is needed for a session that only read files.

The file is merged with `merge=union` (see `.gitattributes`), so entries added on two branches both survive a merge without a conflict. That only holds if entries are appended and never rewritten.

## 3. Git workflow

After completing any task that modifies repository files:

1. Review `git status` and `git diff`.
2. Run the relevant tests, linting, type checks, or build validation for the files changed.
3. If validation succeeds, automatically create a Git commit without waiting for the user to ask.
4. Commit only files related to the current task.
5. Never include unrelated pre-existing changes.
6. Use a concise, descriptive Conventional Commit message, such as:
   - `feat: ...`
   - `fix: ...`
   - `refactor: ...`
   - `docs: ...`
   - `test: ...`
   - `chore: ...`
7. After committing, report the commit SHA and commit message.
8. Never push to GitHub unless the user explicitly asks to push.
9. Never force-push.
10. If tests fail, fix the failure first. Do not commit known-broken code unless the user explicitly requests a WIP commit.
11. If the repository was already dirty before the task, preserve unrelated pre-existing changes and do not stage them.
12. If the task only involves investigation, explanation, or reading files and nothing was changed, do not create an empty commit.

## 4. Project in brief

SuisuiNavi (スイスイナビ / 水門ナビ) is a decision-support web app for rice-paddy water management, built for the Michibiki (QZSS) hackathon and now aimed at the Kobe SII forum (since 2026-10-13). A QZ1 GNSS receiver measures the field boundary. The app turns growth stage, area, water level and weather into a recommended depth, a water volume and an open/close/wait gate verdict. The farmer operates the gate; the app never does.

- **Frontend:** plain HTML/CSS/JS, no bundler. `index.html` is one very large file shared by every feature, so keep edits to it small and put new logic in modules under `js/`.
- **Drone:** `backend/` (FastAPI + pymavlink), `js/drone/`, `js/pilot/`, `js/gamepad/`, flight-path planner in `js/paddy-intelligence.js`, Jetson + RealSense in `edge/perception/`.
- **Water model:** `js/water/` (pure modules, unit-tested).
- **Cloud:** `cloud_backend/` (FastAPI + PostgreSQL) or the Supabase adapter.
- **Tests:** `npm run test`, `npm run test:backend`, `npm run test:browser`, or `npm run test:all`.

Work is split between two people: KAI owns the drone, and a teammate owns the water sensor. See `README.md` and `docs/ARCHITECTURE.md` for the full picture.

## 5. Rules that must not be broken

1. **Do not broaden drone control.** No takeoff, land, RTL, mission upload, motor test, force-arm or parameter write. Speed limits and MAVLink constants live only in `backend/app/mavlink/pilot_limits.py` and `pilot_service.py`.
2. **`js/gamepad/` stays transport-free.** It must not contain `fetch(` or `WebSocket(`.
3. **Never open the real serial port or power the aircraft to develop software.** Use the mock backend.
4. **Stored data is a compatibility contract.** Do not migrate or reshape existing `localStorage` / IndexedDB records or JSON exports.
5. **Water levels are signed millimetres against a named datum.** A missing reading is `null`, never `0`. See `js/water/water-measurement.js`.
6. **No accuracy claims the data does not support.** No centimetre-accuracy claims for the QZ1. Untested hardware paths are described as untested.
7. **Automatic gate control is out of scope.**

## 6. Where to find things

| Need | Read |
|---|---|
| What changed recently | `docs/AGENT_LOG.md` |
| System design | `docs/ARCHITECTURE.md` |
| Drone operation and safety | `docs/MAVLINK_OPERATOR_GUIDE.md`, `docs/PILOT_CONTROL_GUIDE.md` |
| Drone payload mounts (3D-printed) | `docs/DRONE_PAYLOAD_MOUNT_PLAN.md` |
| Water-level sensor (tube, ToF sensor, 3D-printed parts) | `docs/WATER_SENSOR_PLAN.md` |
| Drone data link | `docs/DRONE_LINK_PLAN.md` |
| Water model | `docs/PADDY_WATER_MANAGEMENT.md` |
| Older snapshots (August 2026, historical) | `docs/CLAUDE_HANDOFF.md`, `docs/HANDOFF.md` |
