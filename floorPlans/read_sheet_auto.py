"""Read a sheet the whole way -- the shapes and the numbers both.

`trace_from_sheet.py` splits a floor at the seam where a machine stops being
trustworthy: it takes the outlines off the drawing and hands the numbers to a
person, one card per room. That is the right split when the floor matters and
somebody is going to check it. It is the wrong split when seventy-eight floors
are still empty, because the person never reaches the seventy-eighth.

So this reads the numbers too. The labels are curves rather than text, but they
are *vector* curves: re-rendered from the PDF at six times the tracing scale a
stencil glyph is a hundred pixels tall and Tesseract gets most of them. What it
does not get is which of 1, l and | it is looking at -- the same confusion
`auto_extract_rooms.py` documented, and the same cure works here: read the line
unrestricted, map the look-alikes to digits, and let the floor vote on how many
digits a room number has.

Nothing written here is verified. Every space says `source: "ocr"`, and the
ones it is least sure of say `check: true`, so a floor read this way can be
told from a floor somebody traced -- on the map, in the tracer, and in a
one-line grep. The readings also go to
`floorPlans/_sheets/{FLOOR}.txt.unverified`, which is the format the cards
produce: rename it to `.txt` once you have checked it against the cards and the
hand path carries on from there with nothing lost.

Usage:
    py -3 floorPlans/read_sheet_auto.py SE6-Floor1 NE6-Floor1
    py -3 floorPlans/read_sheet_auto.py --all          # every sheet on campus
    py -3 floorPlans/read_sheet_auto.py --all --jobs 6
"""
import sys, os, re, json, glob, time, argparse, difflib, subprocess
from collections import Counter

import numpy as np
import cv2
import pymupdf
import pytesseract

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trace_from_sheet as T

for _p in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
           r"C:\Users\%s\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"
           % os.environ.get("USERNAME", "")):
    if os.path.exists(_p):
        pytesseract.pytesseract.tesseract_cmd = _p
        break

# Six times the tracing zoom. The tracing frame is fixed -- the placement is
# calibrated in it -- but nothing says a label has to be read in it, and a
# 216 dpi stencil digit enlarged is still a 216 dpi stencil digit.
LABEL_ZOOM = 6.0

# The look-alikes auto_extract_rooms.py found, for the reason it found them:
# this is a drafting stencil, and in it a 1 is a bar, a 0 is a ring, a 6 is a G.
GLYPH_TO_DIGIT = str.maketrans({
    "O": "0", "o": "0", "D": "0", "Q": "0", "U": "0", "C": "0", "c": "0",
    "I": "1", "l": "1", "|": "1", "L": "1", "T": "1", "J": "1", "i": "1",
    "Z": "2", "z": "2", "S": "5", "s": "5", "G": "6", "b": "6", "e": "6",
    "B": "8", "g": "9", "q": "9", "A": "4",
})
# and the same confusion read the other way, for the use code, which is letters
DIGIT_TO_GLYPH = str.maketrans({"0": "O", "1": "I", "2": "Z", "4": "A",
                                "5": "S", "6": "G", "8": "B", "9": "G"})

# A use code reduced to the letters it is made of, so a lost hyphen is not a
# lost match. Built from the map trace_from_sheet already keeps.
USE_KEYS = {re.sub(r"[^A-Z0-9]", "", k): k for k in T.USE}
FUZZY = 0.68              # how close a mangled code must be to count as that code
SURE = 0.60               # below this, a reading is written with check: true

OUT_DIR = T.OUT_DIR
WORK_DIR = T.WORK_DIR


