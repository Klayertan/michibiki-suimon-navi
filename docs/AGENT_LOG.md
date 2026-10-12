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

## 2026-10-12 — Mount decisions recorded; handoff branch merged
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1` (KAI asked for the merge)
- **What changed:** `docs/DRONE_PAYLOAD_MOUNT_PLAN.md` §6 now holds KAI's decisions in place of open questions, and a new §6a lists where each dimension comes from.
- **Why:** KAI answered the open questions: one pack in flight, battery underneath on the rails, Jetson on top, camera straight down, PETG only, printers are a Bambu Lab A1 mini and a Flashforge Adventurer 5M Pro. KAI also asked for dimensions to come from published CAD instead of hand measurement.
- **Verified:** Not verified. Docs only. The published dimensions in §6a come from vendor pages and seller listings, not from the real parts.
- **Open / next:** Rail spacing, plate hole patterns and the Jetson hole pattern are still unknown. They need the Holybro and NVIDIA STEP files. No CAD exists yet. CadQuery 2.5.2 was installed in a temporary environment for this, not in the repo. Nothing is pushed.

## 2026-10-12 — First CAD draft of the drone payload mounts
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1`
- **What changed:** New folder `hardware/drone-mounts/`: `mounts.py` (parametric CadQuery source), `check_fit.py`, a README, and exported STEP and STL files for four PETG parts (battery tray, camera pod, Jetson deck, Jetson hoop). `docs/DRONE_PAYLOAD_MOUNT_PLAN.md` updated to match.
- **Why:** KAI asked for the mounts with protection, in PETG, with dimensions taken from published CAD. KAI approved downloading Holybro's `x500v2-frame.step` and NVIDIA's Jetson developer kit STEP model. Neither file is in the repo.
- **Verified:** `check_fit.py` against Holybro's frame model: no clash for any part when installed, and none along the tray's 14 mm slide-on path. Three earlier hook layouts failed this check and were changed. Each part exports as a single solid. **Not verified:** nothing is printed or fitted. Battery and RealSense sizes are unconfirmed. The crush-layer figures in the README are a rough calculation. The check only knows about parts in Holybro's model, so the Pixhawk, wiring and KAI's own additions are not covered.
- **Open / next:** KAI to confirm the battery and D435 sizes and that the top-plate holes at (±50, ±37) mm are free, then print a hook test slice before the full tray. To change a size, edit the parameters in `mounts.py` and re-run it; never edit the exported files. CadQuery is not a repo dependency: `pip install cadquery`.
