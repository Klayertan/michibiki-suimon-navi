"""Parts that go on the stake beside the water tube (PETG).

Run:  python stake.py             -> writes STEP + STL into ./exports
Needs CadQuery 2.x (pip install cadquery).

  stake_chassis   upright plate with a floor. The electronics tie onto it.
  stake_cover     hood that slides down over the chassis and sheds rain.
  panel_bracket   holds the solar panel tilted, above the tube.

All three strap to a round stake with zip ties in a V saddle, so the stake's
diameter does not have to be known. Edit PARAMETERS and re-run; do not edit
the exported files.

Coordinates: x across, y forward (away from the stake), z up.
"""
from pathlib import Path
import cadquery as cq
from sensor import box, cyl, as_printed

# ----------------------------------------------------------------- PARAMETERS
# What goes inside, for reference (published sizes, mm):
#   lithium cell 103450            50 x 34 x 10
#   bq25185 charger board          29.2 x 19.1
#   ATOMS3 Lite                    24 x 24 x 9.5, plus its plugs
#   E220-900T22S(JP)-EV1 board     36 x 21, 48.5 long with the SMA socket
INNER_W, INNER_H, INNER_D = 100.0, 125.0, 36.0
PLATE_T = 4.0
FLOOR_T = 7.0
WALL = 2.4
FIT = 0.4
GRID = 10.0              # pitch of the tie-down holes in the plate
GRID_HOLE = 3.6          # passes an M3 screw or a small zip tie
SADDLE_W, SADDLE_D = 30.0, 14.0
TIE_W, TIE_H = 3.0, 6.0  # slot for a zip tie
TIE_X = 19.0
ANT_SLOT = 14.0          # the antenna hangs down through the floor
CABLE_SLOT = 10.0
SCREW_PILOT = 2.6

# Solar panel: Akizuki SY-M3W, 251 x 140 x 18 mm (product page).
PANEL_T = 18.0
PANEL_SHORT = 140.0
TILT = 30.0              # degrees from horizontal
TABLE_L = 150.0
BRACKET_W = 110.0
TABLE_T = 4.0
SPINE_T = 6.0

OUT = Path(__file__).parent / "exports"
HALF = INNER_W / 2
Z_TOP = FLOOR_T + INNER_H


def saddle(z0, z1, width=SADDLE_W):
    """V block on the back of a plate at y = 0, with a 45 degree underside."""
    prof = [(0, z0), (-SADDLE_D, z0 + SADDLE_D), (-SADDLE_D, z1), (0, z1)]
    s = (cq.Workplane("YZ").polyline(prof).close().extrude(width)
         .translate((-width / 2, 0, 0)))
    v = (cq.Workplane("XY").polyline([(-13, -SADDLE_D - 1), (13, -SADDLE_D - 1),
                                      (0, -1.5)]).close()
         .extrude(z1 - z0 + 2).translate((0, 0, z0 - 1)))
    return s.cut(v)


def tie_slots(part, zs, y0, y1):
    for z in zs:
        for sx in (-1, 1):
            part = part.cut(box(sx * TIE_X - TIE_W / 2, sx * TIE_X + TIE_W / 2,
                                y0, y1, z - TIE_H / 2, z + TIE_H / 2))
    return part


def stake_chassis():
    c = box(-HALF, HALF, -PLATE_T, 0, 0, Z_TOP)                    # back plate
    c = c.union(box(-HALF, HALF, -PLATE_T, INNER_D, 0, FLOOR_T))   # floor
    c = c.union(saddle(30.0, 105.0).translate((0, -PLATE_T, 0)))
    c = tie_slots(c, (48.0, 90.0), -PLATE_T - 1, 1)
    z = FLOOR_T + 12.0
    while z < Z_TOP - 8:                                           # tie-down grid
        x = -HALF + 10.0
        while x <= HALF - 10.0:
            if abs(abs(x) - TIE_X) > 6 or min(abs(z - 48), abs(z - 90)) > 8:
                hole = (cq.Workplane("XZ").circle(GRID_HOLE / 2)
                        .extrude(PLATE_T + SADDLE_D + 2)
                        .translate((x, 1, z)))
                if abs(x) > SADDLE_W / 2 + 3:                      # not in the saddle
                    c = c.cut(hole)
            x += GRID
        z += GRID
    # openings in the floor, both open to the front edge
    c = c.cut(box(22, 22 + ANT_SLOT, 10, INNER_D + 1, -1, FLOOR_T + 1))
    c = c.cut(box(-34, -34 + CABLE_SLOT, 10, INNER_D + 1, -1, FLOOR_T + 1))
    # the cover's screw goes into the front edge of the floor
    pilot = (cq.Workplane("XZ").circle(SCREW_PILOT / 2).extrude(12)
             .translate((0, INNER_D + 1, FLOOR_T / 2)))
    return c.cut(pilot)