# ---------------------------------------------------------------------------
# Which ink the walls are, decided per sheet
# ---------------------------------------------------------------------------
def ink_ladder(name):
    """What to try reading the walls from, best first.

    Four of these eighty-nine sheets kept their CAD layer names, and on those
    the question is already answered. The rest answer a narrower version of it:
    a room label on these sheets is a *filled* curve and a wall is a *stroked*
    one, so asking for strokes by weight -- any weight -- throws away the text,
    the hatching and the solid furniture without needing to know which pen the
    walls were drawn with. That is most of the benefit of the hand-picked
    lineweights in trace_from_sheet.SHEETS, had without picking any.

    The rendered sheet goes last rather than nowhere: ink-and-all segmentation
    finds a few labels the filtered pass loses to a gap in a wall that
    furniture had quietly been closing, and a worse outline beats no outline.
    """
    if name in T.SHEETS:
        return list(T.SHEETS[name]["inks"])
    path = os.path.join(T.PDF_DIR, name + ".pdf")
    layers, widths = Counter(), Counter()
    try:
        doc = pymupdf.open(path)
        page = doc[0]
        for d in page.get_drawings():
            lay = (d.get("layer") or "").split("|")[-1].upper()
            if lay:
                layers[lay] += 1
            if d["type"] not in ("f", "fs"):
                widths[round(d.get("width") or 0, 2)] += 1
        doc.close()
    except Exception:
        return [{}]
    if sum(v for k, v in layers.items() if k in set(T.WALLS)) > 200:
        return [{"layers": T.WALLS}, {"layers": T.WALLS + ["STAIR"]}, {}]
    if widths:
        return [{"widths": sorted(widths)}, {}]
    return [{}]            # a sheet with no vectors at all: scanned, or flattened


# ---------------------------------------------------------------------------
# The label, read
# ---------------------------------------------------------------------------
class Sheet:
    """The PDF behind a rendered sheet, ready to give up one label at a time."""

    def __init__(self, name):
        self.doc = pymupdf.open(os.path.join(T.PDF_DIR, name + ".pdf"))
        self.page = self.doc[0]
        self.crop = T.ink_crop(self.page)
        self.mat = pymupdf.Matrix(T.ZOOM * LABEL_ZOOM, T.ZOOM * LABEL_ZOOM)

    def label(self, box):
        """One label's patch of sheet, in greyscale, as big as it gets.

        Wider than the box, because the box is not the label. It is the glyphs
        of the label that fell inside the room's outline, eroded -- so a number
        printed hard against a wall arrives with its first digit cut off, and
        "STOR-GEN" arrives as "OR-GE". A margin of about a character on each
        side gets the whole word back, and a room label has nothing but floor
        around it to pick up instead.
        """
        x, y, w, h = box
        px, py = max(10, int(h * 0.8)), max(6, int(h * 0.35))
        cx, cy = self.crop[0], self.crop[1]
        r = pymupdf.Rect((cx + x - px) / T.ZOOM, (cy + y - py) / T.ZOOM,
                         (cx + x + w + px) / T.ZOOM, (cy + y + h + py) / T.ZOOM)
        pix = self.page.get_pixmap(matrix=self.mat, clip=r)
        a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        return a[:, :, :3].min(axis=2) if pix.n >= 3 else a[:, :, 0]


def bands(g, thr=170, min_h=8):
    """The rows of glyphs in a label patch, top to bottom.

    A label is a number over a use code and Tesseract reads a line at a time,
    so the two have to be cut apart before either can be read. They are cut on
    the blank row between them, which is the one thing about this layout every
    sheet agrees on.
    """
    ink = (g < thr).astype(np.uint8)
    on = ink.sum(axis=1) > max(1, int(0.01 * g.shape[1]))
    out, start = [], None
    for i, v in enumerate(on):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_h:
                out.append((start, i))
            start = None
    if start is not None and len(on) - start >= min_h:
        out.append((start, len(on)))
    return out


def ocr(g, psm=7, extra=""):
    one = cv2.copyMakeBorder(g, 24, 24, 24, 24, cv2.BORDER_CONSTANT, value=255)
    try:
        return pytesseract.image_to_string(one, config="--psm %d%s" % (psm, extra)).strip()
    except Exception:
        return ""


def ocr_digits(g):
    return ocr(g, psm=7, extra=" -c tessedit_char_whitelist=0123456789")


