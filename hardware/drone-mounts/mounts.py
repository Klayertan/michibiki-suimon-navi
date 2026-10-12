"""Parametric payload mounts for the Holybro X500 V2 (PETG).

Run:  python mounts.py            -> writes STEP + STL into ./exports
Needs CadQuery 2.x (pip install cadquery).

Every number that comes from a real part is in the PARAMETERS block, with its
source. Change a parameter and re-run; do not edit the exported files.

Coordinates used for the under-slung parts (tray, camera pod):
    x  along the rails, + toward the platform board (the GPS mast end)
    y  across the drone
    z  up, z = 0 at the centre line of the two rails
"""
from pathlib import Path
import cadquery as cq

# ----------------------------------------------------------------- PARAMETERS
# Frame. Read from Holybro's x500v2-frame.step (docs.holybro.com).
RAIL_SPACING = 60.0      # centre to centre
RAIL_DIA = 10.0          # published value; the STEP models 9.4
RAIL_CLEAR = 0.3         # radial clearance in the hook
RAIL_TO_PLATE = 13.0     # rail centre below the underside of the bottom plate
TRAY_X_IN_FRAME = -6.7   # tray centre relative to the frame centre (see README)
TOP_PLATE_HOLES = [(50, 37), (50, -37), (-50, 37), (-50, -37)]  # M3, top plate

# Battery. Zeee 4S 3300 mAh, from seller listings. Check your own pack.
BAT_L, BAT_W, BAT_H = 132.0, 44.0, 29.0
FOAM_BOTTOM = 10.0       # foam under the pack (not printed)
FOAM_SIDE = 3.0          # foam on each side and at the front
HEADROOM = 2.0

# Jetson Orin Nano developer kit. Read from NVIDIA's STEP model.
JET_HOLE_X, JET_HOLE_Y = 86.0, 58.0   # M2.5 mounting holes
JET_PCB_X, JET_PCB_Y = 100.0, 79.0
JET_HOLE_OFF = (4.0, 17.0)            # first hole from the PCB corner
JET_TOP_ABOVE_PCB = 28.3              # fan top above the PCB underside + 1.57
STANDOFF_H = 35.0                     # bought M3 standoffs under the deck

# RealSense D435. From memory of Intel's datasheet. CHECK before printing.
CAM_L, CAM_D, CAM_H = 90.0, 25.0, 25.0   # length, depth, height (lens axis)
CAM_M3_SPACING = 45.0                    # two M3 threads on the back

# Print / structure
WALL = 2.4
FLOOR = 2.4
HOOK_T = 4.0
HOOK_W = 14.0
HOOK_ARM = 3.0           # arm length past the rail; short, to clear the frame
SLIDE_ON = 14.0          # sideways travel needed to hook onto the rails
HOOK_X = (-21.3, 34.7)   # hook centres along the tray. The only stretch of
                         # rail clear of the hangers, the arm bolts and the
                         # block on the side of the body (see check_fit.py)
STRAP_X = (-50.0, 5.0)   # strap tunnels, clear of the hooks
CRUSH_H = 20.0           # sacrificial crush layer under the tray
CRUSH_WALL = 0.8         # two 0.4 mm perimeters
CRUSH_RIBS = 4           # fewer ribs = softer crush layer
SOLE = 0.8
DECK_T = 3.0
BOSS_H = 6.0
HOOP_CLEAR = 8.0         # hoop underside above the Jetson fan
GLASS_SETBACK = 12.0     # camera glass above the bottom of the skid bars

OUT = Path(__file__).parent / "exports"


def box(x0, x1, y0, y1, z0, z1):
    return (cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0, centered=False)
            .translate((x0, y0, z0)))


def cyl_x(r, x0, x1, y, z):
    return cq.Workplane("YZ").circle(r).extrude(x1 - x0).translate((x0, y, z))


def cyl_y(r, y0, y1, x, z):
    return cq.Workplane("XZ").circle(r).extrude(-(y1 - y0)).translate((x, y0, z))


def cyl_z(r, z0, z1, x, y):
    return cq.Workplane("XY").circle(r).extrude(z1 - z0).translate((x, y, z0))


# ------------------------------------------------------------- derived values
RC = RAIL_DIA / 2 + RAIL_CLEAR
L_IN = BAT_L + 2.0 + FOAM_SIDE
W_IN = BAT_W + 2 * FOAM_SIDE
H_IN = BAT_H + FOAM_BOTTOM + HEADROOM
W_OUT = W_IN + 2 * WALL
L_OUT = L_IN + WALL                    # front wall only; the rear is open
X_REAR, X_FRONT = -L_OUT / 2, L_OUT / 2
WALL_TOP = -11.0                       # stays under the frame's rail hangers
FLOOR_TOP = WALL_TOP - H_IN
FLOOR_BOT = FLOOR_TOP - FLOOR
SOLE_BOT = FLOOR_BOT - CRUSH_H - SOLE
POD_HOLES = [(16.0, -22.0), (-16.0, -22.0), (0.0, -46.0)]   # (y, z)


