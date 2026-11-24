"""Read the rooms off a floor-plan sheet, so tracing starts from a first draft.

Tracing a floor by hand is mostly transcription: the walls on the sheet already
say where the rooms are, and a hundred offices is a hundred rectangles somebody
has to draw around something already drawn. What a picture cannot settle is
which number belongs to which patch -- the labels are curves, not text, in
every one of these PDFs -- so that stays a person's job, and this splits the
work at the seam: the shapes come off the sheet, and the numbers are read off
contact sheets, one card per room with its own label highlighted.

    py -3 floorPlans/trace_from_sheet.py cards SW1-Floor3
        -> floorPlans/_sheets/SW1-Floor3_c00.png ... and a _seg.json

    (read the cards; write floorPlans/_sheets/SW1-Floor3.txt as
     "<card #> <room> <USE-CODE>" a line, leaving out the cards that are not
     rooms -- a seating bay, the cavity inside a double-drawn wall)

    py -3 floorPlans/trace_from_sheet.py write SW1-Floor3
        -> public/data/floor-coordinates/SW1-Floor3.geojson

Everything is in the pixel frame of public/data/floorplan-images/{FLOOR}.png,
which is the frame _placements.json is calibrated in, so u = x/W, v = y/H is
the tracer's own uv and world coordinates follow from the placement. Which also
means a floor written here is only as square with the campus as its placement
is: the shapes are right relative to each other whatever the placement says, so
a floor that lands crooked is moved in the tracer, not re-read here.

Nothing here is meant to be final. It is meant to be nearer than an empty floor.
"""
import sys, os, json, math, argparse
from collections import Counter

import cv2
import numpy as np
import pymupdf

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMG_DIR = os.path.join(REPO, "public", "data", "floorplan-images")
PDF_DIR = os.path.join(REPO, "public", "data", "floorplans")
OUT_DIR = os.path.join(REPO, "public", "data", "floor-coordinates")
WORK_DIR = os.path.join(os.path.dirname(__file__), "_sheets")

ZOOM = 3.0                    # what render_plan_images.py rendered at
WHITE_CUTOFF, MARGIN_PX = 245, 12
R_EARTH = 6378137.0

# How hard to seal the doorways, tried in turn. A door is a gap in a wall about
# a metre wide: seal it loosely and a lecture theatre runs into the corridor and
# takes six rooms with it, seal it hard and the janitor closet closes up
# altogether. So every seal is tried, and a room is kept from the loosest one
# that encloses exactly one label -- one room, one number, and the least
# distortion that gets there.
# With the doorways already bridged, most rooms close at the lightest touch.
# The wider seals stay for the sheets that are drawn too loosely to bridge.
SEALS = (3, 5, 7, 11, 15, 21, 29, 37)

# Which ink to read the walls from, per sheet, tried in order. A sheet is often
# two drawings -- a wing surveyed in one decade and a wing in another, with
# different pens -- so there is no one answer to which lineweight the walls are,
# and the honest thing is to try each and let the labels say which worked where.
# `widths` are PDF stroke weights; `layers` are CAD layer names, on the sheets
# whose export kept them; an empty dict means the rendered sheet, ink and all.
# The walls and what stands in for a wall: a door leaf and a jamb close an
# opening, glazing and a sill close a window. Not DSWING, which is the quarter
# circle a door sweeps -- an arc drawn across the floor of the room, and putting
# it in the walls bites that arc out of the room. Not STAIR either: treads are
# drawn inside the shaft, and treating them as walls slices a stairwell into a
# dozen slivers, none of which is the stairwell.
WALLS = ["WALL", "JAMB", "DOOR", "GLAZE", "SILL", "A-DR-FR", "A-DOOR"]
SHEETS = {
    "SW1-Floor1": dict(inks=[{"widths": [0.54, 0.72]},
                             {"widths": [0.12, 0.36, 0.42, 0.54, 0.72]}, {}]),
    "SW1-Floor2": dict(inks=[{"widths": [0.12, 0.36, 0.42, 0.54, 0.72]},
                             {"widths": [0.12]}, {}]),
    # Walls first, so the shapes that come out clean come out clean; then the
    # same walls with the stair treads added, because a few stairwells are only
    # closed by them, and a notchy stairwell beats no stairwell.
    "SW1-Floor3": dict(inks=[{"layers": WALLS}, {"layers": WALLS + ["STAIR"]}, {}]),
    "SW1-Floor4": dict(inks=[{"layers": WALLS}, {"layers": WALLS + ["STAIR"]}, {}]),
    "SE12-Floor1": dict(inks=[{"widths": [0.42, 0.54, 1.14]},
                              {"widths": [0.54, 1.14]}, {}], rot=90, pxm=28.4),
}
DEFAULT = dict(inks=[{}])

# The use code written under the room number, as this map says it. Two questions,
# not one: what the router may send you to (`type`), and what to call it when it
# gets there (`name`). A shaft and a storeroom are both service; only one of them
# has a name worth printing on a map.
USE = {
    "OFFICE": ("room", "Office"), "OFFICE-OPN": ("room", "Office"),
    "CLASS": ("room", "Classroom"), "LECTURE": ("room", "Lecture Hall"),
    "MEETING": ("room", "Meeting Room"), "STAFF": ("room", "Staff Room"),
    "RECEPTION": ("room", "Reception"), "RESOURCE": ("room", "Resources"),
    "PROJECTS": ("room", "Projects Room"), "PROJECT-ROOM": ("room", "Projects Room"),
    "LAB-COMP-G": ("room", "Computer Lab"), "LAB-COMP-S": ("room", "Computer Lab"),
    "LAB-COMP-C": ("room", "Computer Lab"),
    "LAB-ELEC-G": ("room", "Electrical Lab"), "LAB-ELEC-S": ("room", "Electrical Lab"),
    "LAB-ELEC-C": ("room", "Electrical Lab"),
    "LAB-LSCI-G": ("room", "Life Sciences Lab"), "LAB-LSCI-S": ("room", "Life Sciences Lab"),
    "LAB-PSCI-G": ("room", "Physical Sciences Lab"), "LAB-PSCI-S": ("room", "Physical Sciences Lab"),
    "LAB-MEDIA": ("room", "Media Lab"), "LAB-PRODUC": ("room", "Production Lab"),
    "FOOD-PREP": ("room", "Kitchen"), "WASHUP": ("room", "Washup Room"),
    "WASH-RM-M": ("room", "Men's Washroom"), "WASH-RM-MH": ("room", "Men's Washroom"),
    "WASH-RM-F": ("room", "Women's Washroom"), "WASH-RM-FH": ("room", "Women's Washroom"),
    "WASH-RM": ("room", "Washroom"),
    "LOBBY": ("hallway", "Lobby"), "CORRIDOR": ("hallway", None),
    "VESTIBULE": ("hallway", "Vestibule"), "MEZZANINE": ("hallway", "Mezzanine"),
    "STAIR": ("stairs", None), "ELEV": ("elevator", None),
    "STOR-GEN": ("service", "Storage"), "STOR-FILE": ("service", "Storage"),
    "STOR-SHOP": ("service", "Storage"), "FOOD-CLDST": ("service", "Storage"),
    "SUPP-INST": ("service", "Supply Closet"), "JANITOR": ("service", "Janitor"),
    "COMM": ("service", "Communications"), "ELEC": ("service", "Electrical"),
    "MECH": ("service", "Mechanical"), "SHAFT": ("service", None),
    "AV": ("service", "AV Room"), "VAULT": ("service", "Vault"),
}