def as_code(raw):
    """The use code this line is, and how sure that is."""
    txt = re.sub(r"[^A-Z0-9]", "", raw.upper())
    if len(txt) < 2:
        return None, 0.0
    for cand in (txt, txt.translate(DIGIT_TO_GLYPH)):
        if cand in USE_KEYS:
            return USE_KEYS[cand], 1.0
    best, score = None, 0.0
    for cand in (txt, txt.translate(DIGIT_TO_GLYPH)):
        for red, key in USE_KEYS.items():
            r = difflib.SequenceMatcher(None, cand, red).ratio()
            if r > score:
                best, score = key, r
    return (best, score) if score >= FUZZY else (None, score)


def as_number(raw):
    """The room number this line is, and whether it needed the look-alike map.

    The length test is on the glyphs, not on the digits they turn into. Every
    letter in this stencil looks like some digit -- C is a 0, J is a 1, S is a
    5 -- so JANITOR translates to a perfectly plausible five-figure room
    number, and so does CLASS. A room number is three or four characters wide,
    and anything wider is a word.
    """
    glyphs = re.sub(r"[^0-9A-Za-z|]", "", raw)
    if not 2 <= len(glyphs) <= 5:
        return None, False
    direct = re.sub(r"[^0-9]", "", glyphs)
    mapped = re.sub(r"[^0-9]", "", glyphs.translate(GLYPH_TO_DIGIT))
    if not 2 <= len(mapped) <= 5:
        return None, False
    return mapped, direct == mapped


def read_label(patch, floor):
    """What a label says, tried all three ways up.

    Most labels read across the page. The ones in a narrow room are turned on
    their side, and a sheet drawn sideways turns all of them -- so each patch is
    read upright and both ways round, and the turn that yields a number and a
    code it recognises is the one the label was written at.
    """
    best = dict(score=-1.0, room=None, code=None, conf=0.0, raw="")
    for k in (0, 1, 3):
        g = np.ascontiguousarray(np.rot90(patch, k) if k else patch)
        cut = [g[max(a - 4, 0):b + 4] for a, b in bands(g)]
        rows = [(im, ocr(im)) for im in cut]
        # A label whose two lines touch has one band, and a line read as a
        # block instead of a line is read differently -- so the whole patch is
        # offered as well, and whichever reading scores better is taken.
        rows += [(None, l) for l in ocr(g, psm=6).splitlines() if l.strip()]
        rows = [(im, l) for im, l in rows if l]
        lines = [l for _im, l in rows]
        if not lines:
            continue
        # Every line that reads as a use code is a use code. Not just the best
        # one: a patch often holds the same label twice over, once split into
        # bands and once read whole, and a word left in the running for the
        # number is a word that becomes one.
        code, cscore, words = None, 0.0, set()
        for i, l in enumerate(lines):
            c, s = as_code(l)
            if not c:
                continue
            words.add(i)
            if s > cscore:
                code, cscore = c, s
        room, clean, pick = None, False, -1.0
        for i, (im, l) in enumerate(rows):
            if i in words:
                continue
            n, cl = as_number(l)
            if not n:
                continue
            # Asked for digits and nothing else, Tesseract cannot answer "S"
            # where an 8 is -- but it does drop glyphs it is unsure of, which
            # is why it cannot be trusted on its own. Where it reads the same
            # number of figures as the look-alike map did, it is reading the
            # same figures, and it is the one that was not guessing.
            if im is not None and not cl:
                only = re.sub(r"[^0-9]", "", ocr_digits(im))
                if len(only) == len(n) and only != n:
                    n, cl = only, True
            # the reading that needed the least guessing wins: digits that were
            # already digits, a first figure that matches the floor it is on
            s = 2.0 * len(re.sub(r"[^0-9]", "", l)) + (1.0 if cl else 0.0) \
                + (1.0 if n[0] == floor else 0.0)
            if s > pick:
                room, clean, pick = n, cl, s
        score = (2.0 if cscore >= 1.0 else cscore) + (2.0 if room else 0.0)
        if room and room[0] == floor:
            score += 1.0
        if score > best["score"]:
            best = dict(score=score, room=room, code=code, raw=" / ".join(lines),
                        conf=0.35 * (cscore if code else 0) + 0.35 * bool(room)
                        + 0.15 * clean + 0.15 * bool(room and room[0] == floor))
    return best


