# Water-level sensor plan

**Status:** plan and first CAD draft, 2026-10-13. Parts are on order; nothing is printed, built or tested.
**Goal:** a cheap sensor that reports the water level in a paddy to about ±5–10 mm, signed against the soil surface, so the app's water model can use it without a person typing the depth in.

**Context that changed (KAI, 2026-10-13):** the project is now aimed at the Kobe SII forum, not the Michibiki hackathon. QZSS no longer has to be the thing that measures water. "Cheap and good" decides.

## 1. Decision: a field water tube with a distance sensor

A perforated pipe stands in the paddy. Water inside it matches the field, without waves, and still shows the level when the water is below the soil. A float rides on the water. A laser distance (ToF) sensor in the cap looks down at the float.

```
level = H − d − f

H   sensor height above the soil surface, measured once at install
d   distance the sensor reads, down to the top of the float
f   how far the float's top sits above the water, measured once in a bucket
```

`level` is in millimetres and is negative when the water is below the soil. It maps directly onto the record in `js/water/water-measurement.js` with `source: "sensor"` and `reference: "soil-surface"`.

This is the same idea as the tube IRRI recommends for alternate wetting and drying, with a sensor in place of a person looking down it.

## 2. Roles of every source

| Source | Role |
|---|---|
| Tube + ToF sensor | **The number the app uses.** |
| Staff gauge on the tube, read by eye | Ground truth, for calibration and for checking drift. |
| One-time depth survey with a ruler | Turns one sensor point into a picture of a sloped field (§5). |
| Drone camera | Shows which patches are exposed at shallow flooding, as a cross-check. Not a depth sensor: water gives invalid stereo depth. |
| QZ1 | Position and time for the sensor, and automatic field assignment. |
| Floating QZ1 (GNSS height) | Stays an experiment, on `feature/qz1-floating-water-level`. SLAS vertical error is on the order of metres, so it is very unlikely to resolve 10 mm. The tube gives that experiment a known reference to be judged against. |

## 3. Parts

Ordered (purchase request of 2026-10-13, Switch Science, ¥6,325):

| Item | Qty | Why |
|---|---|---|
| M5Stack ToF unit (VL53L1X), 32 × 24 × 8 mm | 2 | The sensor. One spare, or a second tube to check the slope survey. |
| ATOMS3 Lite | 1 | Controller for the node, so the two Core2 boards stay on the drone's LoRa link. Wi-Fi and Bluetooth, no SD card or clock. |
| Grove cable, 100 cm | 2 | Keeps the controller out of the tube. |

To buy locally (not priced): **VU100 PVC pipe, 400 mm** (114 mm outside, about 107 mm inside), foam for the float, neutral-cure silicone, silica gel, waterproof ruler tape, fine mesh, three M3 screws, a stake, a USB power bank.

**Pipe size changed from the first suggestion.** 75 mm pipe is too narrow: at its narrowest setting the sensor's cone is about 15°, which is about 105 mm wide at 400 mm. It needs the 100 mm pipe, and even that is tight at the bottom of the range.

Printed in PETG, in `hardware/water-sensor/`: the cap, the sensor lid and the float.

## 4. Geometry

| | Value |
|---|---|
| Pipe | 400 mm long: 200 mm in the soil, 200 mm above |
| Holes | 5 mm, all round the buried 200 mm, wrapped in mesh |
| Measurable range | About −190 mm to +150 mm |
| Lower limit | The float rests on the bottom of the pipe. Below that the node reports **no reading**, never a number. |
| Upper limit | The sensor cannot read closer than 40 mm |
| Vent | Three grooves inside the cap. Without a vent the water in the pipe cannot follow the field. |

The lower limit covers the safe-AWD threshold of −150 mm with about 40 mm to spare.

## 5. A sloped field with one sensor

A flooded paddy's water surface is level, so the water is the measuring tool.

1. Flood the field shallowly.
2. Measure the depth with a ruler at about nine points in a grid, within a few minutes of each other.
3. The differences between those depths are the differences in soil height. Store them as offsets from the sensor's position.

Then `depth at a point = level at the sensor − (soil height there − soil height at the sensor)`. The app can show the shallowest point, the deepest and the average.

Put the tube at a spot of roughly average height, not the lowest corner. Redo the survey after puddling or levelling, because the soil moves.

**Not built:** the app has no place to store these offsets yet.

## 6. What has to be proven on the bench first

| Risk | Test |
|---|---|
| Accuracy | Sensor over a bucket with the float, against a ruler, every 10 mm across the range. Target ±5 mm after calibration. |
| Cone hitting the pipe wall | Same test inside the real pipe, at the longest distance. If it fails, shorten the pipe above the soil or widen the pipe. |
| Condensation on the sensor | Leave it capped over warm water overnight. This is the most likely field failure. |
| Heat | The unit is rated 0–40 °C. A cap in summer sun may exceed that. Shade or a white cap may be needed. |
| Float sticking | Mud and algae on the pipe wall. The float has 2.5 mm of side clearance at its guide bumps. |
| Sensor position on the unit | Not published. The cap's window is wide to allow for it. Check against the real unit. |

## 7. Order of work

1. Parts arrive. Check the sensor window position and the pipe's real diameters, then adjust `sensor.py`.
2. Bench tests in §6.
3. Print the cap, lid and float.
4. Node firmware: read the sensor, average, send. Not written.
5. App side: a writer that stores readings with `source: "sensor"`. The sensor-management work on `feature/qz1-floating-water-level` is the natural home. Not written.
6. Field install, staff-gauge calibration and the slope survey.

How it goes together and how it reads the water: `hardware/water-sensor/water-tube-animation.html`.
