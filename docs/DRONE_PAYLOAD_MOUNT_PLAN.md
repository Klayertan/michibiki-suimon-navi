# Drone payload mounts — 3D-print plan

**Status:** first CAD draft exists, 2026-10-12, in [`hardware/drone-mounts/`](../hardware/drone-mounts/README.md). It was checked against Holybro's frame model on screen. Nothing is printed, fitted or drop-tested yet.
**Goal (KAI):** 3D-printed mounts for the Holybro X500 V2 that hold the batteries, the Intel RealSense and the Jetson Orin Nano Super, and protect them in a fall from 3 m. Arms and propellers are allowed to break, because spares are on hand.

> Every dimension and weight marked **(measure)** is from memory or an estimate. Measure the real part with calipers and a scale before modelling. Do not model from the numbers in this file.

## 1. What a 3 m fall means

| Quantity | Value |
|---|---|
| Impact speed | √(2 × 9.81 × 3) ≈ **7.7 m/s** (about 28 km/h) |
| Energy at 2.3 kg all-up | 2.3 × 9.81 × 3 ≈ **68 J** |
| Average deceleration | (drop height ÷ stopping distance) g. 30 mm of crush gives about 100 g. 50 mm gives about 60 g. |

Two things follow. First, the only thing that lowers the shock is **stopping distance**, so the design needs parts that crush or flex by tens of millimetres. A stiff box does not protect what is inside it. Second, no printed mount can promise survival, because the drone may land on any corner or upside down. The realistic target is that the three payloads survive a roughly level fall onto grass or soil and are likely to survive a fall onto hard ground.

## 2. Parts to protect

| Part | Size | Mass | Mounting | Main risk |
|---|---|---|---|---|
| Zeee 4S 14.8 V 3300 mAh LiPo (×2 owned) | **(measure)** | about 300–330 g each **(measure)** | Strap and tray | Puncture or crush, which can start a fire. Shock alone is less of a problem. |
| Intel RealSense D435 | about 90 × 25 × 25 mm | about 72 g | Two M3 threads on the back, 45 mm apart, and one 1/4-20 thread underneath **(measure)** | Front glass and lenses. A downward camera is the lowest point of the drone. |
| Jetson Orin Nano Super developer kit | about 100 × 79 × 21 mm **(measure)** | about 180 g **(measure)** | Carrier-board corner holes **(measure the pattern)** | Board flex, connectors torn out, fan and heatsink, overheating if enclosed. |

The camera model is the D435 verified in `edge/perception/README.md`, not the "D345" named in the brief.

## 3. Design principles

1. **Keep everything inside the frame's outline.** The landing gear, arms and a sacrificial bumper must touch the ground before any payload does.
2. **Two-material construction.** A rigid shell carries the load and keeps its shape. A soft layer between the shell and the part takes the shock.
   - Rigid: **PETG** or **ASA**. Nylon-CF if the printer can do it. **Not PLA**: it is brittle on impact and softens in a hot car or in direct sun.
   - Soft: **TPU 95A** printed with 10–15 % gyroid infill, so it crushes and springs back.
3. **Battery tray.** Fully enclosed corners, a TPU liner on all faces, and at least 10 mm of crush space under the pack. No screw tip, carbon edge or zip-tie buckle may point at the pack. Keep two straps so the pack cannot slide out. Leave the balance lead and the main lead a relief loop.
4. **Camera guard.** Recess the D435 so its front glass sits at least 10 mm behind a TPU bumper ring. The ring must not enter the field of view (about 87° × 58° for depth, **check for the mode in use**). Add skids that reach lower than the camera.
5. **Jetson cradle.** Hold the board by its mounting holes on TPU grommets or standoffs, not by clamping the board. Leave the heatsink and fan open to air. A closed box will overheat it. Add strain relief for the USB 3 cable to the camera, since a torn connector is the most likely failure.
6. **Break-away, not rigid.** Use nylon screws or thin printed tabs as fuses where a mount meets the frame, so the mount shears off instead of cracking the carbon plate.
7. **Balance.** Keep the battery under the centre of gravity. Put the Jetson and the camera on opposite sides of it, or stack them on the centreline.
8. **Print orientation.** Layer lines are the weak direction. Orient each part so the impact load runs along the layers, not across them.

## 4. Weight budget (estimate)