# ---------------------------------------------------------------------------
# A floor
# ---------------------------------------------------------------------------
def pick_patch(rooms):
    """One outline per label, where the reading of the sheet offered several.

    `by_leader` draws a shape for a label it could not enclose, and sometimes
    the fill had enclosed it after all -- so the same number ends up on two
    outlines, a real room and the scrap beside it. The larger is the room; the
    scrap is what was left over.
    """
    kept = []
    for r in sorted(rooms, key=lambda r: -r["m2"]):
        near = next((k for k in kept
                     if abs(k["lcx"] - r["lcx"]) < 25 and abs(k["lcy"] - r["lcy"]) < 25),
                    None)
        if near is None:
            kept.append(r)
    return sorted(kept, key=lambda r: (r["label"][1], r["label"][0]))


def settle_numbers(reads, floor):
    """The floor's own vote on what a room number looks like here.

    Mapping look-alikes to digits over-produces -- a D becomes a 0 that was
    never there -- and under-produces when a glyph is clipped. Room numbers on
    one floor share a length, so that length is taken as the truth: a long read
    is cut to it and a short one is dropped, which is auto_extract_rooms.py's
    rule and holds just as well here.
    """
    lens = Counter(len(r["room"]) for r in reads.values() if r["room"])
    if not lens:
        return
    want = lens.most_common(1)[0][0]
    for r in reads.values():
        n = r["room"]
        if not n:
            continue
        if len(n) > want:
            r["room"], r["conf"] = n[:want], min(r["conf"], 0.55)
        elif len(n) < want:
            r["room"], r["conf"] = None, 0.0
        if r["room"] and r["room"][0] != floor:
            r["conf"] = min(r["conf"], 0.5)


def write_floor(name, seg, rooms, reads):
    """The floor as a tracer file, every space saying a machine read it."""
    building, _, floor = name.partition("-Floor")
    pl = T.placement(name)
    if not pl:
        raise SystemExit("%s has no placement" % name)
    W, H = seg["W"], seg["H"]
    by_id = {r["id"]: r for r in rooms}
    feats, seen, dropped = [], {}, 0
    # the biggest outline for a number keeps it, so a scrap cannot take a room's
    order = sorted(reads.items(),
                   key=lambda kv: -(by_id[kv[0]]["m2"] if kv[0] in by_id else 0))
    for rid, got in order:
        room, r = got["room"], by_id.get(rid)
        if not room or r is None:
            continue
        kind, label = T.USE.get((got["code"] or "").upper(), ("room", None))
        if got["code"] == "STAIR" and re.match(r"^5\d{2,3}$", room):
            room = "S" + room[1:]      # the stencil S that reads as a 5
        if room in seen:
            # Two outlines read as the same room: one of the two numbers is
            # misread, and which is anybody's guess. Throwing the second away
            # would throw a real room's shape away with it, so it keeps the
            # shape under a suffixed number and says to check it -- the same
            # form name_nodes.py uses for a room with two doors.
            dropped += 1
            seen[room] += 1
            room = "%s-%d" % (room, seen[room])
            got = dict(got, conf=min(got["conf"], 0.4))
        seen.setdefault(room, 1)
        uv = [[round(p[0] / W, 6), round(p[1] / H, 6)] for p in r["poly"]]
        ring = [T.uv_to_lnglat(p, pl, W, H) for p in uv]
        ring.append(ring[0])
        props = {"room": room, "building": building, "floor": floor, "type": kind,
                 "source": "ocr", "use": (got["code"] or "UNKNOWN"), "uv": uv,
                 "conf": round(got["conf"], 2)}
        if label:
            props["name"] = label
        if got["conf"] < SURE or not got["code"]:
            props["check"] = True
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})
    feats.sort(key=lambda f: f["properties"]["room"])
    return {"type": "FeatureCollection", "features": feats}, dropped


