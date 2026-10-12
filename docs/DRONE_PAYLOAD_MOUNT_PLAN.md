# Drone payload mounts — 3D-print plan

**Status:** plan only, 2026-10-12. Nothing is modelled, printed or tested yet.
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

## 6. Open questions for KAI

1. **One pack or two in flight?** Two packs in parallel means a wider tray and about 2.4 kg. One pack with a swap is lighter.
2. **Where does the battery go?** On the X500 V2 the pack normally hangs on the two rails under the body. Does the Jetson go on the same rails, or on top?
3. **Camera direction.** Straight down for the paddy survey, or tilted forward?
4. **Printer and materials.** Which printer and bed size, and is TPU available?
5. **Measurements needed before modelling:** rail diameter and spacing, free rail length, battery length × width × height, Jetson hole pattern, ground clearance under the body with the landing gear fitted.

## 7. Suggested order of work

1. Measure (§6.5) and weigh.
2. Model one part first: the battery tray. It carries the highest risk.
3. Print it, load it with a **dummy weight** of the same mass, and drop-test from 1 m, then 2 m, then 3 m onto grass and then onto a hard floor. **Never drop-test with a real LiPo.**
4. Model the Jetson cradle and the camera guard the same way, tested with dummy weights.
5. Fit everything, weigh, check the centre of gravity, then do a tethered or very low hover before any real flight.
