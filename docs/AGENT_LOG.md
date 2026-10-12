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

## 2026-10-12 — Hook fit-test pieces added
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1`
- **What changed:** `hardware/drone-mounts/mounts.py` gained `hook_test()` and `hook()` takes an optional rail radius. New exports `hook_test_10.0mm` and `hook_test_9.4mm` (STEP and STL). README section on how to use them.
- **Why:** KAI asked for a small test print before the full tray. Two sizes, because Holybro publishes 10 mm rails but models 9.4 mm.
- **Verified:** Both export as single solids, 14 mm tall lying flat. Shape checked in a rendered view. The four existing parts are unchanged. Not printed.
- **Open / next:** KAI to print both and report which fits. If it is the 9.4 mm one, set `RAIL_DIA = 9.4`, re-run `mounts.py`, and re-run `check_fit.py`.

## 2026-10-12 — Requirement: Pixhawk 6C ports must stay clear
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1`
- **What changed:** New "Pixhawk 6C under the deck" section in `hardware/drone-mounts/README.md`. No geometry changed.
- **Why:** KAI said the Pixhawk 6C is mounted with the Jetson and its ports must not be blocked.
- **Verified:** By arithmetic only, from the published 84.8 × 44 × 12.4 mm case size and the deck post positions: posts are outside the case, all four sides are open, about 19 mm above. Not verified: the direction the 6C connectors face, and the real board with cables.
- **Open / next:** KAI to confirm whether the Pixhawk stays on the top plate under the deck, and which way its connectors face. Also pushed earlier today: `main` up to `c1dc5fe`. This commit is not pushed.

## 2026-10-12 — Pixhawk 6C position confirmed
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1`
- **What changed:** One paragraph in `hardware/drone-mounts/README.md`. No geometry changed.
- **Why:** KAI confirmed the Pixhawk 6C stays on the top plate under the Jetson deck and that its connectors face sideways. The deck design stands as it is.
- **Verified:** Nothing new. Still not checked on the real board with cables.
- **Open / next:** KAI is printing the two hook test pieces and will report which rail size fits. Not pushed.

## 2026-10-12 — Hook test result: rails are 10 mm
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `docs/agent-handoff`, fast-forwarded into `main` and merged into `feature/vps-article1`
- **What changed:** README and plan updated with the result. No geometry changed.
- **Why:** KAI printed both hook test pieces in PETG and reported that the 10 mm one fits the real rails. `RAIL_DIA = 10.0` in `mounts.py` is confirmed. Holybro's STEP file (9.4 mm) is wrong on this point.
- **Verified:** First physical check of this design, by KAI. It confirms rail diameter and snap fit. KAI did not report on the 60 mm rail spacing separately, but the test piece spans both rails.
- **Open / next:** Print the battery tray and drop-test it with a dummy weight. Battery and D435 sizes are still unconfirmed. `main` is pushed up to `f22ebd8`; this commit is not pushed.

## 2026-10-12 — Session moved to the cloud; handoff file committed
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `feature/vps-article1-8ihyy7` (cloud copy of `feature/vps-article1`)
- **What changed:** Committed `DRONE_WORK_HANDOFF.md` (context for the water-sensor side's AI). Added `.playwright-cli/` and `.wrangler/` to `.gitignore`. Dropped the desktop's "WIP" snapshot commit, which held only these plus local tool caches.
- **Why:** Session moved from the desktop app to the cloud; the cloud stop hook asks for untracked files to be committed and pushed.
- **Verified:** `git status` clean after commit. No code changed, so no tests run.
- **Open / next:** Same as the previous entry: print and drop-test the battery tray, measure the battery and D435. KAI still to send the handoff file to the friend.

## 2026-10-12 — Camera moved under the tray; QZ1 mast added
- **Agent:** Claude Code (Opus 5.5)
- **Branch:** `feature/vps-article1-8ihyy7` (restarted from `main` after PR #5 merged)
- **What changed:** `hardware/drone-mounts/mounts.py`: tray now carries the D435 in a bay under its floor (crush layer 20 → 42 mm, sole window for the FOV); `camera_pod` removed; new `qz1_mast`; hoop gained two mast holes. `check_fit.py`, README and `docs/DRONE_PAYLOAD_MOUNT_PLAN.md` updated. Exports regenerated.
- **Why:** KAI decided the camera goes directly under the tray, for balance, and chose the QZ1 mast at the end away from the GPS mast (option b). KAI measured the legs at about 200 mm to the body. QZ1 and D435 sizes taken from published specs at KAI's request.
- **Verified:** Every part exports as one solid. Parts checked against each other in CadQuery: camera clear of the tray, no tray in the depth or RGB field of view, mast/hoop/deck/Jetson/QZ1 do not overlap. **Not run:** `check_fit.py` against Holybro's frame, because docs.holybro.com is blocked from the cloud session. Nothing printed. Taller crush ribs not re-estimated or tested.
- **Open / next:** Run `check_fit.py` on the desktop before printing. Do not print any tray exported before this change. Check the D435 thread depth (M3 × 10 goes 2 mm in) and the QZ1 cradle against the props on the real drone.
