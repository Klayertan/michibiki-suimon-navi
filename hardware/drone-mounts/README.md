# Drone payload mounts (Holybro X500 V2, PETG)

**Status: second draft, 2026-10-12. Only the hook fit has been printed and tested. The tray, the QZ1 mast and the top parts are modelled and checked on screen only.**

Four printed parts that hold and protect the battery, the RealSense D435, the Jetson Orin Nano Super and the QZ1 GNSS receiver. Background and the reasoning are in [`docs/DRONE_PAYLOAD_MOUNT_PLAN.md`](../../docs/DRONE_PAYLOAD_MOUNT_PLAN.md).

| Part | File | Size (mm) | Where it goes |
|---|---|---|---|
| Battery tray | `exports/battery_tray.step` | 139 × 78 × 106 | Hangs from the two rails under the body. Replaces the stock battery board. The RealSense screws to the underside, in the middle, looking straight down. |
| Jetson deck | `exports/jetson_deck.step` | 128 × 107 × 9 | On four M3 standoffs above the top plate. |
| Jetson hoop | `exports/jetson_hoop.step` | 126 × 105 × 49 | Roll hoop over the Jetson. Screws to the deck. |
| QZ1 mast | `exports/qz1_mast.step` | 64 × 70 × 53 | Screws onto the hoop ring at the end away from the drone's own GPS mast. Holds the QZ1 face up. |

All four fit a 180 × 180 mm bed. STL copies are next to the STEP files.

