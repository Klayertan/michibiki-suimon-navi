"""Parametric parts for the paddy water-level tube (PETG).

Run:  python sensor.py            -> writes STEP + STL into ./exports
Needs CadQuery 2.x (pip install cadquery).

A perforated PVC pipe stands in the paddy. A float rides on the water inside
it. A ToF distance sensor in the cap looks down at the float. See
docs/WATER_SENSOR_PLAN.md.

Edit the PARAMETERS block and re-run; do not edit the exported files.
Coordinates: z up, z = 0 at the top rim of the pipe, pipe axis on x = y = 0.
"""
import math
from pathlib import Path
import cadquery as cq

# ----------------------------------------------------------------- PARAMETERS
# Pipe. Japanese VU100 PVC drain pipe, nominal sizes. MEASURE YOUR PIPE.
PIPE_OD = 114.0
PIPE_ID = 107.0
PIPE_FIT = 0.6            # diametral clearance between cap and pipe

# Sensor. M5Stack ToF unit (VL53L1X), 32 x 24 x 8 mm (Switch Science page).
UNIT_L, UNIT_W, UNIT_H = 32.0, 24.0, 8.0
UNIT_FIT = 0.6
# Where the sensor sits on the unit is not published, so the opening is wide.
# CHECK it against the real unit before printing.
WINDOW_L, WINDOW_W = 22.0, 14.0
CABLE_SLOT = 14.0         # Grove plug exits one short end

# Print / structure
SKIRT_H = 30.0
SKIRT_T = 3.0
TOP_T = 3.0
RIM_GAP = 2.0             # air gap above the pipe rim, so the pipe can breathe
VENT_W, VENT_D = 6.0, 1.2
LID_T = 2.0
LID_EAR = 9.0
FLOAT_GAP = 6.5           # radial gap between float and pipe wall
FLOAT_T = 1.2
FLOAT_RIM = 14.0
FLOAT_GUIDE = 4.0         # guide bumps; leaves FLOAT_GAP - this to the wall

OUT = Path(__file__).parent / "exports"

R_IN = (PIPE_OD + PIPE_FIT) / 2
R_OUT = R_IN + SKIRT_T
Z_TOP0 = RIM_GAP                      # underside of the cap's top plate
Z_TOP1 = RIM_GAP + TOP_T              # the unit sits on this face
POCKET_L, POCKET_W = UNIT_L + UNIT_FIT, UNIT_W + UNIT_FIT
LID_IN_L, LID_IN_W = POCKET_L, POCKET_W   # the lid locates the unit
LID_H = UNIT_H + 0.4                  # inside height above the top plate
EAR_Y = LID_IN_W / 2 + LID_T + LID_EAR / 2


def box(x0, x1, y0, y1, z0, z1):
    return (cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0, centered=False)
            .translate((x0, y0, z0)))


def cyl(r, z0, z1, x=0.0, y=0.0):
    return cq.Workplane("XY").circle(r).extrude(z1 - z0).translate((x, y, z0))


def tube_cap():
    c = cyl(R_OUT, -SKIRT_H, Z_TOP1).cut(cyl(R_IN, -SKIRT_H - 1, Z_TOP0))
    for i in range(3):
        a = math.radians(120 * i)
        # stop that rests on the pipe rim and holds the air gap open
        stop = box(PIPE_ID / 2 - 3, R_IN + 0.5, -4, 4, 0, Z_TOP0 + 0.01)
        c = c.union(stop.rotate((0, 0, 0), (0, 0, 1), math.degrees(a)))
        # vent groove down the inside of the skirt, between the stops
        vent = box(R_IN - 0.5, R_IN + VENT_D, -VENT_W / 2, VENT_W / 2,
                   -SKIRT_H - 1, Z_TOP0)
        c = c.cut(vent.rotate((0, 0, 0), (0, 0, 1), math.degrees(a) + 60))
    c = c.cut(box(-WINDOW_L / 2, WINDOW_L / 2, -WINDOW_W / 2, WINDOW_W / 2,
                  Z_TOP0 - 1, Z_TOP1 + 1))
    for sy in (-1, 1):                                  # lid screws, M3 self-tap
        c = c.cut(cyl(1.3, Z_TOP0 - 1, Z_TOP1 + 1, 0, sy * EAR_Y))
    grub = (cq.Workplane("YZ").circle(1.3).extrude(SKIRT_T + 4)
            .translate((-R_OUT - 1, 0, -SKIRT_H / 2)))  # M3 screw onto the pipe
    return c.cut(grub)