# ---------------------------------------------------------------------------
# The sheet, and the walls on it
# ---------------------------------------------------------------------------
def load(name):
    img = cv2.imread(os.path.join(IMG_DIR, name + ".png"), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit("no rendered sheet for " + name)
    return img


def placement(name):
    with open(os.path.join(IMG_DIR, "_placements.json"), encoding="utf-8") as fh:
        return json.load(fh).get(name)


def ink_crop(page):
    """The crop render_plan_images.py applied, so the vectors land on the PNG."""
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM))
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    grey = arr[:, :, :3].min(axis=2) if pix.n >= 3 else arr[:, :, 0]
    ink = grey < WHITE_CUTOFF
    rows, cols = np.flatnonzero(ink.any(axis=1)), np.flatnonzero(ink.any(axis=0))
    return (max(int(cols[0]) - MARGIN_PX, 0), max(int(rows[0]) - MARGIN_PX, 0),
            min(int(cols[-1]) + MARGIN_PX, pix.width - 1),
            min(int(rows[-1]) + MARGIN_PX, pix.height - 1))


def _points(item):
    if item[0] == "l":
        return [(item[1].x, item[1].y), (item[2].x, item[2].y)]
    if item[0] == "re":
        r = item[1]
        return [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)]
    if item[0] == "qu":
        q = item[1]
        return [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
    if item[0] == "c":                       # a bezier: doors, mostly
        p = [(pt.x, pt.y) for pt in item[1:5]]
        out = []
        for t in np.linspace(0, 1, 9):
            m = 1 - t
            out.append((m**3*p[0][0] + 3*m*m*t*p[1][0] + 3*m*t*t*p[2][0] + t**3*p[3][0],
                        m**3*p[0][1] + 3*m*m*t*p[1][1] + 3*m*t*t*p[2][1] + t**3*p[3][1]))
        return out
    return []


def wall_ink(name, widths=None, layers=None, fills=False, thick=2):
    """Just the walls, in PNG pixels -- or the whole sheet, if asked for neither.

    Segmenting the rendered sheet works, but it is segmenting a picture of a
    floor: the furniture, the seating rows, the dimension ticks and the room
    labels are all ink, and every one of them is another edge for a flood fill
    to catch on. These PDFs are CAD exports, so the walls can be asked for by
    lineweight -- or, on the sheets whose export kept them, by layer name -- and
    everything else left out.
    """
    img = load(name)
    if widths is None and layers is None:
        return img
    doc = pymupdf.open(os.path.join(PDF_DIR, name + ".pdf"))
    page = doc[0]
    crop = ink_crop(page)
    shape = (crop[3] - crop[1] + 1, crop[2] - crop[0] + 1)
    if shape != img.shape:
        raise SystemExit("%s: sheet and render disagree, %s vs %s"
                         % (name, shape, img.shape))
    # get_drawings() answers in unrotated page space; the pixmap -- and so the
    # PNG the placement was calibrated against -- is the rotated page.
    rot = page.rotation_matrix
    widths = set(widths or [])
    layers = set(layers or []) or None
    out = np.full(shape, 255, np.uint8)

    def to_px(p):
        q = pymupdf.Point(p[0], p[1]) * rot
        return (int(round(q.x * ZOOM - crop[0])), int(round(q.y * ZOOM - crop[1])))

    for d in page.get_drawings():
        filled = d["type"] in ("f", "fs")
        if layers is not None:
            if (d.get("layer") or "").split("|")[-1].upper() not in layers:
                continue
        elif filled:
            if not fills:
                continue
        elif round(d.get("width") or 0, 2) not in widths:
            continue
        run = []
        for it in d["items"]:
            pts = [to_px(p) for p in _points(it)]
            if not pts:
                continue
            if filled:
                run.extend(pts)
            else:
                for a, b in zip(pts, pts[1:]):
                    cv2.line(out, a, b, 0, thick)
        if filled and len(run) >= 3:
            cv2.fillPoly(out, [np.array(run, np.int32)], 0)
    return out


# ---------------------------------------------------------------------------
# Patches of floor
# ---------------------------------------------------------------------------
def on_ink(ink, a, b, tol=4):
    """What fraction of this edge has something drawn under it."""
    n = max(int(np.hypot(b[0]-a[0], b[1]-a[1]) / 2), 1)
    H, W = ink.shape
    hit = 0
    for t in np.linspace(0, 1, n):
        x, y = int(round(a[0] + (b[0]-a[0])*t)), int(round(a[1] + (b[1]-a[1])*t))
        x0, x1 = max(x-tol, 0), min(x+tol+1, W)
        y0, y1 = max(y-tol, 0), min(y+tol+1, H)
        if x0 < x1 and y0 < y1 and ink[y0:y1, x0:x1].any():
            hit += 1
    return hit / n


def rectify(poly, slant=0.36):
    """Make the outline out of horizontals and verticals, as the drawing is.

    These floors are built on right angles, and every edge that comes back on a
    slant is the segmentation's slant, not the building's: a wall found a pixel
    further out at one end than the other, or a corner the brush rounded and the
    simplifier cut across. Rounding it off edge by edge never quite works, because
    what is wrong is not the corners but the edges either side of them.

    So each edge is called horizontal or vertical -- whichever it is nearer, and
    an edge more than `slant` off both is left alone, since some walls really do
    run on the diagonal -- runs of the same kind are merged, each is squared to
    the average of its ends, and the corners are put back where consecutive
    edges now cross. The outline that comes out is the one somebody tracing by
    eye would have drawn: along this wall, turn, along that one.
    """
    pts = [list(p) for p in poly]
    n = len(pts)
    if n < 4:
        return pts
    edges = []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        dx, dy = abs(b[0] - a[0]), abs(b[1] - a[1])
        if dx == 0 and dy == 0:
            continue
        if dy <= slant * dx:
            edges.append(["h", a, b])
        elif dx <= slant * dy:
            edges.append(["v", a, b])
        else:
            edges.append(["free", a, b])
    if not any(e[0] != "free" for e in edges):
        return pts
    # merge neighbouring edges that face the same way, so one wall is one line
    merged = []
    for e in edges:
        if merged and merged[-1][0] == e[0] != "free":
            merged[-1][2] = e[2]
        else:
            merged.append(e)
    if len(merged) > 1 and merged[0][0] == merged[-1][0] != "free":
        merged[0][1] = merged[-1][1]
        merged.pop()
    if len(merged) < 3:
        return pts
    # each wall becomes one line; a free edge keeps the two ends it had
    lines = []
    for kind, a, b in merged:
        if kind == "h":
            lines.append(("h", (a[1] + b[1]) / 2))
        elif kind == "v":
            lines.append(("v", (a[0] + b[0]) / 2))
        else:
            lines.append(("free", (list(a), list(b))))
    out = []
    for i, cur in enumerate(lines):
        nxt = lines[(i + 1) % len(lines)]
        if cur[0] == "h" and nxt[0] == "v":
            out.append([nxt[1], cur[1]])
        elif cur[0] == "v" and nxt[0] == "h":
            out.append([cur[1], nxt[1]])
        elif cur[0] == "free":
            out.extend([list(cur[1][0]), list(cur[1][1])])
        elif nxt[0] == "free":
            out.append(list(nxt[1][0]))
        else:
            out.append(list(merged[i][2]))
    keep = []
    for i, q in enumerate(out):
        if not keep or abs(keep[-1][0] - q[0]) > 0.5 or abs(keep[-1][1] - q[1]) > 0.5:
            keep.append(q)
    return keep if len(keep) >= 3 else pts


def square_corners(poly, ink=None, max_cut=22.0, bare=0.55):
    """Run each pair of walls on to where they cross, instead of cutting across.

    Whatever rounding survives the brush arrives here as a diagonal between two
    square edges -- the corner of the room with its point sawn off. The room's
    own two walls already say where that point was: it is where their lines
    meet. So the stub goes and the corner comes back, which is what following
    the drawing means.

    Short stubs are always rounding. A long diagonal might be a real wall built
    on the skew, so those are only cut when there is nothing drawn under them:
    an outline edge running over blank paper is not tracing anything.
    """
    n = len(poly)
    if n < 4:
        return poly
    skip = set()
    for i in range(n):
        a, b, c, d = poly[i], poly[(i+1) % n], poly[(i+2) % n], poly[(i+3) % n]
        span = np.hypot(c[0]-b[0], c[1]-b[1])
        if span > max_cut and (ink is None or on_ink(ink, b, c) >= bare):
            continue
        ah, av = abs(a[1]-b[1]) < 1.5, abs(a[0]-b[0]) < 1.5
        dh, dv = abs(c[1]-d[1]) < 1.5, abs(c[0]-d[0]) < 1.5
        if ah and dv:
            poly[(i+1) % n] = [d[0], a[1]]
            skip.add((i+2) % n)
        elif av and dh:
            poly[(i+1) % n] = [a[0], d[1]]
            skip.add((i+2) % n)
    out = [q for i, q in enumerate(poly) if i not in skip]
    return out if len(out) >= 3 else poly


def bridge_doors(ink, pxm, widest=2.2, slack=1.35):
    """Close the doorways, and only the doorways.

    Sealing a sheet by closing it everywhere is a blunt instrument: the kernel
    wide enough to shut a metre of doorway also rounds every corner, swallows
    every alcove, and welds a small room to the cupboard beside it. But a
    doorway is not just any gap -- it is a gap about a door wide, with wall on
    both sides of it.

    So the closing is done, and then thrown away except where it added a patch
    the size of a door. A real doorway gets a lintel drawn across it and the
    room behind it becomes a room; a lab standing open to the corridor across
    four metres gets nothing, and stays part of the corridor, which is the
    truth about it.

    A double door is one door. Two leaves meeting in the middle read as a gap
    about two metres across, and a width that only allowed for a single leaf
    would leave every pair of them open -- which is most of the classrooms. The
    allowance is set above a double door and well below the four-metre openings
    that are genuinely not doorways at all.
    """
    solid = (ink < 200).astype(np.uint8)
    span = max(int(widest * pxm), 9)
    closed = cv2.morphologyEx(solid, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (span, span)))
    added = (closed & (1 - solid)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(added, 8)
    keep = np.zeros_like(solid)
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a <= slack * span * span and min(w, h) <= span:
            keep[lab == i] = 1
    return np.where(solid | keep, 0, 255).astype(np.uint8)


def simplify(contour, eps_px=6.0, snap_px=7.0):
    """Cut the wiggle out of a traced outline and square up its near-axis edges."""
    poly = cv2.approxPolyDP(contour, eps_px, True).reshape(-1, 2).astype(float)
    if len(poly) < 3:
        return poly
    for i in range(len(poly)):
        j = (i + 1) % len(poly)
        a, b = poly[i], poly[j]
        if 0 < abs(a[0] - b[0]) < snap_px:
            poly[i][0] = poly[j][0] = (a[0] + b[0]) / 2
        if 0 < abs(a[1] - b[1]) < snap_px:
            poly[i][1] = poly[j][1] = (a[1] + b[1]) / 2
    out = []
    for i in range(len(poly)):
        p, q, r = poly[i - 1], poly[i], poly[(i + 1) % len(poly)]
        if np.hypot(*(q - p)) < 3:
            continue
        if abs((q[0]-p[0]) * (r[1]-p[1]) - (q[1]-p[1]) * (r[0]-p[0])) < 60:
            continue
        out.append(q)
    return np.array(out if len(out) >= 3 else poly)


def patches(ink, close, grow, min_px, max_px, open_k=21):
    """Every enclosed patch of white on the sheet, as a polygon on the wall line."""
    H, W = ink.shape
    mask = (ink < 200).astype(np.uint8)
    # Square brushes throughout. A disc rounds off every corner it passes, and a
    # rounded corner is a corner the simplifier reads as a 45-degree chamfer --
    # which is how a stairwell that is a rectangle on the sheet came out an
    # octagon. Rooms on these plans meet at right angles; the brush should not
    # be the thing that says otherwise.
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (close, close))
    free = (1 - cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(free, 4)
    gk = cv2.getStructuringElement(cv2.MORPH_RECT, (2*grow+1, 2*grow+1))
    ok = cv2.getStructuringElement(cv2.MORPH_RECT, (open_k, open_k)) if open_k else None
    out = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if x <= 1 or y <= 1 or x + w >= W - 1 or y + h >= H - 1:
            continue                      # touches the paper edge: not a room
        if a < min_px or a > max_px or min(w, h) < 14:
            continue                      # or the cavity inside a double wall
        pad = grow + 2
        sub = np.zeros((h + 2*pad, w + 2*pad), np.uint8)
        sub[pad:pad+h, pad:pad+w] = (lab[y:y+h, x:x+w] == i)
        # Whatever is drawn inside a room -- a bench, a row of seats, the treads
        # of a stair -- is ink the fill flows around, so the patch comes back
        # with holes in it and a coastline that wanders in to reach them. The
        # room is the space the walls enclose, so the holes are filled first and
        # only the outer boundary is kept.
        holes = sub.copy()
        edge = np.zeros((holes.shape[0] + 2, holes.shape[1] + 2), np.uint8)
        cv2.floodFill(holes, edge, (0, 0), 1)
        sub = sub | (1 - holes)
        if ok is not None and a > 40 * (min_px or 1):
            # take the door alcoves out of a corridor: a metre-deep notch every
            # few metres is what makes a traced hallway look like a comb. Only a
            # corridor, though -- run over a small room it rounds off its corners
            opened = cv2.morphologyEx(sub, cv2.MORPH_OPEN, ok)
            if opened.sum() > 0.55 * sub.sum():
                sub = opened
        sub = cv2.dilate(sub, gk)
        cs, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        poly = simplify(max(cs, key=cv2.contourArea)) + np.array([x - pad, y - pad], float)
        poly = square_corners([[float(q[0]), float(q[1])] for q in poly], mask)
        poly = rectify(poly)
        out.append(dict(px=int(a), bbox=[int(x), int(y), int(w), int(h)],
                        cen=[float(cent[i][0]), float(cent[i][1])],
                        poly=[[round(float(q[0]), 1), round(float(q[1]), 1)] for q in poly]))
    return out


def _wall_lines(regs, axis, tol, min_len=25.0):
    """Where the floor's long edges agree there is a wall, on one axis."""
    vals = []
    for r in regs:
        n = len(r["poly"])
        for i in range(n):
            a, b = r["poly"][i], r["poly"][(i + 1) % n]
            if abs(a[axis] - b[axis]) <= 2 and abs(a[1-axis] - b[1-axis]) >= min_len:
                vals.append((a[axis] + b[axis]) / 2)
    vals.sort()
    lines, start, cur = [], None, []
    for v in vals:
        if start is None or v - start > tol:   # a span cap, so groups cannot chain
            if cur:
                lines.append(sum(cur) / len(cur))
            start, cur = v, [v]
        else:
            cur.append(v)
    if cur:
        lines.append(sum(cur) / len(cur))
    return lines


def snap_grid(regs, tol=6.0):
    """Pull vertices onto the floor's own wall lines.

    Every room on a corridor shares a wall with the room across it, and the fill
    finds each one a pixel or two out, so a wall that is one line on the sheet
    comes back as a dozen. Only long edges get a vote: a door reveal is not a
    wall, and letting one move a wall is how a room ends up a foot out.
    """
    import bisect
    for axis in (0, 1):
        lines = _wall_lines(regs, axis, tol)
        if not lines:
            continue
        for r in regs:
            for p in r["poly"]:
                i = bisect.bisect_left(lines, p[axis])
                best = None
                for j in (i - 1, i, i + 1):
                    if 0 <= j < len(lines) and abs(lines[j] - p[axis]) <= tol:
                        if best is None or abs(lines[j] - p[axis]) < abs(best - p[axis]):
                            best = lines[j]
                if best is not None:
                    p[axis] = round(best, 1)
    for r in regs:
        keep = [q for i, q in enumerate(r["poly"])
                if abs(r["poly"][i-1][0] - q[0]) > 0.5 or abs(r["poly"][i-1][1] - q[1]) > 0.5]
        if len(keep) >= 3:
            r["poly"] = keep
    return regs


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------
def text_blocks(img, poly, pad=4):
    """Glyph-sized ink inside the outline, gathered into lines of text.

    Lines are looked for both ways round. A sheet sets most of its labels
    across the page but turns the ones in a narrow room on their side, and a
    reader that only knows rows cannot see those at all -- which is worse than
    missing them, because a patch of floor with a sideways label in it then
    looks like a patch with no label, or, if it also swallowed a room whose
    label reads across, like a room with exactly one. That is how an open-plan
    office ends up drawn over its neighbour and wearing its number.
    """
    m = np.zeros(img.shape, np.uint8)
    cv2.fillPoly(m, [np.array(poly, np.int32)], 1)
    m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    x, y, w, h = cv2.boundingRect(np.array(poly, np.int32))
    x, y = max(x, 0), max(y, 0)
    ink = ((img[y:y+h, x:x+w] < 200) & (m[y:y+h, x:x+w] > 0)).astype(np.uint8)
    n, lab, st, ce = cv2.connectedComponentsWithStats(ink, 8)
    runs = []
    for down in (0, 1):
        # a glyph is tall-ish and narrow-ish read one way, and the same shape
        # with its sides swapped read the other
        lo, hi = (7, 34) if not down else (1, 46)
        lo2, hi2 = (1, 46) if not down else (7, 34)
        glyphs = [i for i in range(1, n)
                  if lo <= st[i][3] <= hi and lo2 <= st[i][2] <= hi2 and st[i][4] >= 6]
        along, across = (0, 1) if not down else (1, 0)
        lines = {}
        for i in glyphs:
            lines.setdefault(round(ce[i][across] / 16), []).append(i)
        for ids in lines.values():
            ids.sort(key=lambda i: ce[i][along])
            run = [ids[0]]
            for i in ids[1:]:
                if ce[i][along] - ce[run[-1]][along] < 60:
                    run.append(i)
                else:
                    runs.append(run)
                    run = [i]
            runs.append(run)
    out = []
    for run in runs:
        if len(run) < 2:
            continue
        x0 = min(st[i][0] for i in run)
        y0 = min(st[i][1] for i in run)
        x1 = max(st[i][0] + st[i][2] for i in run)
        y1 = max(st[i][1] + st[i][3] for i in run)
        out.append(dict(box=[int(x+x0-pad), int(y+y0-pad),
                             int(x1-x0+2*pad), int(y1-y0+2*pad)],
                        cx=x + (x0+x1)/2, cy=y + (y0+y1)/2))
    return out


def labels_in(img, poly):
    """The room labels written inside this outline.

    A label is a number over a use code, so its two lines are one label; two
    labels inside one outline means the fill ran through a wall.
    """
    ring = np.array(poly, np.float32)
    bs = [b for b in text_blocks(img, poly)
          if cv2.pointPolygonTest(ring, (float(b["cx"]), float(b["cy"])), False) >= 0]
    bs.sort(key=lambda b: (b["cy"], b["cx"]))
    out = []
    for b in bs:
        for g in out:
            if abs(g["cx"] - b["cx"]) < 80 and abs(g["cy"] - b["cy"]) < 34:
                g["x0"] = min(g["x0"], b["box"][0])
                g["y0"] = min(g["y0"], b["box"][1])
                g["x1"] = max(g["x1"], b["box"][0] + b["box"][2])
                g["y1"] = max(g["y1"], b["box"][1] + b["box"][3])
                g["cx"] = (g["cx"] + b["cx"]) / 2
                g["cy"] = (g["cy"] + b["cy"]) / 2
                break
        else:
            out.append(dict(cx=b["cx"], cy=b["cy"], x0=b["box"][0], y0=b["box"][1],
                            x1=b["box"][0] + b["box"][2], y1=b["box"][1] + b["box"][3]))
    for g in out:
        g["box"] = [g["x0"], g["y0"], g["x1"] - g["x0"], g["y1"] - g["y0"]]
    return out


# ---------------------------------------------------------------------------
# A floor
# ---------------------------------------------------------------------------
def depth_in(poly, cx, cy):
    """How deep inside the outline a point sits, as a fraction of the deepest.

    1.0 is the middle of the widest part of the room; 0 is on the wall. It does
    not care how long the room is, only how far from an edge -- which is the
    difference between a stairwell's number at the end of its shaft (deep) and a
    number the fill picked up on its way past (shallow).
    """
    ring = np.array(poly, np.int32)
    x, y, w, h = cv2.boundingRect(ring)
    m = np.zeros((h + 2, w + 2), np.uint8)
    cv2.fillPoly(m, [ring - [x - 1, y - 1]], 1)
    d = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    peak = float(d.max())
    if peak <= 0:
        return 0.0
    px, py = int(round(cx - x + 1)), int(round(cy - y + 1))
    if not (0 <= px < d.shape[1] and 0 <= py < d.shape[0]):
        return 0.0
    return float(d[py, px]) / peak



def read_sheet(name, inks=({},), rot=0, pxm=None, grow=4, open_k=21,
               min_m2=1.5, max_m2=1200, snap=6.0):
    """One outline per label on the sheet."""
    flat = load(name)
    H, W = flat.shape
    pl = placement(name)
    pxm = pxm or (W / pl["widthM"] if pl else 17.0)
    # Some sheets are drawn on their side, labels and all, and everything here
    # reads text as rows of glyphs: the sheet is turned upright to work on and
    # the outlines are turned back at the end.
    turn = (lambda a: cv2.rotate(a, cv2.ROTATE_90_CLOCKWISE)) if rot else (lambda a: a)
    back = (lambda p: [p[1], H - 1 - p[0]]) if rot else (lambda p: list(p))
    chosen = []
    for cfg in inks:
        raw = wall_ink(name, cfg.get("widths"), cfg.get("layers"),
                       cfg.get("fills", False))
        ink = turn(bridge_doors(raw, pxm))
        img = turn(flat)
        for close in SEALS:
            for r in patches(ink, close, grow, int(min_m2 * pxm * pxm),
                             int(max_m2 * pxm * pxm), open_k):
                found = labels_in(img, r["poly"])
                if len(found) != 1:
                    continue
                cx, cy = found[0]["cx"], found[0]["cy"]
                # A room is labelled well inside itself. A label crowded against
                # the edge of an outline means the outline is not that room's:
                # the fill has run somewhere and taken a number with it.
                #
                # How far inside, not how near the middle. A stairwell is a long
                # thin shaft with its number at one end -- miles from the centre
                # of its own bounding box, and still unmistakably its own label.
                # What the bad ones have in common is not being off-centre but
                # being up against a wall, so that is what is measured.
                if depth_in(r["poly"], cx, cy) < 0.33:
                    continue
                # one room, one outline: the same label found again at a tighter
                # seal is the same room, not another one
                if any(abs(c["lcx"] - cx) < 40 and abs(c["lcy"] - cy) < 22 for c in chosen):
                    continue
                r.update(label=found[0]["box"], lcx=cx, lcy=cy, seal=close,
                         m2=round(r["px"] / (pxm * pxm), 1),
                         ink=str(cfg.get("layers") or cfg.get("widths") or "sheet"))
                chosen.append(r)
    # Anything still unclaimed is a room no fill can close -- drawn from its
    # walls instead, the way somebody tracing by hand would draw it.
    if inks:
        drawn = by_walls(name, inks[0], [r["poly"] for r in chosen], pxm)
        for d in drawn:
            if rot:
                d["poly"] = [[H - 1 - q[1], q[0]] for q in d["poly"]]
            chosen.append(d)
        stranded = by_leader(name, inks[0], [r["poly"] for r in chosen], pxm)
        for d in stranded:
            if rot:
                d["poly"] = [[H - 1 - q[1], q[0]] for q in d["poly"]]
            chosen.append(d)
    out = sorted(chosen, key=lambda r: (r["label"][1], r["label"][0]))
    # Snapping to the floor's wall lines is an improvement to a shape, not a
    # licence to wreck it: on an outline with a notch in it, pulling two nearby
    # vertices onto the same line can fold the boundary over itself. So the
    # before is kept and handed back to any room the snapping spoiled.
    from shapely.geometry import Polygon as _P
    before = [list(map(list, r["poly"])) for r in out]
    snap_grid(out, snap)
    for r, was in zip(out, before):
        now = _P(r["poly"])
        if not now.is_valid or now.area <= 0:
            r["poly"] = was
    for i, r in enumerate(out):
        r["id"] = i
        if rot:
            r["poly"] = [back(p) for p in r["poly"]]
            x, y, w, h = r["label"]
            a, b = back((x, y)), back((x + w, y + h))
            r["label"] = [min(a[0], b[0]), min(a[1], b[1]),
                          abs(b[0] - a[0]), abs(b[1] - a[1])]
            r["cen"] = back(r["cen"])
    return dict(name=name, W=W, H=H, pxm=pxm, rot=rot, rooms=out)


SW, SH = 125, 93              # what is cut out around the label, in tracing pixels
CARD_ZOOM = 2                 # and how much sharper than that it is drawn
PW, PH = SW*CARD_ZOOM, SH*CARD_ZOOM
CW, CH, COLS, ROWS = PW*2, PH, 4, 6


def sharper(name, factor=CARD_ZOOM):
    """The sheet re-rendered from the PDF at `factor` times the tracing scale.

    The rooms have to be found in the frame the placement is calibrated in, and
    that frame is fixed. Reading the labels does not: they are on the same
    sheet, and the sheet is vector. Enlarging the PNG only enlarges the same
    216 dpi of stencil font -- going back to the PDF gets glyphs that were
    never blurred in the first place, which is the difference between guessing
    at a number and reading it.
    """
    doc = pymupdf.open(os.path.join(PDF_DIR, name + ".pdf"))
    page = doc[0]
    crop = ink_crop(page)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM * factor, ZOOM * factor))
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    big = arr[crop[1]*factor:(crop[3]+1)*factor, crop[0]*factor:(crop[2]+1)*factor, :3]
    return np.ascontiguousarray(big[:, :, ::-1])          # RGB out of fitz, BGR in