**Changed on 2026-10-12 (second draft).** KAI moved the camera from the front of the tray to directly under it, for balance. The separate camera pod is gone, and the old tray file with the front bolt holes is replaced: **do not print a tray exported before this change.** The QZ1 mast is new, and the hoop gained two holes for it.

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
| RealSense D435 | 90 × 25 × 25 mm, two M3 threads 45 mm apart on the back, 3 mm deep | Size from [Intel's product page](https://www.intel.com/content/www/us/en/ark/products/128255.html). Thread depth from an [Intel community answer](https://communities.intel.com/thread/124961) quoting the D400 datasheet; not read from the datasheet itself. |
| QZ1 | 49.8 × 83.5 × 18 mm, about 65 g, own battery, micro-USB | QZSS spec sheet (`qzss.go.jp/appli-demo/isos7j000000chbk-att/qz1.pdf`). Port position not checked. |
| Landing gear | About 200 mm from the bottom of the legs to the body | Measured by KAI, 2026-10-12. |

## What was checked

`check_fit.py` places each part on Holybro's own frame model and looks for overlaps:

```bash
python check_fit.py /path/to/x500v2-frame.step
```

It checks the installed position of every part (and of the camera under the tray) and the sideways path the tray takes when it slides onto the rails. Result for the first draft on 2026-10-12: no clash in either check. **The second draft has not been run through it:** the frame model was not available in that session. The tray only grew downward inside its own outline and the mast stands above the hoop, so a clash with the frame is unlikely, but run the check before printing.

The second draft was checked against its own parts: the camera sits in its bay without touching the tray, nothing of the tray enters the camera's depth (87° × 58°) or colour (69° × 42°) field of view, and the mast, hoop, deck, Jetson and QZ1 do not overlap. The stock battery board, its hangers and its screws are left out, because the tray replaces them.

The check earned its keep. The first three hook layouts all hit something: arm bolt heads under the bottom plate, and a block bolted to one side of the body. The hooks now sit on the only stretch of rail that is clear of all of them.

What it cannot check: anything not in Holybro's model. That means the Pixhawk, power module, radio, GPS cable, wiring and your own additions. **Hold the printed part against the real drone before trusting it.**

## How the protection works

PETG is stiff, so the plastic alone does not cushion anything. Each part uses a different method.

- **Battery tray.** A closed cage so nothing can puncture the pack. Line it with foam: 10 mm under the pack, 3 mm on the sides and front. Under the floor is a 42 mm crush layer of four thin ribs (0.8 mm) closed by a thin sole. It is meant to buckle and be thrown away. Its height now follows from the camera hanging inside it. The first draft's rough plate-buckling estimate (buckling starts somewhere between 1 and 5 kN, 10–20 J absorbed over 20 mm) has not been redone for the taller ribs, which buckle sooner and crush further. None of it is tested. The landing gear and arms breaking absorb most of the rest. `CRUSH_WALL` tunes it: thinner is softer.
- **Camera.** The two middle ribs are the walls of a bay down the centre of the tray. The camera hangs in it from two beams under the floor, glass down, and the ribs and sole reach 12 mm below the glass, so they hit the ground first. The sole has a window under the camera, 12 mm longer than the camera at each end, so it stays out of the picture. The bay ends are open for the USB cable. In normal landings the 200 mm legs keep everything well off the ground: the bottom of the tray is about 110 mm below the bottom plate.
- **QZ1.** It sits on a mast about 68 mm above the Jetson's fan, at the end of the drone away from the drone's own GPS mast, to keep it away from that receiver and from the Jetson's USB 3 noise. The mast is the highest point, so in an upside-down landing it hits first. It is meant to break before the hoop does; print a spare.
- **Jetson deck and hoop.** The Jetson is the highest part and hits first if the drone lands upside down. The hoop stands 8 mm above the fan. Nylon standoffs under the deck are the intended weak point: they shear before the carbon plate cracks.

## Print settings

| Part | Orientation | Notes |
|---|---|---|
| Battery tray | Sole on the bed | 4 walls, 30 % infill. The crush ribs are two perimeters wide: check the slicer does not skip them (turn on thin-wall detection). The floor bridges up to 27 mm between ribs, and the camera beams bridge the 27 mm bay. Supports under the four hooks only. |
| Jetson deck | Flat, bosses up | No supports. |
| Jetson hoop | **Upside down**, ring on the bed | No supports. |
| QZ1 mast | **On one end**, so the side profile is the layer shape | No supports. 4 walls, 40 % infill. |

PETG, 0.2 mm layers, 0.4 mm nozzle. Print the hooks slowly: they carry the battery.

## Parts to buy

- 4 × M3 standoff, 35 mm, **nylon**, with M3 nuts and screws for the top plate
- 4 × M2.5 × 8 screws for the Jetson (they cut their own thread in the 2.1 mm holes)
- 4 × M3 × 12 screws for the hoop (self-tapping into the 2.6 mm leg holes, from under the deck)
- 2 × M3 × 10 screws for the camera. They pass 8 mm of floor and beam and go 2 mm into the camera's 3 mm threads. **Never use a longer screw: it will damage the camera.** Check the depth of your camera's threads first.
- 2 × M3 × 16 screws for the QZ1 mast (self-tapping into the 2.6 mm holes, from under the hoop ring)
- 2 hook-and-loop straps, 20 mm wide, and a 2–3 mm foam pad for the QZ1
- 2 battery straps, 6 zip ties, EVA or sponge foam (10 mm and 3 mm)

## Assembly order

1. Remove the stock battery board and its two hangers from the rails.
2. **Tray.** The four hooks all open to the same side. One side of the body has a block bolted next to the rail, so the tray only goes on from the other side: hold it about 14 mm off to that side, lift it until the rails are level with the hook mouths, and push it across until both rails snap in. Then lock it: next to each hook is a small hole through the tray wall. Pass a zip tie through the hole and around the rail.
3. Line the tray with foam. Slide the pack in from the open end, strap it through the two tunnels under the floor, and close the open end with a zip tie through the two side holes.
4. **Camera.** Do this before the foam and the battery. Hold the camera in the bay under the tray, glass down, back against the two beams, and screw it on from inside the tray with the two M3 × 10 screws. Plug the USB cable in and lead it out of the bay end. A right-angle USB-C plug fits best.
5. **Deck.** Fit the standoffs to the top plate, screw the hoop to the deck from underneath, screw the deck to the standoffs, then fit the Jetson through the hoop.
6. **QZ1 mast.** Screw it to the hoop ring from underneath, at the end away from the drone's GPS mast. Lay the QZ1 face up on the foam pad, with its micro-USB end free, and strap it down through the slots.

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
- The camera's USB cable runs from under the tray up to the Jetson on top. Route it along a leg or the body, clear of the propellers, and tie it down at both ends.
- The QZ1 cradle was kept outside the propeller discs on paper (motors on a 500 mm diagonal, 10 in props). Check it on the real drone with the props on.
- The QZ1 mast moves weight to one end. Check the centre of gravity with everything fitted.
- The Jetson's USB 3 port can disturb GNSS reception. See the plan.
- **Drop-test with a dummy weight, never with a real LiPo.**