def retry(fn, name, tries=4, wait=3.0):
    """Try again before giving a sheet up.

    Reading a sheet opens a two-megapixel PNG and a CAD PDF at once, and with
    several of these running side by side the machine occasionally hands back
    nothing instead of a picture -- `cv2.imread` says None and the sheet looks
    unreadable when it is only busy. Waiting and asking again costs seconds and
    saves a floor, so the failure is only believed the fourth time.
    """
    for i in range(tries):
        try:
            return fn()
        except SystemExit as e:
            if i == tries - 1:
                print("%-14s cannot be read: %s" % (name, e))
                return None
            time.sleep(wait * (i + 1))


MAX_HALL_M2 = 1500        # past this a "corridor" is the lawn, not a corridor
CAMPUS = os.path.join(T.REPO, "public", "data", "bcit-coordinates.geojson")


def footprint(building, pl, W, H, rooms):
    """This building's outline as the campus has it, in sheet pixels.

    Used only to say what is outside the building, and only when it can be
    trusted to. Several of these footprints do not match their drawing -- SW9's
    is three times its own floor, NE2's covers only part of it -- and one
    smaller than the drawing would cut real rooms off the edge of it, so a
    footprint that does not hold most of the floor's rooms is not used at all.
    A footprint that is too big is harmless here: it rejects nothing, which is
    where this started.

    `rooms` are the rooms' middles, in sheet pixels.
    """
    try:
        from shapely.geometry import Polygon as _P, shape as _shape
        from shapely.ops import unary_union as _union
        with open(CAMPUS, encoding="utf-8") as fh:
            fc = json.load(fh)
    except Exception:
        return None
    want = building.upper()
    rings = []
    for f in fc.get("features") or []:
        p = f.get("properties") or {}
        names = {str(p.get(k)).upper() for k in ("BuildingName", "Display_Name",
                                                 "BldgCode", "SiteName")
                 if p.get(k)}
        if want not in names:
            continue
        try:
            g = _shape(f["geometry"])
        except Exception:
            continue
        for q in (g.geoms if g.geom_type == "MultiPolygon" else [g]):
            if q.geom_type == "Polygon":
                rings.append(q.exterior.coords)
    if not rings:
        return None
    # the placement maps pixels to the world; this goes back the other way, by
    # fitting the same map on the sheet's four corners
    src = np.float32([T.uv_to_lnglat([u, v], pl, W, H)
                      for u, v in ((0, 0), (1, 0), (1, 1))])
    dst = np.float32([(0, 0), (W, 0), (W, H)])
    A = cv2.getAffineTransform(src, dst)
    shapes = []
    for r in rings:
        pts = np.float32([[c[0], c[1]] for c in r]).reshape(-1, 1, 2)
        px = cv2.transform(pts, A).reshape(-1, 2)
        try:
            q = _P([(float(x), float(y)) for x, y in px])
            shapes.append(q if q.is_valid else q.buffer(0))
        except Exception:
            continue
    if not shapes:
        return None
    foot = _union(shapes)
    if foot.is_empty or foot.area <= 0:
        return None
    # Is this footprint the right shape for this drawing? Asked of the rooms
    # one at a time rather than of the shape they span, because the shape they
    # span is exactly what a stray outline wrecks: one patch read out of the
    # title block puts the far corner of the page inside the hull, no footprint
    # covers it, and the test that was meant to catch the stray is switched off
    # by it. Most of a floor's rooms are real and in the building, so most of
    # them landing inside the footprint is what says the footprint fits.
    if rooms:
        home = sum(1 for c in rooms if foot.covers(c))
        if home < 0.6 * len(rooms):
            return None
    return foot