def hook(yc, xc, rc=None):
    """C-hook that slides sideways onto a rail and carries the tray.

    Built with its mouth toward +y, then mirrored so the mouth faces -y. The
    frame is not mirror-symmetric: a part bolted to one side of the body blocks
    the tray from sliding on from that side (found with check_fit.py).
    """
    rc = RC if rc is None else rc
    y0, y1 = yc - rc - HOOK_T, yc + rc + HOOK_ARM
    zt = rc + HOOK_T
    x0, x1 = xc - HOOK_W / 2, xc + HOOK_W / 2
    h = box(x0, x1, y0, y1, -zt, zt)
    h = h.union(box(x0, x1, y0, y1, WALL_TOP - 0.5, -zt + 0.01))      # web
    h = h.cut(cyl_x(rc, x0 - 1, x1 + 1, yc, 0))
    # mouth 0.3 mm narrower than the rail, so the rail snaps in
    h = h.cut(box(x0 - 1, x1 + 1, yc, y1 + 1, -rc + 0.45, rc - 0.45))
    return h.mirror("XZ")


def hook_test(rail_dia=RAIL_DIA):
    """Fit test: the two hooks of one tray cross-section on a plain bar.

    Checks the rail diameter, the snap fit and the rail spacing in a short
    print. Exported lying flat, so it needs no supports. The layers run the
    other way from the real tray, so it says nothing about strength.
    """
    rc = rail_dia / 2 + RAIL_CLEAR
    half = RAIL_SPACING / 2 + rc + HOOK_T
    t = box(-HOOK_W / 2, HOOK_W / 2, -half, half, WALL_TOP - 6.5, WALL_TOP - 0.4)
    for yc in (-RAIL_SPACING / 2, RAIL_SPACING / 2):
        t = t.union(hook(yc, 0.0, rc))
    if rail_dia < RAIL_DIA:        # a hole in the bar marks the smaller size
        t = t.cut(cyl_x(2.0, -HOOK_W, HOOK_W, 0, WALL_TOP - 3.5))
    return t.rotate((0, 0, 0), (0, 1, 0), 90)


def battery_tray():
    t = box(X_REAR, X_FRONT, -W_OUT / 2, W_OUT / 2, FLOOR_BOT, WALL_TOP)
    t = t.cut(box(X_REAR - 1, X_FRONT - WALL, -W_IN / 2, W_IN / 2,
                  FLOOR_TOP, WALL_TOP + 1))
    # crush layer: thin lengthwise ribs closed by a thin sole
    span = W_OUT - CRUSH_WALL
    for i in range(CRUSH_RIBS):
        y = -span / 2 + i * span / (CRUSH_RIBS - 1)
        t = t.union(box(X_REAR, X_FRONT, y - CRUSH_WALL / 2, y + CRUSH_WALL / 2,
                        FLOOR_BOT - CRUSH_H, FLOOR_BOT + 0.01))
    t = t.union(box(X_REAR, X_FRONT, -W_OUT / 2, W_OUT / 2,
                    SOLE_BOT, FLOOR_BOT - CRUSH_H + 0.01))
    for x in STRAP_X:                                      # strap tunnels
        t = t.cut(box(x - 12, x + 12, -W_OUT / 2 - 1, W_OUT / 2 + 1,
                      FLOOR_BOT - 4.0, FLOOR_BOT))
    for yc in (-RAIL_SPACING / 2, RAIL_SPACING / 2):
        for xc in HOOK_X:
            t = t.union(hook(yc, xc))
    # the interior must stay clear where hook webs cross it
    t = t.cut(box(X_REAR - 1, X_FRONT - WALL, -W_IN / 2, W_IN / 2,
                  FLOOR_TOP, WALL_TOP - 0.5))
    t = t.cut(cyl_y(2.0, -W_OUT / 2 - 1, W_OUT / 2 + 1, X_REAR + 6, WALL_TOP - 14))
    for xc in HOOK_X:                  # zip-tie holes that lock tray to rail
        t = t.cut(cyl_y(1.8, -W_OUT / 2 - 1, W_OUT / 2 + 1,
                        xc + HOOK_W / 2 + 4, WALL_TOP - 5))
    for y, z in POD_HOLES:
        t = t.cut(cyl_x(1.7, X_FRONT - WALL - 1, X_FRONT + 1, y, z))
    return t


