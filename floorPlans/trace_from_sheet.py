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
SEALS = (7, 11, 15, 19, 23, 29, 37, 45)

# Which ink to read the walls from, per sheet, tried in order. A sheet is often
# two drawings -- a wing surveyed in one decade and a wing in another, with
# different pens -- so there is no one answer to which lineweight the walls are,
# and the honest thing is to try each and let the labels say which worked where.
# `widths` are PDF stroke weights; `layers` are CAD layer names, on the sheets
# whose export kept them; an empty dict means the rendered sheet, ink and all.
WALLS = ["WALL", "JAMB", "DOOR", "DSWING", "GLAZE", "SILL", "STAIR",
         "A-DR-FR", "A-DOOR"]
SHEETS = {
    "SW1-Floor1": dict(inks=[{"widths": [0.54, 0.72]},
                             {"widths": [0.12, 0.36, 0.42, 0.54, 0.72]}, {}]),
    "SW1-Floor2": dict(inks=[{"widths": [0.12, 0.36, 0.42, 0.54, 0.72]},
                             {"widths": [0.12]}, {}]),
    "SW1-Floor3": dict(inks=[{"layers": WALLS}, {}]),
    "SW1-Floor4": dict(inks=[{"layers": WALLS}, {}]),
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
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close))
    free = (1 - cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(free, 4)
    gk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*grow+1, 2*grow+1))
    ok = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)) if open_k else None
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
        if ok is not None:
            # take the door alcoves out: a metre-deep notch every few metres is
            # what makes a traced corridor look like a comb
            opened = cv2.morphologyEx(sub, cv2.MORPH_OPEN, ok)
            if opened.sum() > 0.55 * sub.sum():
                sub = opened
        sub = cv2.dilate(sub, gk)
        cs, _ = cv2.findContours(sub, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        poly = simplify(max(cs, key=cv2.contourArea)) + np.array([x - pad, y - pad], float)
        out.append(dict(px=int(a), bbox=[int(x), int(y), int(w), int(h)],
                        cen=[float(cent[i][0]), float(cent[i][1])],
                        poly=[[round(float(p[0]), 1), round(float(p[1]), 1)] for p in poly]))
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
    """Glyph-sized ink inside the outline, gathered into lines of text."""
    m = np.zeros(img.shape, np.uint8)
    cv2.fillPoly(m, [np.array(poly, np.int32)], 1)
    m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    x, y, w, h = cv2.boundingRect(np.array(poly, np.int32))
    x, y = max(x, 0), max(y, 0)
    ink = ((img[y:y+h, x:x+w] < 200) & (m[y:y+h, x:x+w] > 0)).astype(np.uint8)
    n, lab, st, ce = cv2.connectedComponentsWithStats(ink, 8)
    glyphs = [i for i in range(1, n)
              if 7 <= st[i][3] <= 34 and 1 <= st[i][2] <= 46 and st[i][4] >= 6]
    rows = {}
    for i in glyphs:
        rows.setdefault(round(ce[i][1] / 16), []).append(i)
    runs = []
    for ids in rows.values():
        ids.sort(key=lambda i: ce[i][0])
        run = [ids[0]]
        for i in ids[1:]:
            if ce[i][0] - ce[run[-1]][0] < 60:
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
        ink = turn(wall_ink(name, cfg.get("widths"), cfg.get("layers"),
                            cfg.get("fills", False)))
        img = turn(flat)
        for close in SEALS:
            for r in patches(ink, close, grow, int(min_m2 * pxm * pxm),
                             int(max_m2 * pxm * pxm), open_k):
                found = labels_in(img, r["poly"])
                if len(found) != 1:
                    continue
                cx, cy = found[0]["cx"], found[0]["cy"]
                # one room, one outline: the same label found again at a tighter
                # seal is the same room, not another one
                if any(abs(c["lcx"] - cx) < 40 and abs(c["lcy"] - cy) < 22 for c in chosen):
                    continue
                r.update(label=found[0]["box"], lcx=cx, lcy=cy, seal=close,
                         m2=round(r["px"] / (pxm * pxm), 1),
                         ink=str(cfg.get("layers") or cfg.get("widths") or "sheet"))
                chosen.append(r)
    out = sorted(chosen, key=lambda r: (r["label"][1], r["label"][0]))
    snap_grid(out, snap)
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


CW, CH, COLS, ROWS = 350, 130, 5, 8
SW, SH = 250, 93              # what is cut out, before it is blown up to fit


def cards(seg, out_dir):
    """A card per room: its label highlighted, its outline drawn, big enough to read."""
    name, rot = seg["name"], seg.get("rot", 0)
    colour = cv2.cvtColor(load(name), cv2.COLOR_GRAY2BGR)
    H, W = colour.shape[:2]
    tiles = []
    for r in seg["rooms"]:
        lx, ly, lw, lh = r["label"]
        x, y, w, h = (lx - (lh-lw)//2, ly - (lw-lh)//2, lh, lw) if rot else (lx, ly, lw, lh)
        cw, ch = (SH, SW) if rot else (SW, SH)
        x0 = int(np.clip(x + w//2 - cw//2, 0, W - cw))
        y0 = int(np.clip(y + h//2 - ch//2, 0, H - ch))
        tile = colour[y0:y0+ch, x0:x0+cw].copy()
        lit = tile.copy()
        cv2.rectangle(lit, (lx - x0 - 4, ly - y0 - 4),
                      (lx + lw - x0 + 4, ly + lh - y0 + 4), (120, 235, 255), -1)
        tile = cv2.addWeighted(tile, 0.55, lit, 0.45, 0)
        cv2.polylines(tile, [np.array(r["poly"], np.int32) - [x0, y0]], True, (0, 0, 230), 2)
        if rot:
            tile = cv2.rotate(tile, cv2.ROTATE_90_COUNTERCLOCKWISE)
        tiles.append((r["id"], r["m2"],
                      cv2.resize(tile, (CW, CH), interpolation=cv2.INTER_CUBIC)))
    paths, per = [], COLS * ROWS
    for s in range(0, len(tiles), per):
        canvas = np.full((ROWS * (CH+26), COLS * (CW+6), 3), 255, np.uint8)
        for k, (rid, m2, tile) in enumerate(tiles[s:s+per]):
            rr, cc = divmod(k, COLS)
            y0, x0 = rr * (CH+26), cc * (CW+6)
            canvas[y0+26:y0+26+CH, x0:x0+CW] = tile
            cv2.putText(canvas, "#%d" % rid, (x0+4, y0+19),
                        cv2.FONT_HERSHEY_SIMPLEX, .62, (0, 0, 0), 2)
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


def read_labels(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#")[0].strip()
            if not line:
                continue
            bits = line.split()
            if len(bits) < 3:
                print("   ignoring %r: wanted '<card> <room> <USE-CODE>'" % line)
                continue
            out[int(bits[0])] = (bits[1], bits[2])
    return out


def load_seg(name, cfg, path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    seg = read_sheet(name, **cfg)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(seg, fh)
    return seg


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("what", choices=["cards", "write"])
    ap.add_argument("floors", nargs="+", help="e.g. SW1-Floor3")
    args = ap.parse_args()
    os.makedirs(WORK_DIR, exist_ok=True)
    for name in args.floors:
        cfg = dict(SHEETS.get(name, DEFAULT))
        seg_path = os.path.join(WORK_DIR, name + "_seg.json")
        if args.what == "cards":
            seg = read_sheet(name, **cfg)
            with open(seg_path, "w", encoding="utf-8") as fh:
                json.dump(seg, fh)
            paths = cards(seg, WORK_DIR)
            print("%s: %d rooms found, %d cards to read"
                  % (name, len(seg["rooms"]), len(paths)))
            for p in paths:
                print("   " + os.path.relpath(p, REPO))
            print("   then write %s, a line per room, and: write %s"
                  % (os.path.relpath(os.path.join(WORK_DIR, name + ".txt"), REPO), name))
            continue
        seg = load_seg(name, cfg, seg_path)
        lab_path = os.path.join(WORK_DIR, name + ".txt")
        if not os.path.exists(lab_path):
            raise SystemExit("no %s yet: run `cards %s` and read them" % (lab_path, name))
        fc = write_floor(name, seg, read_labels(lab_path))
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