def sensor_lid():
    """Rain cover that also holds the sensor in place. Modelled on the cap."""
    z0, z1 = Z_TOP1, Z_TOP1 + LID_H
    lo, wo = LID_IN_L / 2 + LID_T, LID_IN_W / 2 + LID_T
    l = box(-lo, lo, -wo, wo, z0, z1 + LID_T)
    l = l.cut(box(-LID_IN_L / 2, LID_IN_L / 2, -LID_IN_W / 2, LID_IN_W / 2,
                  z0 - 1, z1))
    l = l.cut(box(0, lo + 1, -CABLE_SLOT / 2, CABLE_SLOT / 2, z0 - 1, z0 + 6.5))
    for sy in (-1, 1):
        ear = box(-LID_EAR / 2, LID_EAR / 2, sy * EAR_Y - LID_EAR / 2,
                  sy * EAR_Y + LID_EAR / 2, z0, z0 + 3.0)
        l = l.union(ear).cut(cyl(1.7, z0 - 1, z0 + 4, 0, sy * EAR_Y))
    return l


def float_target():
    """Float with a flat top for the sensor to see. Print it upside down.

    An upturned cup: glue a foam disc inside it so it cannot flood.
    Modelled with its top face at z = 0.
    """
    r = PIPE_ID / 2 - FLOAT_GAP
    f = cyl(r, -FLOAT_RIM, 0).cut(cyl(r - FLOAT_T, -FLOAT_RIM - 1, -FLOAT_T))
    for i in range(4):
        g = box(r - 0.5, r + FLOAT_GUIDE, -1.5, 1.5, -FLOAT_RIM, 0)
        f = f.union(g.rotate((0, 0, 0), (0, 0, 1), 90 * i + 45))
    return f


PARTS = {"tube_cap": tube_cap, "sensor_lid": sensor_lid,
         "float_target": float_target}


def as_printed(part):
    """Flip a part upside down and sit it on the bed, centred.

    The parts are modelled where they sit on the pipe, so opened together they
    nest inside one another and hide the sensor window. The exports are in
    print orientation instead: flat top on the bed, no supports.
    """
    p = part.rotate((0, 0, 0), (1, 0, 0), 180)
    bb = p.val().BoundingBox()
    return p.translate((-(bb.xmin + bb.xmax) / 2, -(bb.ymin + bb.ymax) / 2,
                        -bb.zmin))

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, fn in PARTS.items():
        part = as_printed(fn())
        solid = part.val()
        bb = solid.BoundingBox()
        cq.exporters.export(part, str(OUT / f"{name}.step"))
        cq.exporters.export(part, str(OUT / f"{name}.stl"), tolerance=0.05)
        print(f"{name:13s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm"
              f"  solids={len(part.solids().vals())}"
              f"  solid PETG mass={solid.Volume() * 1.27 / 1000:5.0f} g")
    # the parts must not overlap each other or the pipe
    pipe = cyl(PIPE_OD / 2, -200, 0).cut(cyl(PIPE_ID / 2, -201, 1))
    unit = box(-UNIT_L / 2, UNIT_L / 2, -UNIT_W / 2, UNIT_W / 2,
               Z_TOP1, Z_TOP1 + UNIT_H)
    cap, lid = tube_cap(), sensor_lid()
    flt = float_target().translate((0, 0, -60))
    pairs = {"cap/pipe": (cap, pipe), "cap/lid": (cap, lid),
             "cap/unit": (cap, unit), "lid/unit": (lid, unit),
             "float/pipe": (flt, pipe)}
    for k, (a, b) in pairs.items():
        v = a.intersect(b).val().Volume()
        print(f"overlap {k:10s} {v:8.2f} mm3  {'OK' if v < 0.01 else 'CLASH'}")