def _fit(src, poly, box, size, rot):
    """The outline and its surroundings, shrunk to fit -- what shape is this room."""
    x, y, w, h = box
    m = int(max(w, h) * 0.18) + 12
    x0, y0 = max(x - m, 0), max(y - m, 0)
    x1, y1 = min(x + w + m, src.shape[1]), min(y + h + m, src.shape[0])
    cut = src[y0:y1, x0:x1].copy()
    if cut.size == 0:
        return np.full((size[1], size[0], 3), 245, np.uint8)
    cv2.polylines(cut, [np.array(poly, np.int32) - [x0, y0]], True, (0, 0, 230),
                  max(int(max(w, h) / 90), 2))
    if rot:
        cut = cv2.rotate(cut, cv2.ROTATE_90_COUNTERCLOCKWISE)
    scale = min(size[0] / cut.shape[1], size[1] / cut.shape[0])
    small = cv2.resize(cut, (max(int(cut.shape[1]*scale), 1), max(int(cut.shape[0]*scale), 1)),
                       interpolation=cv2.INTER_AREA)
    pane = np.full((size[1], size[0], 3), 255, np.uint8)
    oy, ox = (size[1]-small.shape[0])//2, (size[0]-small.shape[1])//2
    pane[oy:oy+small.shape[0], ox:ox+small.shape[1]] = small
    return pane