def add_halls(name):
    """The space between the rooms, which is where people actually walk.

    `trace_from_sheet.circulation` works this out by subtraction -- everything
    inside the outer wall that is not a room -- and has been sitting there
    unused, because the card path writes the rooms a person read and nothing
    else. Routing needs the other half: a floor of rooms with no corridor
    between them has nowhere to put a walking network, so every room joins to
    its neighbour through a wall.

    It runs as a pass of its own, over the floor as written, so it can be run
    again after somebody corrects the rooms without re-reading the sheet.
    """
    path = os.path.join(OUT_DIR, name + ".geojson")
    if not os.path.exists(path):
        print("%-14s nothing traced" % name)
        return 0
    with open(path, encoding="utf-8") as fh:
        fc = json.load(fh)
    building, _, floor = name.partition("-Floor")
    feats = [f for f in fc.get("features", [])
             if (f.get("properties") or {}).get("source") != "auto"]
    pl = T.placement(name)
    if not pl:
        print("%-14s no placement" % name)
        return 0
    img = retry(lambda: T.load(name), name)
    if img is None:
        return 0
    H, W = img.shape
    from shapely.geometry import MultiPoint, Point as _Pt, Polygon as _Poly

    def as_poly(f):
        uv = (f.get("properties") or {}).get("uv")
        if not uv or len(uv) < 3:
            return None
        q = _Poly([(u * W, v * H) for u, v in uv])
        q = q if q.is_valid else q.buffer(0)
        return q if (not q.is_empty and q.area > 0) else None

    shapes = [(f, as_poly(f)) for f in feats]
    middles = [q.representative_point() for _f, q in shapes if q is not None]
    foot = footprint(building, pl, W, H, middles)

    # A sheet is a drawing of a building printed on a page, and the page has
    # more on it than the building: a title block, a key plan, a north point,
    # a logo. Each of those is ink with a word inside it, which is what a room
    # looks like from here -- SW1's second floor came back with three "rooms"
    # down in the title block, joined to the rest by links running clear
    # across the paper. Where the campus knows the building's outline, that
    # settles it; what the machine read outside the building did not come off
    # the building. What a person drew is left exactly where they drew it.
    outside = 0
    if foot is not None:
        kept = []
        for f, q in shapes:
            p = f.get("properties") or {}
            if p.get("source") == "ocr" and q is not None \
                    and q.intersection(foot).area < 0.5 * q.area:
                outside += 1
                continue
            kept.append((f, q))
        shapes = kept
        feats = [f for f, _q in shapes]

    rooms = []
    for f in feats:
        uv = (f.get("properties") or {}).get("uv")
        if uv:
            rooms.append({"poly": [[u * W, v * H] for u, v in uv]})
    if not rooms:
        print("%-14s no outlines to subtract from" % name)
        return 0
    cfg = ink_ladder(name)[0]
    try:
        halls = T.circulation(name, cfg, rooms)
    except Exception as e:
        print("%-14s corridors failed: %s: %s" % (name, type(e).__name__, e))
        return 0
    # What subtraction leaves is not all corridor. Two things come out with it:
    # the cavity inside a double-drawn wall, which is a corridor's shape and a
    # hand's width, and the strip between the outer wall and the site line,
    # which is outside the building altogether and which no measurement of the
    # shape tells from a real corridor -- it is two metres wide and forty long,
    # exactly like the one down the middle. What tells them apart is the
    # campus: one is inside the building's footprint and the other is not.
    hull = MultiPoint([tuple(p) for r in rooms for p in r["poly"]]).convex_hull
    pxm = W / pl["widthM"]
    # A corridor is a part of a floor. One that is a sizeable fraction of the
    # whole floor is not a corridor -- it is the leftover between the drawing
    # and the edge of the hull, which on a floor whose rooms do not tile it is
    # most of the page.
    floor_m2 = sum(q.area for _f, q in shapes if q is not None) / (pxm * pxm)
    cap = min(MAX_HALL_M2, max(0.4 * floor_m2, 60.0))
    n = 0
    for c in sorted(halls, key=lambda c: -c["m2"]):
        if not 4.0 <= c["m2"] <= cap or len(c["poly"]) < 3:
            continue
        side = min(cv2.minAreaRect(np.array(c["poly"], np.float32))[1]) / pxm
        if side < 0.8:
            continue
        try:
            q = _Poly(c["poly"])
            q = q if q.is_valid else q.buffer(0)
            if q.area <= 0 or q.intersection(hull).area < 0.7 * q.area:
                continue
            if foot is not None and q.intersection(foot).area < 0.6 * q.area:
                continue
        except Exception:
            continue
        n += 1
        uv = [[round(p[0] / W, 6), round(p[1] / H, 6)] for p in c["poly"]]
        ring = [T.uv_to_lnglat(p, pl, W, H) for p in uv]
        ring.append(ring[0])
        feats.append({
            "type": "Feature",
            "properties": {"room": "%sH%d" % (floor, n), "building": building,
                           "floor": floor, "type": "hallway", "source": "auto",
                           "use": "CORRIDOR", "uv": uv, "check": True},
            "geometry": {"type": "Polygon", "coordinates": [ring]}})
    fc["features"] = feats
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, indent=1)
    print("%-14s %d corridor(s) between the rooms%s"
          % (name, n, ", %d read space(s) dropped as off the building" % outside
             if outside else ""))
    return n


