"""Check the mounts against Holybro's frame model.

Run:  python check_fit.py /path/to/x500v2-frame.step
Loads the official STEP (slow, about 2-3 minutes), places each part where it
is installed and reports any volume it shares with a frame solid.
"""
import sys
import cadquery as cq
import mounts as m

frame = cq.importers.importStep(sys.argv[1]).solids().vals()
# The stock battery board and its two hangers. The tray replaces them.
REMOVED = {176, 177, 178, 179, 192, 193, 194, 195}
RAILS = {158, 159}


def place_under(part):   # tray coords -> frame coords (frame Y is up)
    return (part.rotate((0, 0, 0), (1, 0, 0), -90)
            .translate((m.TRAY_X_IN_FRAME, -m.RAIL_TO_PLATE, 0)).val())


def place_top(part):     # deck coords -> frame coords; top plate top is Y=32
    return (part.rotate((0, 0, 0), (1, 0, 0), -90)
            .translate((0, 32.0 + m.STANDOFF_H, 0)).val())


placed = {
    "battery_tray": place_under(m.battery_tray()),
    "camera (D435 under the tray)": place_under(m.camera_dummy()),
    "jetson_deck": place_top(m.jetson_deck()),
    "jetson_hoop": place_top(m.jetson_hoop()),
    "qz1_mast": place_top(m.qz1_mast()),
}
ok = True
for name, part in placed.items():
    pb = part.BoundingBox()
    hits = []
    for i, s in enumerate(frame):
        if i in REMOVED:
            continue
        b = s.BoundingBox()
        if (b.xmax < pb.xmin or b.xmin > pb.xmax or b.ymax < pb.ymin or
                b.ymin > pb.ymax or b.zmax < pb.zmin or b.zmin > pb.zmax):
            continue
        v = part.intersect(s).Volume()
        if v > 0.01:
            hits.append((i, round(v, 2), [round(x, 1) for x in
                         (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax)]))
    print(f"{name}: lowest point {pb.ymin + 215.28:.1f} mm above the ground,"
          f" {'CLASH ' + str(hits) if hits else 'no clash with the frame'}")
    ok = ok and not hits

# Installing the tray: it starts shifted sideways and slides onto the rails.
tray = m.battery_tray()
for shift in range(2, int(m.SLIDE_ON) + 2, 2):
    part = place_under(tray.translate((0, shift, 0)))
    pb = part.BoundingBox()
    hits = []
    for i, s in enumerate(frame):
        if i in REMOVED or i in RAILS:   # the hook mouths snap over the rails
            continue
        b = s.BoundingBox()
        if (b.xmax < pb.xmin or b.xmin > pb.xmax or b.ymax < pb.ymin or
                b.ymin > pb.ymax or b.zmax < pb.zmin or b.zmin > pb.zmax):
            continue
        v = part.intersect(s).Volume()
        if v > 0.01:
            hits.append((i, round(v, 2)))
    print(f"tray slid {shift:2d} mm off the rails: {'CLASH ' + str(hits) if hits else 'clear'}")
    ok = ok and not hits
sys.exit(0 if ok else 1)
