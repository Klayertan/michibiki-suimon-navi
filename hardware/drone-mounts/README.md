# Drone payload mounts (Holybro X500 V2, PETG)

**Status: first draft, 2026-10-12. Modelled and checked on screen only. Nothing has been printed, fitted or drop-tested.**

Four printed parts that hold and protect the battery, the RealSense D435 and the Jetson Orin Nano Super. Background and the reasoning are in [`docs/DRONE_PAYLOAD_MOUNT_PLAN.md`](../../docs/DRONE_PAYLOAD_MOUNT_PLAN.md).

| Part | File | Size (mm) | Where it goes |
|---|---|---|---|
| Battery tray | `exports/battery_tray.step` | 139 × 78 × 85 | Hangs from the two rails under the body. Replaces the stock battery board. |
| Camera pod | `exports/camera_pod.step` | 34 × 100 × 51 | Bolts to the front wall of the tray. Camera looks straight down. |
| Jetson deck | `exports/jetson_deck.step` | 128 × 107 × 9 | On four M3 standoffs above the top plate. |
| Jetson hoop | `exports/jetson_hoop.step` | 126 × 105 × 49 | Roll hoop over the Jetson. Screws to the deck. |

All four fit a 180 × 180 mm bed. STL copies are next to the STEP files.

## The hook test (done: the 10 mm piece fits)

KAI printed both pieces on 2026-10-12 and the 10 mm one fits the real rails. `RAIL_DIA = 10.0` is correct and the tray needs no change. The rest of this section is kept for anyone repeating the test.

`exports/hook_test_10.0mm.step` and `exports/hook_test_9.4mm.step` are the two hooks of one tray cross-section on a plain bar, 27 × 79 × 14 mm, about 17 g each. They exist because Holybro publishes the rails as 10 mm but models them as 9.4 mm. The 9.4 mm piece has a hole through its bar so the two cannot be mixed up.

Print both flat, as exported, with no supports. Then, on the drone:

1. Hold the piece under the rails with the bar underneath and the hook mouths level with the rails.
2. Push it sideways. Both rails should snap in with a firm push and sit without rattling.
3. Pull down on it. It should not come off.

| What happens | What it means |
|---|---|
| One size snaps on firmly | Use that rail diameter. If it is the 9.4 mm piece, set `RAIL_DIA = 9.4` in `mounts.py` and re-run before printing the tray. |
| Both are loose | Lower `RAIL_CLEAR` (0.3) in steps of 0.1. |
| Neither goes on, or the arms whiten or crack | Raise `RAIL_CLEAR`. |
| One rail fits but the other does not line up | The rails are not 60 mm apart. Measure and change `RAIL_SPACING`. |

The test piece is printed with its layers the other way from the real tray, so it tells you about fit and nothing about strength.

## Change a size

Do not edit the exported files. Edit the `PARAMETERS` block at the top of `mounts.py` and re-run:

```bash
pip install cadquery
python mounts.py
```

## Where the dimensions come from

| Dimension | Value | Source |
|---|---|---|
| Rail spacing | 60 mm centre to centre | Holybro `x500v2-frame.step` |
| Rail centre below the bottom plate | 13 mm | Holybro STEP |
| Rail diameter | 10 mm | Published value, **confirmed by the printed hook test on 2026-10-12**. Holybro's STEP models 9.4 mm, which is wrong for the real rails. Hooks are cut for 10 mm with 0.3 mm clearance. |
| Top-plate M3 holes used | (±50, ±37) mm from the plate centre | Holybro STEP |
| Jetson mounting holes | 86 × 58 mm, M2.5 | NVIDIA developer kit STEP |
| Jetson board | 100 × 79 mm, fan top 28 mm above the board | NVIDIA STEP |
| Battery | 132 × 44 × 29 mm | Seller listings. **Measure your pack.** |
| RealSense D435 | 90 × 25 × 25 mm, two M3 threads 45 mm apart on the back | From memory. **Check Intel's datasheet, including the thread depth.** |

## What was checked

`check_fit.py` places each part on Holybro's own frame model and looks for overlaps:

```bash
python check_fit.py /path/to/x500v2-frame.step
```

It checks the installed position of all four parts and the sideways path the tray takes when it slides onto the rails. Result on 2026-10-12: no clash in either check. The stock battery board, its hangers and its screws are left out, because the tray replaces them.

The check earned its keep. The first three hook layouts all hit something: arm bolt heads under the bottom plate, and a block bolted to one side of the body. The hooks now sit on the only stretch of rail that is clear of all of them.

What it cannot check: anything not in Holybro's model. That means the Pixhawk, power module, radio, GPS cable, wiring and your own additions. **Hold the printed part against the real drone before trusting it.**

## How the protection works

PETG is stiff, so the plastic alone does not cushion anything. Each part uses a different method.