def hand_traced(name):
    """Everything on this floor that somebody drew, as opposed to this script.

    A floor is never replaced, only filled in. Reading SW2's second floor by
    machine must not cost the three stairwells a person already put there, and
    reading SW3's first floor again must not cost it anything at all -- so the
    hand's work is held back, the machine's is fitted around it, and what the
    machine wrote last time is the only thing this overwrites.
    """
    path = os.path.join(OUT_DIR, name + ".geojson")
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)
    except Exception:
        return []
    return [f for f in fc.get("features", [])
            if (f.get("properties") or {}).get("source") not in ("ocr", "auto")]


OVERLAP = 0.25            # how much of a read room may sit on a drawn one


def fit_around(held, feats):
    """The read spaces that do not tread on a space somebody drew."""
    if not held:
        return feats, 0
    from shapely.geometry import Polygon, shape
    from shapely.ops import unary_union
    taken, shapes = set(), []
    for f in held:
        p = f.get("properties") or {}
        if p.get("room"):
            taken.add(str(p["room"]))
        try:
            g = shape(f["geometry"])
            if g.is_valid and not g.is_empty and g.geom_type in ("Polygon", "MultiPolygon"):
                shapes.append(g)
        except Exception:
            continue
    drawn = unary_union(shapes) if shapes else None
    out, lost = [], 0
    for f in feats:
        if str(f["properties"]["room"]) in taken:
            lost += 1
            continue
        if drawn is not None:
            try:
                g = Polygon(f["geometry"]["coordinates"][0])
                if g.is_valid and g.area > 0 and \
                        g.intersection(drawn).area > OVERLAP * g.area:
                    lost += 1
                    continue
            except Exception:
                pass
        out.append(f)
    return out, lost


