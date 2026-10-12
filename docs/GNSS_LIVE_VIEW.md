# GNSS Live View (blue location marker + signal panel)

Two things on the QZ1測量 map and in the ライブGNSS section, modelled on Google
Maps' blue dot and on the iOS GNSS Analyzer.

## 1. Blue "you are here" marker with a facing cone

Turned on with **現在地を表示**. A blue dot with a translucent cone showing which
way you are facing.

| Situation | Position from | Facing from |
|---|---|---|
| QZ1 streaming (fix in the last 5 s) | QZ1 GGA | RMC course over ground while moving (>= 0.7 m/s), else the phone compass |
| No QZ1 stream | Phone GPS (with accuracy circle) | Geolocation heading while moving, else the phone compass |
| Neither heading known | — | No cone is drawn (never a made-up direction) |

- Heading logic is pure and unit-tested: `js/gnss/heading.js`. Marker markup:
  `js/gnss/location-marker.js`; styles: `css/gnss-live.css`.
- Compass: Android Chrome reports a north-referenced heading on
  `deviceorientationabsolute`; iOS/Safari reports `webkitCompassHeading`. A
  relative `deviceorientation` event is rejected because its zero is not north.
  Chrome and Safari both ask for motion permission, so it is requested from the
  button tap.
- The QZ1 itself has no compass: standing still, the cone comes from the
  phone's magnetometer, and it can drift near metal (vehicles, steel gates).

## 2. GNSS signal panel (GNSS Analyzer style)

Inside ライブGNSS, whether or not a recording is running.

- **Status badge** that turns **green** (良好), **orange** (普通), **red** (不良)
  or grey (測位なし / 受信待ち).
- **Sky plot** (north up, centre = overhead) with every satellite in view, and a
  dark ring around the ones used in the solution.
- **C/N0 bars** per satellite (QZSS first).
- Built from GGA (fix), GSV (satellites), GSA (used PRNs) and RMC (course):
  `js/gnss/satellite-tracker.js`, `js/gnss/gnss-signal-view.js`.

### What the colours mean

`js/gnss/gnss-quality.js` is the single definition, used by both the badge and
the map points:

| Level | Rule |
|---|---|
| Good (green) | Augmented fix (GGA quality 2/4/5), HDOP <= 2 and >= 6 satellites (a missing HDOP/satellite count does not block it) |
| Fair (orange) | Any other valid fix |
| Poor (red) | HDOP > 5 or <= 3 satellites |
| None (grey) | No fix, or no fix for 5 s |

**This grades what the receiver reports. It is not an accuracy claim.** Fix
quality 2 shows the receiver was in a differential state; it does not prove
SLAS or CLAS was used, nor how many metres off the position is. The project
still makes no centimetre claim.

### Points while recording

Every GGA fix is plotted as it arrives, coloured by the same grading
(previously: green = augmented, orange = single). A fix with an augmented flag
but weak geometry is now orange or red instead of green.

## Tests

- Unit: `tests/unit/gnss-live-view.test.js`
- Browser (fake serial stream + fake geolocation/compass):
  `tests/browser/gnss-live-view.spec.js`

## Not verified

Not yet tried against a real QZ1 or on a phone: whether the QZ1 emits GSV for
every constellation (the panel simply shows what arrives), and compass accuracy
on a Pixel 6a.