POD_BACK = 4.0
POD_HALF = CAM_L / 2 + 5.0
CAM_POCKET = CAM_D + 1.0
BAR_BOT = SOLE_BOT + 8.0               # the tray sole touches the ground first
GLASS_Z = BAR_BOT + GLASS_SETBACK
ROOF_BOT = GLASS_Z + CAM_H
ROOF_TOP = ROOF_BOT + 3.0
POD_TOP = -16.0                        # stays under the frame's platform board


def camera_pod():
    xb = X_FRONT
    xf = xb + POD_BACK + CAM_POCKET
    p = box(xb, xb + POD_BACK, -POD_HALF, POD_HALF, BAR_BOT, POD_TOP)
    p = p.union(box(xf, xf + POD_BACK, -POD_HALF, POD_HALF, BAR_BOT, ROOF_TOP))
    p = p.union(box(xb, xf + POD_BACK, -POD_HALF, POD_HALF, ROOF_BOT, ROOF_TOP))
    xc = xb + POD_BACK + CAM_POCKET / 2
    for y in (-CAM_M3_SPACING / 2, CAM_M3_SPACING / 2):
        p = p.cut(cyl_z(1.7, ROOF_BOT - 1, ROOF_TOP + 1, xc, y))
    for y, z in POD_HOLES:
        p = p.cut(cyl_x(1.7, xb - 1, xb + POD_BACK + 1, y, z))
        nut = (cq.Workplane("YZ").polygon(6, 6.5).extrude(2.7)
               .translate((xb + POD_BACK - 2.6, y, z)))
        p = p.cut(nut)
    return p


# Jetson deck, local coords: origin at the centre of the Jetson hole pattern,
# z = 0 on the underside of the deck.
DECK_X = 64.0
DECK_Y0, DECK_Y1 = -59.0, 48.0
HOOP_LEGS = [(59.0, -54.0), (-59.0, -54.0), (59.0, 43.0), (-59.0, 43.0)]
HOOP_H = BOSS_H + 1.6 + JET_TOP_ABOVE_PCB + HOOP_CLEAR


def jetson_deck():
    d = box(-DECK_X, DECK_X, DECK_Y0, DECK_Y1, 0, DECK_T)
    d = d.edges("|Z").fillet(6.0)
    d = d.cut(box(-30, 30, -20, 20, -1, DECK_T + 1).edges("|Z").fillet(5.0))
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * JET_HOLE_X / 2, sy * JET_HOLE_Y / 2
            d = d.union(cyl_z(3.5, DECK_T - 0.01, DECK_T + BOSS_H, x, y))
            d = d.cut(cyl_z(1.05, -1, DECK_T + BOSS_H + 1, x, y))
    for x, y in TOP_PLATE_HOLES:
        d = d.cut(cyl_z(1.7, -1, DECK_T + 1, x, y))
    for x, y in HOOP_LEGS:
        d = d.cut(cyl_z(1.7, -1, DECK_T + 1, x, y))
    return d


def jetson_hoop():
    """Roll hoop. Modelled as mounted; print it upside down (ring on the bed)."""
    z0, z1 = DECK_T, DECK_T + HOOP_H
    ring = box(-63, 63, -58, 47, z1, z1 + 5.0).edges("|Z").fillet(6.0)
    ring = ring.cut(box(-55, 55, -50, 39, z1 - 1, z1 + 6).edges("|Z").fillet(3.0))
    h = ring
    for x, y in HOOP_LEGS:
        h = h.union(box(x - 4, x + 4, y - 4, y + 4, z0, z1 + 0.01))
        h = h.cut(cyl_z(1.3, z0 - 1, z0 + 12, x, y))
    return h


PARTS = {
    "hook_test_10.0mm": hook_test,
    "hook_test_9.4mm": lambda: hook_test(9.4),
    "battery_tray": battery_tray,
    "camera_pod": camera_pod,
    "jetson_deck": jetson_deck,
    "jetson_hoop": jetson_hoop,
}

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, fn in PARTS.items():
        part = fn()
        solid = part.val()
        bb = solid.BoundingBox()
        cq.exporters.export(part, str(OUT / f"{name}.step"))
        cq.exporters.export(part, str(OUT / f"{name}.stl"), tolerance=0.05)
        print(f"{name:17s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm"
              f"  solids={len(part.solids().vals())}"
              f"  solid PETG mass={solid.Volume() * 1.27 / 1000:5.0f} g")