def stake_cover():
    """Hood: top, front and sides. It hooks behind the back plate."""
    xi = HALF + FIT
    yf = INNER_D + FIT
    yb = -PLATE_T - FIT
    zt = Z_TOP + FIT
    h = box(-xi - WALL, xi + WALL, yb - WALL, yf + WALL, 0, zt + WALL)
    h = h.cut(box(-xi, xi, yb, yf, -1, zt))                        # cavity
    # open the back, leaving a rail down each edge and a lip across the top
    h = h.cut(box(-xi + 1.6, xi - 1.6, yb - WALL - 1, yb + 0.01, -1, zt - 12))
    screw = (cq.Workplane("XZ").circle(1.7).extrude(WALL + 2)
             .translate((0, yf + WALL + 1, FLOOR_T / 2)))
    return h.cut(screw)


def panel_bracket():
    """Constant profile across its width, so it prints on its side unsupported."""
    import math
    a = math.radians(TILT)
    c_, s_ = math.cos(a), math.sin(a)
    drop = TABLE_L * s_
    spine_h = drop + 22.0
    zt = spine_h - 3.0                       # high edge of the table, at the spine

    def tp(u, w):                            # table coords -> (y, z)
        return (SPINE_T - 1 + u * c_ + w * s_, zt - u * s_ + w * c_)

    lip_h = TABLE_T + PANEL_T + 0.7
    table = [tp(0, 0), tp(TABLE_L, 0), tp(TABLE_L + 4, 0), tp(TABLE_L + 4, lip_h + 3),
             tp(TABLE_L - 5, lip_h + 3), tp(TABLE_L - 5, lip_h), tp(TABLE_L, lip_h),
             tp(TABLE_L, TABLE_T), tp(0, TABLE_T)]
    brace = [(SPINE_T - 1, 4), (SPINE_T - 1, 12), tp(TABLE_L - 22, 0.5),
             tp(TABLE_L - 14, 0.5)]
    spine = [(0, 0), (SPINE_T, 0), (SPINE_T, spine_h), (0, spine_h)]
    b = None
    for prof in (spine, table, brace):
        p = (cq.Workplane("YZ").polyline(prof).close().extrude(BRACKET_W)
             .translate((-BRACKET_W / 2, 0, 0)))
        b = p if b is None else b.union(p)
    # full-width saddle, so nothing overhangs when the part prints on its side
    b = b.union(saddle(8.0, spine_h - 8.0, BRACKET_W))
    b = tie_slots(b, (30.0, spine_h - 22.0), -SADDLE_D - 1, SPINE_T + 1)
    # four slots through the table, for straps or zip ties round the panel
    for u in (22.0, TABLE_L - 40.0):
        for sx in (-1, 1):
            slot = (box(sx * 42 - 4, sx * 42 + 4, u - 1.5, u + 1.5, -3, TABLE_T + 3)
                    .rotate((0, 0, 0), (1, 0, 0), -TILT)
                    .translate((0, SPINE_T - 1, zt)))
            b = b.cut(slot)
    return b


PARTS = {"stake_chassis": (stake_chassis, None),
         "stake_cover": (stake_cover, "flip"),
         "panel_bracket": (panel_bracket, "side")}


def printable(part, how):
    if how == "flip":
        return as_printed(part)
    if how == "side":
        part = part.rotate((0, 0, 0), (0, 1, 0), 90)
    bb = part.val().BoundingBox()
    return part.translate((-(bb.xmin + bb.xmax) / 2, -(bb.ymin + bb.ymax) / 2,
                           -bb.zmin))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, (fn, how) in PARTS.items():
        part = printable(fn(), how)
        solid = part.val()
        bb = solid.BoundingBox()
        cq.exporters.export(part, str(OUT / f"{name}.step"))
        cq.exporters.export(part, str(OUT / f"{name}.stl"), tolerance=0.05)
        print(f"{name:14s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm"
              f"  solids={len(part.solids().vals())}"
              f"  solid PETG mass={solid.Volume() * 1.27 / 1000:5.0f} g")
    v = stake_chassis().intersect(stake_cover()).val().Volume()
    print(f"overlap chassis/cover {v:8.2f} mm3  {'OK' if v < 0.01 else 'CLASH'}")
    panel = box(-125.5, 125.5, 0, PANEL_SHORT, 0, PANEL_T)
    import math
    a = math.radians(TILT)
    zt = TABLE_L * math.sin(a) + 22.0 - 3.0
    placed = (panel.translate((0, TABLE_L - PANEL_SHORT - 0.2, TABLE_T + 0.2))
              .rotate((0, 0, 0), (1, 0, 0), -TILT)
              .translate((0, SPINE_T - 1, zt)))
    v = panel_bracket().intersect(placed).val().Volume()
    print(f"overlap bracket/panel {v:8.2f} mm3  {'OK' if v < 0.01 else 'CLASH'}")