def do_floor(name, fresh=False):
    held = hand_traced(name)
    cfg = dict(inks=ink_ladder(name))
    seg_path = os.path.join(WORK_DIR, name + "_seg.json")
    if fresh and os.path.exists(seg_path):
        os.remove(seg_path)
    seg = retry(lambda: T.load_seg(name, cfg, seg_path), name)
    if seg is None:
        return None
    rooms = pick_patch(seg["rooms"])
    sheet = Sheet(name)
    floor = name.partition("-Floor")[2][:1]
    reads = {r["id"]: read_label(sheet.label(r["label"]), floor) for r in rooms}
    settle_numbers(reads, floor)
    fc, dropped = write_floor(name, seg, rooms, reads)
    fc["features"], lost = fit_around(held, fc["features"])
    fc["features"] = held + fc["features"]

    with open(os.path.join(OUT_DIR, name + ".geojson"), "w", encoding="utf-8") as fh:
        json.dump(fc, fh, indent=1)
    lines = ["# Read by floorPlans/read_sheet_auto.py -- nobody has checked these.",
             "# Rename to %s.txt once somebody has, and the card path takes over."
             % name]
    at = {r["id"]: r for r in rooms}
    for rid, got in sorted(reads.items(), key=lambda kv: kv[1]["room"] or "~"):
        if got["room"]:
            lines.append("%.0f,%.0f %s %s" % (at[rid]["lcx"], at[rid]["lcy"],
                                              got["room"], got["code"] or "UNKNOWN"))
    with open(os.path.join(WORK_DIR, name + ".txt.unverified"), "w",
              encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(os.path.join(WORK_DIR, name + "_ocr.json"), "w", encoding="utf-8") as fh:
        json.dump({str(k): v for k, v in reads.items()}, fh, indent=1)

    kinds = Counter(f["properties"]["type"] for f in fc["features"])
    unsure = sum(1 for f in fc["features"] if (f["properties"] or {}).get("check"))
    print("%-14s %3d outlines -> %3d spaces (%s); %d unsure, %d duplicate, "
          "%d already drawn, %d kept from the tracer"
          % (name, len(rooms), len(fc["features"]),
             ", ".join("%s %d" % kv for kv in sorted(kinds.items())) or "none",
             unsure, dropped, lost, len(held)))
    return len(fc["features"])


def every_floor(empty_only):
    out = []
    for p in sorted(glob.glob(os.path.join(T.PDF_DIR, "*.pdf"))):
        name = os.path.splitext(os.path.basename(p))[0]
        if empty_only and hand_traced(name):
            continue
        out.append(name)
    return out


def fan_out(names, jobs, fresh, halls=False):
    """The same work in several processes, because this is hours one at a time."""
    procs, queue = [], list(names)
    while queue or procs:
        while queue and len(procs) < jobs:
            name = queue.pop(0)
            cmd = [sys.executable, os.path.abspath(__file__), name]
            if fresh:
                cmd.append("--fresh")
            if halls:
                cmd.append("--halls")
            procs.append((name, subprocess.Popen(cmd, cwd=T.REPO,
                                                 stdout=subprocess.PIPE,
                                                 stderr=subprocess.STDOUT)))
        time.sleep(0.2)          # the parent has nothing to do but wait
        for ent in list(procs):
            name, p = ent
            if p.poll() is None:
                continue
            procs.remove(ent)
            out = p.stdout.read().decode("utf-8", "replace").strip()
            print(out or "%-14s said nothing (exit %s)" % (name, p.returncode))
            sys.stdout.flush()
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("floors", nargs="*")
    ap.add_argument("--all", action="store_true",
                    help="every sheet there is; drawn spaces are kept as they are")
    ap.add_argument("--empty", action="store_true",
                    help="only the floors nobody has traced anything on")
    ap.add_argument("--fresh", action="store_true",
                    help="read the sheet again instead of using the cached outlines")
    ap.add_argument("--halls", action="store_true",
                    help="only work out the corridors, from the floor as written")
    ap.add_argument("--jobs", type=int, default=1,
                    help="read this many sheets at once, in separate processes")
    args = ap.parse_args()
    os.makedirs(WORK_DIR, exist_ok=True)
    names = list(args.floors)
    if args.all or args.empty:
        names += every_floor(args.empty)
    if not names:
        ap.error("name a floor, or pass --empty or --all")

    if args.jobs > 1 and len(names) > 1:
        return fan_out(names, args.jobs, args.fresh, args.halls)
    total = 0
    for name in names:
        try:
            got = add_halls(name) if args.halls else do_floor(name, args.fresh)
        except Exception as e:
            print("%-14s failed: %s: %s" % (name, type(e).__name__, e))
            continue
        total += got or 0
    print("%d %s written across %d sheet(s)"
          % (total, "corridor(s)" if args.halls else "space(s)", len(names)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
