"""Parametric payload mounts for the Holybro X500 V2 (PETG).

Run:  python mounts.py            -> writes STEP + STL into ./exports
Needs CadQuery 2.x (pip install cadquery).

Every number that comes from a real part is in the PARAMETERS block, with its
source. Change a parameter and re-run; do not edit the exported files.

Coordinates used for the under-slung part (tray, with the camera under it):
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

# RealSense D435. Size from Intel's product page (ark.intel.com, 128255).
# Thread depth from an Intel community answer citing the D400 datasheet.
CAM_L, CAM_D, CAM_H = 90.0, 25.0, 25.0   # length, height, depth (lens axis)
CAM_M3_SPACING = 45.0                    # two M3 threads on the back
CAM_M3_DEPTH = 3.0                       # never screw deeper than this

# QZ1 GNSS receiver. From the QZSS spec sheet (qzss.go.jp, qz1.pdf).
QZ1_L, QZ1_W, QZ1_H = 83.5, 49.8, 18.0   # about 65 g, own battery, micro-USB

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
CRUSH_WALL = 0.8         # two 0.4 mm perimeters; thinner = softer crush layer
SOLE = 0.8
DECK_T = 3.0
BOSS_H = 6.0
HOOP_CLEAR = 8.0         # hoop underside above the Jetson fan
GLASS_SETBACK = 12.0     # camera glass above the bottom of the tray sole
CAM_BEAM_H = 5.6         # beams the camera hangs from; the straps pass over it
CAM_BEAM_X = (-CAM_M3_SPACING / 2, CAM_M3_SPACING / 2)
CAM_SCREW = 10.0         # M3 x 10 through floor and beam into the camera
FOV_MARGIN = 12.0        # sole window past each camera end (87 deg depth FOV)
QZ1_X = -70.0            # QZ1 centre, deck coords; the GPS mast is at +x
QZ1_MAST_H = 50.0        # top of the hoop ring to the underside of the cradle
QZ1_MAST_Y = (-40.0, 30.0)
QZ1_SCREW_Y = (-25.0, 15.0)   # M3 from under the hoop ring into the mast

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
GLASS_Z = FLOOR_BOT - CAM_BEAM_H - CAM_H   # camera hangs under the floor
SOLE_BOT = GLASS_Z - GLASS_SETBACK
CRUSH_H = FLOOR_BOT - SOLE - SOLE_BOT      # follows from the camera
BAY_Y = CAM_D / 2 + 1.0                    # camera bay half-width
RIB_Y = [-(W_OUT - CRUSH_WALL) / 2, -BAY_Y - CRUSH_WALL / 2,
         BAY_Y + CRUSH_WALL / 2, (W_OUT - CRUSH_WALL) / 2]
assert CAM_SCREW - (FLOOR + CAM_BEAM_H) <= CAM_M3_DEPTH - 0.4


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
    # crush layer: thin lengthwise ribs closed by a thin sole. The two middle
    # ribs are the walls of the camera bay.
    for y in RIB_Y:
        t = t.union(box(X_REAR, X_FRONT, y - CRUSH_WALL / 2, y + CRUSH_WALL / 2,
                        FLOOR_BOT - CRUSH_H, FLOOR_BOT + 0.01))
    t = t.union(box(X_REAR, X_FRONT, -W_OUT / 2, W_OUT / 2,
                    SOLE_BOT, FLOOR_BOT - CRUSH_H + 0.01))
    # window in the sole under the camera, wide enough for the depth FOV
    wx = CAM_L / 2 + FOV_MARGIN
    t = t.cut(box(-wx, wx, -BAY_Y, BAY_Y, SOLE_BOT - 1, FLOOR_BOT - CRUSH_H + 0.5))
    # two beams bridging the bay; the camera's back screws to them
    for x in CAM_BEAM_X:
        t = t.union(box(x - 4, x + 4, -BAY_Y - 0.1, BAY_Y + 0.1,
                        FLOOR_BOT - CAM_BEAM_H, FLOOR_BOT + 0.01))
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
    for x in CAM_BEAM_X:               # camera screws, from inside the tray
        t = t.cut(cyl_z(1.7, FLOOR_BOT - CAM_BEAM_H - 1, FLOOR_TOP + 1, x, 0))
    return t


def camera_dummy():
    """The D435 where it hangs, for clash checks only. Not printed."""
    return box(-CAM_L / 2, CAM_L / 2, -CAM_D / 2, CAM_D / 2,
               GLASS_Z, GLASS_Z + CAM_H)


# Jetson deck, local coords: origin at the centre of the Jetson hole pattern,
# z = 0 on the underside of the deck.
DECK_X = 64.0
DECK_Y0, DECK_Y1 = -59.0, 48.0
HOOP_LEGS = [(59.0, -54.0), (-59.0, -54.0), (59.0, 43.0), (-59.0, 43.0)]
HOOP_H = BOSS_H + 1.6 + JET_TOP_ABOVE_PCB + HOOP_CLEAR
RING_T = 5.0
RING_TOP = DECK_T + HOOP_H + RING_T
RING_X = (-63.0, -55.0)          # the hoop ring's band at the -x end


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
    ring = box(-63, 63, -58, 47, z1, z1 + RING_T).edges("|Z").fillet(6.0)
    ring = ring.cut(box(-55, 55, -50, 39, z1 - 1, z1 + 6).edges("|Z").fillet(3.0))
    h = ring
    for x, y in HOOP_LEGS:
        h = h.union(box(x - 4, x + 4, y - 4, y + 4, z0, z1 + 0.01))
        h = h.cut(cyl_z(1.3, z0 - 1, z0 + 12, x, y))
    xm = sum(RING_X) / 2
    for y in QZ1_SCREW_Y:              # clearance holes for the QZ1 mast
        h = h.cut(cyl_z(1.7, z1 - 1, RING_TOP + 1, xm, y))
    return h


def qz1_mast():
    """Mast and cradle for the QZ1, on the hoop ring at the end away from the
    drone's own GPS mast. Modelled as mounted, deck coords. Print it standing
    on one of its end faces (y), so every layer is the side profile and it
    needs no supports.

    The QZ1 lies face up on a foam pad and is held by two hook-and-loop straps
    through the slots. Both short ends are open, so its micro-USB port can be
    reached whichever end it is on.
    """
    y0, y1 = QZ1_MAST_Y
    xm = sum(RING_X) / 2
    z_cradle = RING_TOP + QZ1_MAST_H
    m = box(RING_X[0], RING_X[1], y0, y1, RING_TOP, z_cradle + 0.01)      # web
    hx = QZ1_W / 2 + 7.0
    m = m.union(box(QZ1_X - hx, QZ1_X + hx, y0, y1, z_cradle, z_cradle + 3.0))
    # fillet-like brace between web and cradle on the inboard side
    brace = (cq.Workplane("XZ")
             .polyline([(RING_X[1] - 0.01, z_cradle - 18.0),
                        (RING_X[1] - 0.01, z_cradle + 0.01),
                        (RING_X[1] + 14.0, z_cradle + 0.01)]).close()
             .extrude(-(y1 - y0)).translate((0, y0, 0)))
    brace_out = brace.mirror("YZ", (xm, 0, 0))
    m = m.union(brace).union(brace_out)
    for x in (QZ1_X - QZ1_W / 2 - 3.0, QZ1_X + QZ1_W / 2 + 3.0):  # strap slots
        for y in ((y0 + 4.0, y0 + 24.0), (y1 - 24.0, y1 - 4.0)):
            m = m.cut(box(x - 1.5, x + 1.5, y[0], y[1],
                          z_cradle - 1, z_cradle + 4))
    for y in QZ1_SCREW_Y:              # M3 self-tapping pilot holes
        m = m.cut(cyl_z(1.3, RING_TOP - 1, RING_TOP + 14, xm, y))
    return m


PARTS = {
    "hook_test_10.0mm": hook_test,
    "hook_test_9.4mm": lambda: hook_test(9.4),
    "battery_tray": battery_tray,
    "qz1_mast": qz1_mast,
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