| Item | Mass |
|---|---|
| X500 V2 with motors, ESCs, Pixhawk 6C, GPS, receiver, radio | about 1.15 kg **(measure)** |
| One 4S 3300 mAh pack | about 0.32 kg |
| Jetson Orin Nano Super developer kit | about 0.18 kg |
| RealSense D435 with cable | about 0.09 kg |
| QZ1 receiver | about 0.10 kg |
| Regulator and wiring | about 0.06 kg |
| Printed mounts and TPU | 0.15–0.25 kg |
| **Total with one pack** | **about 2.1 kg** |
| **Total with two packs in parallel** | **about 2.4 kg** |

Weigh the real drone. Hover throttle above about 60 % leaves little margin for wind and for recovery, and flight time will be short with a 3300 mAh pack at this weight.

## 5. Power

The Jetson needs a regulated supply. Its barrel jack accepts a range that a 4S pack sits inside **(check the range in NVIDIA's documentation)**, but pack voltage sags and spikes under motor load, so feed it through a step-down regulator (BEC) rated for at least 5 A, not straight from the pack. The mount needs a place for that regulator.

## 6. Decisions (KAI, 2026-10-12)

| Question | Decision |
|---|---|
| Packs in flight | **One** 4S 3300 mAh pack, to save weight. The second pack is a swap. |
| Battery position | **Underneath**, on the two rails. |
| Jetson position | **On top** of the body. |
| Camera direction | **Straight down.** |
| Printers | Bambu Lab A1 mini (180 × 180 × 180 mm bed) and Flashforge Adventurer 5M Pro (220 × 220 × 220 mm bed). |
| Material | **PETG only.** No TPU for now. |

**What PETG-only changes.** PETG is stiff, so a 1 mm PETG layer or liner gives almost no protection: stopping in 1 mm from a 3 m fall is about 3,000 g. The soft layer in §3.2 is therefore replaced by two things:

- **Printed crush structures.** Sacrificial bumpers under the battery tray with thin walls (0.8–1.2 mm) in a honeycomb or rib pattern, 15–25 mm tall, that buckle on impact. They are bolted on and reprinted after a crash.
- **A foam liner that is not printed.** 5–10 mm of EVA or sponge foam inside the battery tray and under the Jetson. The pockets are modelled with room for it.

**Consequences of the Jetson on top.**

- It is the first thing to hit if the drone lands upside down, so it needs a roll hoop that stands taller than the fan.
- It raises the centre of gravity. The battery underneath partly offsets this.
- **USB 3 is a known source of radio noise near GNSS frequencies.** Keep the Jetson and its USB 3 cable as far as possible from the Pixhawk GPS mast and the QZ1, and check satellite counts with the camera running before trusting any survey.
- The camera cable has to run from the top deck to the camera underneath, clear of the propellers, with strain relief at both ends.

## 6a. Dimension sources

Read from the manufacturers' CAD files on 2026-10-12. The full table is in `hardware/drone-mounts/README.md`.

| Part | Source | Result |
|---|---|---|
| X500 V2 frame | Holybro `x500v2-frame.step` (docs.holybro.com) | Rails 60 mm apart, centred 13 mm below the bottom plate. Rails are 10 mm published but 9.4 mm in the model. Free M3 holes in the top plate at (±50, ±37) mm. |
| Jetson Orin Nano developer kit | NVIDIA STEP model (Jetson Download Center) | Board 100 × 79 mm, four M2.5 holes on an 86 × 58 mm rectangle. |
| Zeee 4S 3300 mAh | Seller listings | About 132 × 44 × 29 mm. **Not measured.** |
| RealSense D435 | From memory of Intel's datasheet | About 90 × 25 × 25 mm, two M3 threads 45 mm apart. **Not confirmed.** |

## 7. Order of work

1. ~~Read the dimensions from the published CAD files.~~ Done.
2. ~~Model the parts.~~ First draft done: battery tray, camera pod, Jetson deck, Jetson hoop.
3. Check the real parts against the two unconfirmed rows in §6a, and check that the four top-plate holes are free on the real drone.
4. Print a 15 mm slice of one tray hook first and test it on a rail. It costs minutes and proves the rail diameter and the snap fit.
5. Print the battery tray. Load it with a **dummy weight** of the same mass and drop-test from 1 m, then 2 m, then 3 m, onto grass and then onto a hard floor. **Never drop-test with a real LiPo.**
6. Print the camera pod, deck and hoop. Test them the same way with dummy weights.
7. Fit everything, weigh the drone, check the centre of gravity, then do a tethered or very low hover before any real flight.
