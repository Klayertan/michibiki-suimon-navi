# Paddy water-level tube (PETG)

**Status: first draft, 2026-10-13. Modelled only. Nothing is printed or tested, and the sensor has not arrived.**

Three printed parts for the water-level sensor described in [`docs/WATER_SENSOR_PLAN.md`](../../docs/WATER_SENSOR_PLAN.md).

| Part | File | Size (mm) | What it does |
|---|---|---|---|
| Tube cap | `exports/tube_cap.step` | 121 × 121 × 35 | Slips over a VU100 pipe. Has the window the sensor looks through and three vent grooves. |
| Sensor lid | `exports/sensor_lid.step` | 37 × 47 × 10 | Holds the ToF unit face down over the window and keeps rain off. Two M3 screws. |
| Float | `exports/float_target.step` | 94 across × 14 | An upturned cup with a flat top for the sensor to see. Glue foam inside. |

`water-tube-animation.html` shows the assembly and how the sensor reads the water.

## Change a size

Edit the `PARAMETERS` block in `sensor.py` and re-run. Do not edit the exported files.

```bash
pip install cadquery
python sensor.py
```

The script also checks that the parts do not overlap each other, the pipe or the sensor unit.

## Check before printing

| Assumed | Value | Source |
|---|---|---|
| Pipe outside diameter | 114 mm | Nominal VU100. **Measure your pipe.** |
| Pipe inside diameter | 107 mm | Nominal. **Measure.** |
| Sensor unit | 32 × 24 × 8 mm | Switch Science product page |
| Sensor position on the unit | Unknown | **Check the 22 × 14 mm window covers it.** |

## Print settings

| Part | Orientation | Notes |
|---|---|---|
| Tube cap | **Upside down**, flat top on the bed | No supports. |
| Sensor lid | Upside down, top on the bed | No supports. |
| Float | **Upside down**, flat face on the bed | No supports. The bed side becomes the smooth target face. |

PETG, 0.2 mm layers, 4 walls. A white or light filament keeps the cap cooler and gives the sensor a brighter float.

## Assembly

1. Drill 5 mm holes all round the lower 200 mm of a 400 mm pipe and wrap that part in fine mesh.
2. Push the pipe 200 mm into the soil. Scoop the mud out of the inside.
3. Drop the float in, flat face up.
4. Fit the cap and tighten the M3 screw in its side.
5. Lay the sensor face down over the window, cable toward the slot, and screw the lid on.
6. Run the cable to the controller on a stake.
7. Calibrate: measure from the sensor to the soil once, and compare the first readings with the staff gauge.

## Known limits

- Printed PETG is not watertight. The float relies on the foam, not on the print.
- The lid sheds rain but is not sealed. Put a bead of neutral-cure silicone round it once the sensor is proven.
- Nothing here protects the controller. It needs its own box on the stake.
