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

## 8. Power and data link (added 2026-10-13)

**Decisions (KAI):** solar power, and LoRa to carry the readings. Reading interval: every 10 minutes, as a default that can change.

### Budget

Estimates, not measurements. The E220 figures are from its product page; the rest are typical values.

| Phase | Draw | Time | Per day (144 readings) |
|---|---|---|---|
| Awake: boot, range, send | about 0.3–0.5 W (E220 transmits at 43 mA) | about 1.5 s | about 0.03 Wh |
| Asleep | E220 2.5 µA. **Controller unknown**, assume 1 mA at 5 V | the rest | about 0.12 Wh |
| **Total** | | | **about 0.15–0.25 Wh** |

A 2 W panel gives very roughly 3 Wh on a clear day after losses, which is more than ten times the need. A single 2000 mAh lithium cell (about 7 Wh) would run the node for about a month with no sun. The margin is there to cover the one real unknown: how much the ATOMS3 Lite draws asleep. Measure that first. If it is tens of milliamps, the answer is a different controller or a power switch, not a bigger panel.

### Parts looked up on 2026-10-13

| Part | Candidate | Price | State |
|---|---|---|---|
| Charger | Adafruit bq25185 board with 5 V output (Switch Science 10183). Takes 5–18 V from a panel, charges one lithium cell, gives 5 V at up to 1 A. | ¥1,870 | In stock (4) |
| Panel | Akizuki SY-M2W, 2 W, 6.9 V open circuit, 116 × 116 × 3 mm, bare leads | ¥800 | Online stock due late November |
| Panel, alternative | Akizuki SY-M3W, 3 W | ¥1,380 | In stock. Voltage and size not checked. |
| LoRa radio | E220-900T22S(JP) R2 (Switch Science 10453). 920 MHz, 13 dBm. | ¥1,793 | In stock. **Bare surface-mount module**: its breakout boards are sold out, so it needs fine soldering. |
| Battery | One protected lithium cell, about 2000 mAh | — | **Not sourced.** Switch Science is sold out of every size. |

Not chosen: the DFRobot 5 V panel at Switch Science (6 W, ¥1,938) has a 1.5–2 month lead time.

### Layout

- Panel, charger, battery, controller and radio all go on the **stake**, in one sealed box, above the highest water level. Nothing electrical but the sensor goes on the tube.
- Mount the panel above the tube so it shades the cap. That also helps with the sensor's 40 °C limit.
- Keep the lithium cell out of direct sun. LiFePO4 is the safer chemistry if a cell and matching charger can be found.
- A USB power bank will not work: most switch off when the load drops to sleep current.

### Open

1. Does KAI already own E220 modules on breakout boards, and how many? The drone link plan assumed a pair.
2. Battery source.
3. Controller sleep current, measured.
4. Radio rules: the E220's certification covers specific antennas. Use only the antenna it is certified with.
5. Not designed: the receiver at the house, the packet format, the stake box and the panel bracket.

### Parts chosen for the second purchase request (2026-10-13, ¥11,619)

KAI owns no E220 modules, so the request covers both ends of the link.

| Item | Qty | Price each | From | Note |
|---|---|---|---|---|
| E220-900T22S(JP)-EV2 LoRa evaluation board | 2 | ¥1,980 | Akizuki 131361 | One for the node, one for the receiver. Pin headers and an SMA socket, so no fine soldering. |
| LoRa antenna TX915-JKS-20 | 2 | ¥715 | Akizuki 117618 | The antenna Akizuki lists for this board. |
| FT234X USB-serial module | 1 | ¥780 | Akizuki 108461 | Makes the receiver a USB serial port, which the app's Web Serial code can already read. |
| Solar module SY-M3W, 3 W | 1 | ¥1,380 | Akizuki 108920 | 10.9 V open circuit, 251 × 140 × 18 mm, alligator-clip leads. Chosen over the 2 W panel because it is in stock, and it is big enough to shade the cap. |
| bq25185 charger board with 5 V output | 1 | ¥1,870 | Switch Science 10183 | Accepts 5–18 V. |
| Lithium polymer cell, 3.7 V 2000 mAh, 103450, PH2.0 plug, built-in protection | 1 | ¥2,199 | Amazon B0GFCZZB3D | Unbranded, two reviews. See the warning below. |

**Before connecting the battery:** check the plug's polarity against the charger board's markings with a multimeter. PH2.0 plugs on unbranded cells are often wired the opposite way round, and a reversed cell destroys the board. The cell is from an unknown maker, so treat its capacity and its protection circuit as unproven, charge it the first time where it can be watched, and keep it in shade in the field.

Still to buy locally: a sealed box for the stake, jumper wires, a stake.

### Correction, 2026-10-13: KAI already owns LoRa modules

KAI has three CLEALINK LoRa modules on boards with UART pins, plus one bare module that is not soldered. The two E220 evaluation boards were therefore removed from the purchase request, which now totals ¥14,772 for nine items including the pipe (a 0.5 m VU100 length from Amazon, ¥788 plus shipping).

Three usable modules cover both jobs: one on the drone, one on the sensor node, and one receiver shared by both. Sharing a receiver means the drone's 1 Hz stream and the sensor's 10-minute messages use the same channel, so an occasional sensor message can be lost while the drone is flying. The node should send each reading more than once, or the two links should use different channels.

**Not confirmed:** the exact model printed on the modules (the plan assumes E220-900T22S(JP)), whether KAI has antennas for them, and whether the two antennas still on the request are needed.
