# Agent log

The running record of what changed in this project and why. Every agent appends an entry here after a task that changes files. The rules and the entry template are in [`AGENTS.md`](../AGENTS.md) §2.

**Append only. Newest entry at the bottom. Never edit an older entry.**

---

## 2026-10-12 — Agent handoff system added
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff` (from `origin/main` @ `4152769`)
- **What changed:** Added `AGENTS.md` as the single rule file for all agents. `CLAUDE.md` now only imports it; its Git workflow section moved into `AGENTS.md` §3 unchanged. Added this log, with `merge=union` in `.gitattributes` so entries from different branches merge without conflicts.
- **Why:** KAI uses both Claude Code and Codex and wants any agent to see what happened before it.
- **Verified:** Docs only, no code touched, so no tests were run.
- **Open / next:** Not pushed and not merged to `main`. Other branches will not have these files until this branch is merged into them. `docs/CLAUDE_HANDOFF.md` and `docs/HANDOFF.md` are August 2026 snapshots and are now historical.

## 2026-10-12 — Work split and drone payload mount plan recorded
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`
- **What changed:** Added `docs/DRONE_PAYLOAD_MOUNT_PLAN.md`.
- **Why:** KAI decided two things in chat. (1) The work is split: KAI does the drone, a teammate does the water sensor. (2) KAI wants 3D-printed mounts on the Holybro X500 V2 for the batteries (two Zeee 4S 14.8 V 3300 mAh packs), the RealSense and the Jetson Orin Nano Super, protecting them in a 3 m fall. Arms and propellers may break, since spares exist.
- **Verified:** Not verified. The plan is design guidance. Sizes and weights in it are estimates marked "(measure)". Nothing is modelled or printed.
- **Open / next:** KAI to answer the questions in §6 of the plan (one or two packs in flight, mounting position, camera direction, printer and materials) and supply measurements. Then model the battery tray first. A handoff note for the teammate's AI exists as `DRONE_WORK_HANDOFF.md`, outside the repo so far.
- **State of the branches, for orientation:** `main` does not contain the water-sensor work. That is on `feature/qz1-floating-water-level` (unmerged, about 20k lines, includes a Cloudflare hosting migration). `feature/vps-article1` holds blog articles. `feature/jetson-ground-station` and `feature/mavlink-integration` are already contained in `main`.