def _label_pane(src, label, poly, size, rot, z):
    """The room's own label, big -- what number is this room."""
    lx, ly, lw, lh = [v * z for v in label]
    cw, ch = (size[1], size[0]) if rot else (size[0], size[1])
    x0 = int(np.clip(lx + lw//2 - cw//2, 0, src.shape[1] - cw))
    y0 = int(np.clip(ly + lh//2 - ch//2, 0, src.shape[0] - ch))
    tile = src[y0:y0+ch, x0:x0+cw].copy()
    lit = tile.copy()
    cv2.rectangle(lit, (lx-x0-4*z, ly-y0-4*z), (lx+lw-x0+4*z, ly+lh-y0+4*z), (120, 235, 255), -1)
    tile = cv2.addWeighted(tile, 0.5, lit, 0.5, 0)
    cv2.polylines(tile, [np.array(poly, np.int32) * z - [x0, y0]], True, (0, 0, 230), 2*z)
    if rot:
        tile = cv2.rotate(tile, cv2.ROTATE_90_COUNTERCLOCKWISE)
    if tile.shape[:2] != (size[1], size[0]):
        tile = cv2.resize(tile, size, interpolation=cv2.INTER_AREA)
    return tile


def already_read(name, seg, tol=25.0):
    """Which of these rooms already have a number, by where their label sits."""
    path = os.path.join(WORK_DIR, name + ".txt")
    if not os.path.exists(path):
        return set()
    done = set()
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if not line or "," not in line.split()[0]:
            continue
        x, y = (float(v) for v in line.split()[0].split(","))
        for r in seg["rooms"]:
            if math.hypot(r["lcx"] - x, r["lcy"] - y) <= tol:
                done.add(r["id"])
                break
    return done


def cards(seg, out_dir, skip=()):
    """A card per room, in two halves.

    The shape of a room and the number written in it will not sit in one
    picture: fit the whole outline and the label is four pixels tall, blow up
    the label and the outline runs off every edge. Both questions have to be
    answerable -- is this outline a room, and is this its number -- so the card
    answers them side by side, the room fitted on the left and its label
    magnified on the right.
    """
    name, rot = seg["name"], seg.get("rot", 0)
    try:
        src, z = sharper(name), CARD_ZOOM
    except Exception:
        src, z = cv2.cvtColor(load(name), cv2.COLOR_GRAY2BGR), 1
    tiles = []
    for r in seg["rooms"]:
        if r["id"] in skip:
            continue          # already has a number, and it was checked once
        box = cv2.boundingRect(np.array(r["poly"], np.int32) * z)
        tile = np.full((PH, PW*2, 3), 255, np.uint8)
        tile[:, :PW] = _fit(src, np.array(r["poly"]) * z, box, (PW, PH), rot)
        tile[:, PW:] = _label_pane(src, r["label"], r["poly"], (PW, PH), rot, z)
        cv2.line(tile, (PW, 0), (PW, PH), (170, 170, 170), 1)
        tiles.append((r["id"], r["m2"], tile))
    paths, per = [], COLS * ROWS
    for s in range(0, len(tiles), per):
        canvas = np.full((ROWS * (CH+26), COLS * (CW+6), 3), 255, np.uint8)
        for k, (rid, m2, tile) in enumerate(tiles[s:s+per]):
            rr, cc = divmod(k, COLS)
            y0, x0 = rr * (CH+26), cc * (CW+6)
            canvas[y0+26:y0+26+CH, x0:x0+CW] = tile
            cv2.putText(canvas, "#%d" % rid, (x0+4, y0+19),
                        cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 0, 0), 2)
            cv2.putText(canvas, "%.0fm2" % m2, (x0+CW-88, y0+19),
                        cv2.FONT_HERSHEY_SIMPLEX, .5, (90, 90, 90), 1)
            cv2.rectangle(canvas, (x0, y0+24), (x0+CW, y0+26+CH), (150, 150, 150), 1)
        p = os.path.join(out_dir, "%s_c%02d.png" % (name, s // per))
        cv2.imwrite(p, canvas)
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# Out to the map
# ---------------------------------------------------------------------------
M_PER_DEG_LAT = (math.pi / 180) * R_EARTH


def uv_to_lnglat(uv, pl, W, H):
    """The tracer's own plan-space-to-world, so a floor written here opens there."""
    width_m = pl["widthM"]
    height_m = width_m / (W / H)
    x = (uv[0] - 0.5) * width_m
    y = (0.5 - uv[1]) * height_m
    th = math.radians(pl["rotation"])
    c, s = math.cos(th), math.sin(th)
    return [pl["lng"] + (x*c - y*s) / (M_PER_DEG_LAT * math.cos(math.radians(pl["lat"]))),
            pl["lat"] + (x*s + y*c) / M_PER_DEG_LAT]


def write_floor(name, seg, labels):
    """The floor as the tracer would have saved it, given the numbers off the cards."""
    building, _, floor = name.partition("-Floor")
    pl = placement(name)
    if not pl:
        raise SystemExit("%s has no placement: put the sheet on the map in the tracer first"
                         % name)
    W, H = seg["W"], seg["H"]
    by_id = {r["id"]: r for r in seg["rooms"]}
    feats, seen = [], {}
    for rid, (room, code) in sorted(labels.items()):
        r = by_id.get(rid)
        if r is None:
            print("   card #%s is not on the sheet any more, skipped" % rid)
            continue
        kind, label = USE.get(code.upper(), ("room", None))
        if room in seen:
            print("   %s read twice (cards %s and %s), keeping the larger"
                  % (room, seen[room]["card"], rid))
            if r["m2"] <= seen[room]["m2"]:
                continue
            feats = [f for f in feats if f["properties"]["room"] != room]
        seen[room] = dict(card=rid, m2=r["m2"])
        uv = [[round(p[0] / W, 6), round(p[1] / H, 6)] for p in r["poly"]]
        ring = [uv_to_lnglat(p, pl, W, H) for p in uv]
        ring.append(ring[0])
        props = {"room": room, "building": building, "floor": floor, "type": kind,
                 "source": "sheet", "use": code.upper(), "uv": uv}
        if label:
            props["name"] = label
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})
    return {"type": "FeatureCollection", "features": feats}


def read_labels(path, seg):
    """The numbers read off the cards, matched back to the rooms they are for.

    A card number is an ordinal: improve the reading of the sheet and every one
    of them moves, silently reattaching hand-read numbers to whichever rooms
    now hold those positions. That is the same class of mistake as the ones the
    cards exist to catch, so a line is keyed on where its label is printed on
    the sheet instead -- a fact about the drawing, which does not move. Lines
    are written by hand as card numbers and rewritten to positions on first use.
    """
    rooms = {r["id"]: r for r in seg["rooms"]}
    anchors = [(r["lcx"], r["lcy"], r) for r in seg["rooms"]]
    out, rewritten, head = {}, [], []
    for line in open(path, encoding="utf-8"):
        raw = line.rstrip()
        body = raw.split("#")[0].strip()
        if not body:
            head.append(raw)
            continue
        bits = body.split()
        if len(bits) < 3:
            print("   ignoring %r: wanted '<card #> <room> <USE-CODE>'" % body)
            continue
        where, room, code = bits[0], bits[1], bits[2]
        if "," in where:                       # already a position
            x, y = (float(v) for v in where.split(","))
            near = [(math.hypot(ax-x, ay-y), r) for ax, ay, r in anchors]
            d, r = min(near, key=lambda t: t[0]) if near else (1e9, None)
            if r is None or d > 25:
                print("   no room now has a label at %s (%s), skipped" % (where, room))
                continue
        else:
            r = rooms.get(int(where))
            if r is None:
                print("   card #%s is not on the sheet any more, skipped" % where)
                continue
        out[r["id"]] = (room, code)
        rewritten.append("%.0f,%.0f %s %s" % (r["lcx"], r["lcy"], room, code))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(os.linesep.join(head + sorted(rewritten, key=lambda l: l.split()[1])) + os.linesep)
    return out


def load_seg(name, cfg, path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    seg = read_sheet(name, **cfg)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(seg, fh)
    return seg


def circulation(name, cfg, rooms, min_m2=4.0):
    """The hallways: whatever is inside the walls and is not a room.

    A corridor cannot be found the way a room is. A room is a patch of floor
    with a wall all the way round it, which is what a flood fill finds; a
    corridor is the thing every one of those walls has a door onto, so the fill
    either stops at the doors and misses it or runs through them and swallows
    half the floor. Chasing it with a bigger seal only ever traded one for the
    other.

    But a floor is rooms and the space between them, and the rooms are already
    known. So the corridor is arrived at by subtraction: take everything inside
    the outer wall, take the rooms away, and what is left is where people walk.
    It comes out in pieces where a lab or a stairwell interrupts it, which is
    right -- a corridor that runs past a lab is not the same space as the lab,
    and they should not be one shape.
    """
    ink = wall_ink(name, cfg.get("widths"), cfg.get("layers"), cfg.get("fills", False))
    img = load(name)
    H, W = ink.shape
    pl = placement(name)
    pxm = W / pl["widthM"] if pl else 17.0
    solid = (ink < 200).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    free = (1 - cv2.morphologyEx(solid, cv2.MORPH_CLOSE, k)).astype(np.uint8)
    # Where the building is, taken from where its rooms are. Asking instead for
    # the free space that does not reach the edge of the paper does not work:
    # the outer wall has doors in it, so the inside of the building runs out
    # through them and joins the lawn.
    if not rooms:
        return []
    hull = cv2.convexHull(np.vstack([np.array(r["poly"], np.int32) for r in rooms]))
    built = np.zeros_like(free)
    cv2.fillPoly(built, [hull], 1)
    built = cv2.dilate(built, cv2.getStructuringElement(cv2.MORPH_RECT, (41, 41)))
    inside = free & built
    if not inside.any():
        return []
    for r in rooms:                      # take the rooms away
        cv2.fillPoly(inside, [np.array(r["poly"], np.int32)], 0)
    inside = cv2.morphologyEx(inside, cv2.MORPH_OPEN,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    n2, lab2, st2, cen2 = cv2.connectedComponentsWithStats(inside, 4)
    out = []
    for i in range(1, n2):
        x, y, w, h, a = st2[i]
        if a < min_m2 * pxm * pxm:
            continue
        sub = np.zeros((h + 8, w + 8), np.uint8)
        sub[4:4+h, 4:4+w] = (lab2[y:y+h, x:x+w] == i)
        cs, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        poly = simplify(max(cs, key=cv2.contourArea), 8.0) + np.array([x-4, y-4], float)
        poly = rectify([[float(q[0]), float(q[1])] for q in poly])
        found = labels_in(img, poly)
        out.append(dict(px=int(a), m2=round(a/(pxm*pxm), 1), poly=poly,
                        cen=[float(cen2[i][0]), float(cen2[i][1])],
                        labels=len(found),
                        label=found[0]["box"] if len(found) == 1 else None,
                        lcx=found[0]["cx"] if len(found) == 1 else float(cen2[i][0]),
                        lcy=found[0]["cy"] if len(found) == 1 else float(cen2[i][1])))
    return out


def sheet_labels(img, pxm):
    """Every room label printed on the sheet, wherever it is."""
    H, W = img.shape
    whole = [[0, 0], [W-1, 0], [W-1, H-1], [0, H-1]]
    return labels_in(img, whole)


def _wall_run(mask, x, y, dx, dy, limit):
    """How far from here to the first wall, going that way."""
    H, W = mask.shape
    for step in range(4, limit):
        px, py = int(x + dx*step), int(y + dy*step)
        if not (0 <= px < W and 0 <= py < H):
            return step
        if mask[py, px]:
            return step
    return limit


def _clip_to_free(poly, taken, cx, cy, keep=0.25):
    """The part of this rectangle no other room has already claimed."""
    from shapely.geometry import Polygon, Point
    from shapely.ops import unary_union
    g = Polygon(poly)
    if not g.is_valid or g.area <= 0:
        return None
    others = []
    for t in taken:
        o = Polygon(t)
        if o.is_valid and o.area > 0:
            others.append(o)
    if others:
        g = g.difference(unary_union(others).buffer(0.5))
    if g.is_empty:
        return None
    if g.geom_type == "MultiPolygon":
        here = [p for p in g.geoms if p.contains(Point(cx, cy))]
        g = here[0] if here else max(g.geoms, key=lambda p: p.area)
    if g.area < keep * Polygon(poly).area or not g.contains(Point(cx, cy)):
        return None
    ring = [[float(x), float(y)] for x, y in g.exterior.coords[:-1]]
    # Squaring up an L cut out of a rectangle can fold the outline over itself.
    # Better a slightly ragged room than one whose boundary crosses.
    squared = rectify(list(ring))
    return squared if Polygon(squared).is_valid else ring


def split_between(poly, labels):
    """Cut a shape holding several numbers into one piece per number.

    A pair of shafts side by side, or a run of them along a corridor, often has
    no wall between them that the drawing makes any thicker than the hatching
    inside -- so the rectangle comes back holding two numbers, and neither of
    them can have it. Splitting it halfway between the labels is what anybody
    tracing it would do: the wall is not visible, but it is obviously midway,
    and two rooms of about equal size is a far better answer than one room with
    two names or no rooms at all.
    """
    xs = [l["cx"] for l in labels]
    ys = [l["cy"] for l in labels]
    axis = 0 if (max(xs) - min(xs)) >= (max(ys) - min(ys)) else 1
    order = sorted(range(len(labels)), key=lambda i: (xs[i] if axis == 0 else ys[i]))
    lo = min(p[axis] for p in poly)
    hi = max(p[axis] for p in poly)
    olo = min(p[1-axis] for p in poly)
    ohi = max(p[1-axis] for p in poly)
    cuts = [lo]
    for a, b in zip(order, order[1:]):
        pa = xs[a] if axis == 0 else ys[a]
        pb = xs[b] if axis == 0 else ys[b]
        cuts.append((pa + pb) / 2)
    cuts.append(hi)
    out = []
    for k, i in enumerate(order):
        a, b = cuts[k], cuts[k+1]
        if b - a < 8:
            continue
        box = ([[a, olo], [b, olo], [b, ohi], [a, ohi]] if axis == 0
               else [[olo, a], [ohi, a], [ohi, b], [olo, b]])
        out.append((labels[i], box))
    return out


def by_leader(name, cfg, claimed, pxm, reach_m=9.0):
    """Rooms whose number would not fit inside them, so the sheet put it outside.

    A cupboard two metres across cannot hold "4004 SUPP-INST" at stencil size,
    so the drawing sets the label in whatever open space is nearest and runs a
    leader line to the room. Every rule here assumes the opposite -- that a
    label inside an outline is that outline's name -- and on these the
    assumption points at the wrong room entirely: 4004 got drawn as a rectangle
    in the middle of 4002, because that is where its label sits.

    The tell is that the label has landed inside a room that already has a
    number of its own. A number cannot name a room that is already named, so it
    belongs to something else nearby -- and what is nearby, and has no name of
    its own, is the little enclosure the leader points at. Pairing each such
    label with the closest unnamed patch is not quite reading the leader line,
    but it lands on the same room.
    """
    img = load(name)
    ink = wall_ink(name, cfg.get("widths"), cfg.get("layers"), cfg.get("fills", False))
    H, W = img.shape
    sealed = bridge_doors(ink, pxm)
    spare, orphans = [], []
    for close in (3, 7, 11):
        for r in patches(sealed, close, 4, int(1.0*pxm*pxm), int(60*pxm*pxm), 0):
            if labels_in(img, r["poly"]):
                continue
            c = r["cen"]
            if any(cv2.pointPolygonTest(np.array(t, np.float32), (float(c[0]), float(c[1])),
                                        False) >= 0 for t in claimed):
                continue
            if any(math.hypot(o["cen"][0]-c[0], o["cen"][1]-c[1]) < 12 for o in orphans):
                continue
            orphans.append(r)
    reach = reach_m * pxm
    out = []
    for lab in sheet_labels(img, pxm):
        cx, cy = lab["cx"], lab["cy"]
        inside = [t for t in claimed
                  if cv2.pointPolygonTest(np.array(t, np.float32), (float(cx), float(cy)),
                                          False) >= 0]
        if not inside:
            continue                    # not a stranded label; handled elsewhere
        near = [(math.hypot(o["cen"][0]-cx, o["cen"][1]-cy), o) for o in orphans]
        near = [(d, o) for d, o in near if d <= reach]
        if not near:
            continue
        d, o = min(near, key=lambda t: t[0])
        orphans.remove(o)
        o = dict(o)
        o.update(label=lab["box"], lcx=cx, lcy=cy, seal=0, ink="leader",
                 m2=round(o["px"]/(pxm*pxm), 1))
        out.append(o)
    return out


def by_walls(name, cfg, taken, pxm, reach_m=26.0, fan=5, rounds=4):
    """Draw the rooms the fill could not close, the way a person would.

    Some rooms cannot be flood-filled at all: a lab whose front is four metres
    of open doorway is not a patch of floor with a wall round it, it is part of
    the corridor as far as any fill is concerned, and no seal narrow enough to
    keep the cupboards apart will ever shut it. Left there, a floor has a hole
    in it where its biggest rooms should be.

    But somebody tracing by hand would not hesitate. They would put the corner
    where the two walls meet and run the fourth side straight across the
    opening, along the line the corridor wall is already on. So: from the room's
    own number, look outward in each of the four directions and stop at the
    first wall. Several rays each way, and the middle answer taken, because one
    ray in a doorway would otherwise run to the far side of the building. Then
    the four edges are snapped to the lines the rest of the floor agrees on.
    """
    img = load(name)
    ink = wall_ink(name, cfg.get("widths"), cfg.get("layers"), cfg.get("fills", False))
    mask = (ink < 200).astype(np.uint8)
    # A room already traced is a wall as far as this is concerned. Without that
    # the ray runs straight through its neighbour and the rectangle ends up
    # drawn over the top of it -- two rooms standing on the same floor.
    for t in taken:
        cv2.polylines(mask, [np.array(t, np.int32)], True, 1, 3)
    mask = mask.astype(bool)
    limit = int(reach_m * pxm)
    out = []
    # Several passes. Each room drawn is a wall for the next one, so a rectangle
    # that ran over its neighbour on the first pass stops at it on the second --
    # and a room the first pass could not draw at all, because its rectangle was
    # swallowed by a larger one, gets its own chance once that larger one has
    # been cut back. It settles after three or four rounds.
    for _ in range(rounds):
      grew = False
      claimed = list(taken) + [d["poly"] for d in out]
      for lab in sheet_labels(img, pxm):
          cx, cy = lab["cx"], lab["cy"]
          if any(cv2.pointPolygonTest(np.array(t, np.float32), (float(cx), float(cy)), False) >= 0
                 for t in claimed):
              continue
          x, y, w, h = lab["box"]
          spread = max(w, h) * 0.42
          reach = {}
          for name_d, (dx, dy) in (("l", (-1, 0)), ("r", (1, 0)), ("u", (0, -1)), ("d", (0, 1))):
              runs = []
              for k in range(fan):
                  off = (k - (fan-1)/2) / max((fan-1)/2, 1) * spread
                  ox, oy = (0, off) if dx else (off, 0)
                  runs.append(_wall_run(mask, cx+ox, cy+oy, dx, dy, limit))
              runs.sort()
              reach[name_d] = runs[len(runs)//2]
          # A vestibule is narrower than the word "VESTIBULE". Where a label
          # overflows its own room the sideways rays start already touching the
          # wall, and a guard that wanted six pixels of clearance threw those
          # rooms away -- the small ones, which are exactly the ones a label
          # cannot fit inside. Only a ray that got nowhere at all is refused.
          if min(reach.values()) < 3 or max(reach.values()) >= limit:
              continue
          if (reach["l"]+reach["r"]) * (reach["u"]+reach["d"]) < 1.5 * pxm * pxm:
              continue          # smaller than a broom cupboard: not a room
          poly = [[cx - reach["l"], cy - reach["u"]], [cx + reach["r"], cy - reach["u"]],
                  [cx + reach["r"], cy + reach["d"]], [cx - reach["l"], cy + reach["d"]]]
          # Rays find a neighbour only when most of them run into it, so a small
          # room off to one side gets driven straight over. Cutting the finished
          # rectangle against what is already on the floor settles it either way:
          # two rooms cannot stand on the same ground.
          poly = _clip_to_free(poly, claimed, cx, cy)
          if poly is None:
              continue
          inside = [l for l in labels_in(img, poly)]
          pieces = (split_between(poly, inside) if len(inside) > 1
                    else [(lab, poly)])
          for who, box in pieces:
              if any(abs(d["lcx"]-who["cx"]) < 25 and abs(d["lcy"]-who["cy"]) < 25
                     for d in out):
                  continue
              grew = True
              claimed = claimed + [box]
              wx, wy = who["cx"], who["cy"]
              w = abs(max(q[0] for q in box) - min(q[0] for q in box))
              h = abs(max(q[1] for q in box) - min(q[1] for q in box))
              out.append(dict(poly=[[float(a), float(b)] for a, b in box],
                              label=who["box"], lcx=wx, lcy=wy, seal=0, ink="walls",
                              px=int(w*h), cen=[float(wx), float(wy)]))
      if not grew:
          break
    for r in out:
        r["m2"] = round(r["px"]/(pxm*pxm), 1)
    return out


def audit(name):
    """What is wrong with a traced floor on its face, without opening it.

    Reading a number off a card and drawing an outline are two different
    mistakes, and this catches the second kind: outlines that cannot both be
    right. Two rooms cannot stand on the same floor, so a pair that overlaps is
    a pair with a wrong one in it -- which is how a supply room drawn over its
    neighbour, and a room drawn on a slice of corridor, both came to light. Long
    thin shapes are the corridor case: a room is roughly as deep as it is wide,
    and one that is four times longer than it is broad is usually a piece of
    hallway wearing a room number. A corridor may be exactly that shape, so it
    is only remarked on for rooms.
    """
    from shapely.geometry import Polygon, Point
    path = os.path.join(OUT_DIR, name + ".geojson")
    with open(path, encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    img = load(name)
    H, W = img.shape
    pl = placement(name)
    pxm = W / pl["widthM"] if pl else 17.0
    shapes, notes = [], []
    for f in feats:
        p = f["properties"]
        g = Polygon([(u*W, v*H) for u, v in p["uv"]])
        if not g.is_valid or g.area <= 0:
            notes.append("%s: the outline crosses itself" % p["room"])
            continue
        shapes.append((p, g))
        box = g.minimum_rotated_rectangle.exterior.coords
        sides = [math.dist(box[i], box[i+1]) for i in range(4)]
        ratio = max(sides) / max(min(sides), 1e-6)
        if ratio > 3.6 and p["type"] not in ("hallway",) and p.get("use") not in ("CORRIDOR", "SHAFT"):
            notes.append("%s (%s): %.1f times longer than it is wide -- a piece of corridor?"
                         % (p["room"], p.get("use") or p["type"], ratio))
        if g.area / (pxm*pxm) < 2.0:
            notes.append("%s: barely any area" % p["room"])
    for i, (p1, g1) in enumerate(shapes):
        for p2, g2 in shapes[i+1:]:
            share = g1.intersection(g2).area
            if share > 0.18 * min(g1.area, g2.area):
                notes.append("%s and %s stand on the same floor (%.0f%% of the smaller)"
                             % (p1["room"], p2["room"], 100*share/min(g1.area, g2.area)))
    lab = os.path.join(WORK_DIR, name + ".txt")
    if os.path.exists(lab):
        placed = {p["room"]: g for p, g in shapes}
        for line in open(lab, encoding="utf-8"):
            line = line.split("#")[0].strip()
            if not line or "," not in line.split()[0]:
                continue
            where, room = line.split()[0], line.split()[1]
            x, y = (float(v) for v in where.split(","))
            g = placed.get(room)
            if g is not None and not g.contains(Point(x, y)):
                notes.append("%s does not contain the label it was named from" % room)
    print("%s: %d spaces" % (name, len(shapes)))
    for n in notes:
        print("   " + n)
    if not notes:
        print("   nothing obviously wrong")
    return notes


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("what", choices=["cards", "write", "check"])
    ap.add_argument("floors", nargs="+", help="e.g. SW1-Floor3")
    ap.add_argument("--all", action="store_true",
                    help="cards for every room, not just the ones with no number yet")
    args = ap.parse_args()
    os.makedirs(WORK_DIR, exist_ok=True)
    for name in args.floors:
        if args.what == "check":
            audit(name)
            continue
        cfg = dict(SHEETS.get(name, DEFAULT))
        seg_path = os.path.join(WORK_DIR, name + "_seg.json")
        if args.what == "cards":
            seg = read_sheet(name, **cfg)
            with open(seg_path, "w", encoding="utf-8") as fh:
                json.dump(seg, fh)
            done = set() if args.all else already_read(name, seg)
            paths = cards(seg, WORK_DIR, skip=done)
            print("%s: %d rooms found, %d already read, %d cards to read"
                  % (name, len(seg["rooms"]), len(done), len(paths)))
            for p in paths:
                print("   " + os.path.relpath(p, REPO))
            print("   then write %s, a line per room, and: write %s"
                  % (os.path.relpath(os.path.join(WORK_DIR, name + ".txt"), REPO), name))
            continue
        seg = load_seg(name, cfg, seg_path)
        lab_path = os.path.join(WORK_DIR, name + ".txt")
        if not os.path.exists(lab_path):
            raise SystemExit("no %s yet: run `cards %s` and read them" % (lab_path, name))
        fc = write_floor(name, seg, read_labels(lab_path, seg))
        out = os.path.join(OUT_DIR, name + ".geojson")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(fc, fh, indent=1)
        kinds = Counter(f["properties"]["type"] for f in fc["features"])
        print("%s: %d spaces -> %s  (%s)"
              % (name, len(fc["features"]), os.path.relpath(out, REPO),
                 ", ".join("%s %d" % (k, v) for k, v in sorted(kinds.items()))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