- **Battery tray.** A closed cage so nothing can puncture the pack. Line it with foam: 10 mm under the pack, 3 mm on the sides and front. Under the floor is a 20 mm crush layer of four thin ribs (0.8 mm) closed by a thin sole. It is meant to buckle and be thrown away. A rough plate-buckling calculation puts the start of buckling somewhere between 1 and 5 kN, and the energy absorbed at 10–20 J, which is a sixth to a third of a 3 m fall. Those figures are estimates and have not been tested. The landing gear and arms breaking absorb most of the rest. `CRUSH_RIBS` and `CRUSH_H` tune it: fewer or taller ribs are softer.
- **Camera pod.** Two skid bars reach 12 mm below the camera glass, and the tray's sole is 8 mm lower still, so the tray touches the ground first. The ends are open for the USB cable and so the bars stay out of the picture.
- **Jetson deck and hoop.** The Jetson is the highest part and hits first if the drone lands upside down. The hoop stands 8 mm above the fan. Nylon standoffs under the deck are the intended weak point: they shear before the carbon plate cracks.

## Print settings

| Part | Orientation | Notes |
|---|---|---|
| Battery tray | Sole on the bed | 4 walls, 30 % infill. The crush ribs are two perimeters wide: check the slicer does not skip them. The floor bridges 18 mm between ribs. Supports under the four hooks only. |
| Camera pod | Back plate on the bed | Supports under the roof. |
| Jetson deck | Flat, bosses up | No supports. |
| Jetson hoop | **Upside down**, ring on the bed | No supports. |

PETG, 0.2 mm layers, 0.4 mm nozzle. Print the hooks slowly: they carry the battery.

## Parts to buy

- 4 × M3 standoff, 35 mm, **nylon**, with M3 nuts and screws for the top plate
- 4 × M2.5 × 8 screws for the Jetson (they cut their own thread in the 2.1 mm holes)
- 4 × M3 × 12 screws for the hoop (self-tapping into the 2.6 mm leg holes, from under the deck)
- 3 × M3 × 10 screws and nuts for the camera pod
- 2 × M3 × 6 screws for the camera. **Too long a screw will damage the camera.**
- 2 battery straps, 6 zip ties, EVA or sponge foam (10 mm and 3 mm)

## Assembly order

1. Remove the stock battery board and its two hangers from the rails.
2. **Tray.** The four hooks all open to the same side. One side of the body has a block bolted next to the rail, so the tray only goes on from the other side: hold it about 14 mm off to that side, lift it until the rails are level with the hook mouths, and push it across until both rails snap in. Then lock it: next to each hook is a small hole through the tray wall. Pass a zip tie through the hole and around the rail.
3. Line the tray with foam. Slide the pack in from the open end, strap it through the two tunnels under the floor, and close the open end with a zip tie through the two side holes.
4. **Camera pod.** Screw the camera into the roof, then bolt the pod to the front wall of the tray. The nuts sit in the hexagonal pockets on the camera side.
5. **Deck.** Fit the standoffs to the top plate, screw the hoop to the deck from underneath, screw the deck to the standoffs, then fit the Jetson through the hoop.

## Pixhawk 6C under the deck

KAI's requirement: the Pixhawk 6C sits with the Jetson and none of its ports may be blocked. In this design the Pixhawk stays on the top plate, at the centre, and the Jetson deck stands over it on four posts.

| Check | Numbers |
|---|---|
| Pixhawk 6C size | 84.8 × 44 × 12.4 mm, 59 g (PX4 documentation) |
| Posts | At (±50, ±37) mm. With the Pixhawk's long side along the rails its case reaches ±42.4 × ±22 mm, so every post is outside it. |
| Long sides | 15 mm from case to post line, and open for the full 85 mm between posts |
| Short ends | 68 mm of open width between posts |
| Above | About 19 mm from the top of the Pixhawk (on a 3 mm foam pad) to the underside of the deck |

So the deck covers the Pixhawk from above and leaves all four sides open. KAI confirmed on 2026-10-12 that the Pixhawk stays on the top plate and that its connectors face sideways, so no change to the deck is needed. Still not checked against the real board with its cables plugged in. If a plug or cable bend needs more height, raise `STANDOFF_H`.

## Known limits

- The four top-plate holes may already be in use on your build. Check before printing the deck.
- 35 mm standoffs assume the Pixhawk and its cables fit under the deck. Change `STANDOFF_H` if not.
- The tray sits 6.7 mm behind the frame centre, because the platform board is in the way at the front. It cannot move along the rails, so balance the drone with the Jetson position and check the centre of gravity.
- The hooks are 56 mm apart on a 139 mm tray, so the ends overhang.
- The hook mouths rely on the zip ties to stay closed in a sideways hit.
- The landing-gear skids will appear at the edges of the camera picture.
- The Jetson's USB 3 port can disturb GNSS reception. See the plan.
- **Drop-test with a dummy weight, never with a real LiPo.**
