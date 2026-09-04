"""
Automated room-to-building geocoding for BCIT Burnaby floor plans.

Replaces the old DXF + manual click-labeling + manual map-drag-calibration
workflow (newFloorPlan.py / labeling.py / calibrator.js) with a pipeline that:

  1. Renders each floor plan PDF (public/data/floorplans/{CODE}-Floor{N}.pdf)
     to a high-res raster and segments individual rooms by flood-filling the
     wall-enclosed regions (the PDFs are vector CAD exports, but room labels
     are flattened to vector curves rather than selectable text).
  2. OCRs each room's label with Tesseract, with a digit-only re-OCR fallback
     for characters CAD stencil fonts commonly confuse (1/l/|, 0/O, 6/G, 5/S),
     and classifies type (room / stairs / corridor) from the label text.
  3. Fits each floor's room layout to that building's real-world footprint
     polygon (public/data/bcit-coordinates.geojson, matched by BuildingName)
     via PCA-seeded ICP (rotation + translation, fixed scale from the
     footprint/plan bounding-box ratio) to geo-reference every room without
     manual map dragging.

Usage:
    py -3 floorPlans/auto_extract_rooms.py SW3 1
    py -3 floorPlans/auto_extract_rooms.py --all-burnaby --out public/data/floor-coordinates-auto

Output: one GeoJSON per floor (same schema as public/data/floor-coordinates/),
plus a JSON fit-quality report so poorly-fit buildings can be flagged for a
manual nudge via the existing Geometry Calibrator (views/calibrator.ejs)
instead of full manual re-labeling.
"""
import sys, os, re, json, math, glob, argparse, difflib
from collections import Counter
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree
import fitz
import numpy as np
from scipy import ndimage
import cv2
import pytesseract

TESSERACT_CANDIDATES = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Users\%s\AppData\Local\Programs\Tesseract-OCR\tesseract.exe" % os.environ.get("USERNAME", ""),
]
for _p in TESSERACT_CANDIDATES:
    if os.path.exists(_p):
        pytesseract.pytesseract.tesseract_cmd = _p
        break

R_EARTH = 6378137.0
ZOOM = 9
ROOM_RE = re.compile(r'^\d{2,5}$')
# Room-type words as they appear on BCIT plans. Matched fuzzily (see
# classify) because OCR of this stencil font garbles them badly -- a real
# stairwell label came back as "SSIAIR" and a shaft as "AHAFT", so exact
# substring matching silently lost every stairwell on the floor.
KEYWORDS = {
    "STAIR": "stairs", "ESCALATOR": "stairs", "ELEV": "elevator",
    "CORRIDOR": "corridor", "CORR": "corridor", "LOBBY": "corridor",
    "VESTIBULE": "corridor",
    "SHAFT": "shaft", "MECH": "mech", "ELEC": "elec", "JANITOR": "service",
    "WASH-RM": "washroom", "WASHRM": "washroom", "STOR-GEN": "storage",
    "STOR": "storage", "CLASS": "room", "OFFICE": "room", "LAB": "room",
}
# types that are navigation waypoints rather than destinations
NAV_TYPES = {"stairs", "elevator", "corridor"}

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Room segmentation + OCR
# ---------------------------------------------------------------------------

def mask_to_polygon(sub_mask, ox, oy, eps_frac=0.004):
    """Trace a room's true outline from its pixel mask.

    Earlier versions reduced each mask to a bounding box (cv2.minAreaRect /
    axis-aligned). That was the root cause of both major visual defects:
    rooms rendered as rotated "diamonds" that bore no resemblance to the
    real plan, and heavy room-to-room overlap -- boxes drawn around
    non-rectangular masks necessarily spill into their neighbours, even
    though the masks themselves are disjoint by construction.

    Tracing the contour instead preserves the actual room shape and keeps
    neighbouring rooms disjoint. Interior holes are captured too, so a
    U-shaped corridor doesn't swallow the rooms sitting in its notch.

    Returns (shell, holes) in page-pixel coords, or None.
    """
    contours, hier = cv2.findContours(sub_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hier is None:
        return None
    hier = hier[0]
    outer_i = max((i for i in range(len(contours)) if hier[i][3] == -1),
                  key=lambda i: cv2.contourArea(contours[i]), default=None)
    if outer_i is None:
        return None

    def simplify(c):
        peri = cv2.arcLength(c, True)
        ap = cv2.approxPolyDP(c, eps_frac * peri, True)
        return ap.reshape(-1, 2).astype(np.float64) + [ox, oy]

    shell = simplify(contours[outer_i])
    if len(shell) < 3:
        return None

    outer_area = cv2.contourArea(contours[outer_i])
    holes = []
    for i in range(len(contours)):
        if hier[i][3] == outer_i and cv2.contourArea(contours[i]) > 0.02 * outer_area:
            h = simplify(contours[i])
            if len(h) >= 3:
                holes.append(h)
    return shell, holes


def points_to_polygon(xs, ys, eps_frac=0.004):
    """Same as mask_to_polygon but from a scattered point set (used after a
    blob is split between several room labels)."""
    xs = np.asarray(xs); ys = np.asarray(ys)
    if len(xs) < 3:
        return None
    x0, y0 = int(xs.min()), int(ys.min())
    w = int(xs.max()) - x0 + 1
    h = int(ys.max()) - y0 + 1
    sub = np.zeros((h, w), np.uint8)
    sub[(ys - y0).astype(int), (xs - x0).astype(int)] = 1
    # close 1px gaps left by the split so the traced outline is continuous
    sub = cv2.morphologyEx(sub, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return mask_to_polygon(sub, x0, y0, eps_frac)


def extract_rooms(pdf_path, floor=None):
    doc = fitz.open(pdf_path)
    page = doc[0]
    mat = fitz.Matrix(ZOOM, ZOOM)
    pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY, alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)

    ink = arr < 200

    # The building's walls form one huge connected ink component; the BCIT
    # logo, compass rose, title block and legend are separate ink islands.
    # Requiring a candidate room to be enclosed by that main component keeps
    # letterforms and drawing furniture from being published as "rooms".
    ink_lbl, ink_n = ndimage.label(ink, structure=np.ones((3, 3), np.uint8))
    # Pick the building by the EXTENT of its ink, not the pixel count. On
    # floors whose walls aren't one connected run (NW4 floors 1/3/4) the
    # densest single component was the BCIT logo, and every room on the
    # sheet was then judged against the logo instead of the building.
    # A page border can out-span the building, so ignore near-page-sized
    # components.
    page_h, page_w = arr.shape
    page_area = page_h * page_w
    ink_sizes = ndimage.sum(np.ones_like(ink_lbl), ink_lbl, index=np.arange(1, ink_n + 1))

    # Pick the densest component, but only among those that actually span a
    # large part of the sheet. Density alone picked the BCIT logo on floors
    # whose walls aren't one connected run (NW4 1/3/4); span alone picked a
    # single long dimension line (SE6), which rejected nearly every room on
    # the sheet. Requiring both is what identifies the building.
    main_ink, best_px = None, -1.0
    for ci, sl in enumerate(ndimage.find_objects(ink_lbl), start=1):
        if sl is None:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if h * w > 0.85 * page_area:
            continue  # sheet border / title frame, not the building
        if w < 0.25 * page_w and h < 0.25 * page_h:
            continue  # a logo, a legend, a note -- too small to be the plan
        px = ink_sizes[ci - 1]
        if px > best_px:
            best_px, main_ink = px, ci
    if main_ink is None:
        main_ink = int(np.argmax(ink_sizes)) + 1
    main_mask = (ink_lbl == main_ink).astype(np.uint8)
    main_dil = cv2.dilate(main_mask, np.ones((5, 5), np.uint8), iterations=1).astype(bool)

    # The outer boundary of the wall structure IS the building outline, and
    # it is what the real-world footprint polygon depicts. Fitting outline
    # to outline is far steadier than fitting the convex hull of the room
    # shapes, which a canopy or an overhanging annotation can tilt.
    _oc, _ = cv2.findContours(main_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline_px = None
    if _oc:
        _c = max(_oc, key=cv2.contourArea)
        _ap = cv2.approxPolyDP(_c, 0.002 * cv2.arcLength(_c, True), True)
        outline_px = _ap.reshape(-1, 2).astype(np.float64)

    bg = ~ink
    structure = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]])
    labels, n = ndimage.label(bg, structure=structure)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1))

    page_px_area = arr.shape[0] * arr.shape[1]
    min_frac, max_frac = 0.00005, 0.05

    candidates = []
    for lbl in range(1, n + 1):
        area = sizes[lbl - 1]
        if area < min_frac * page_px_area or area > max_frac * page_px_area:
            continue
        ys, xs = np.where(labels == lbl)
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        if y0 <= 1 or x0 <= 1 or y1 >= arr.shape[0] - 2 or x1 >= arr.shape[1] - 2:
            continue
        sub = (labels[y0:y1 + 1, x0:x1 + 1] == lbl).astype(np.uint8)
        border = (cv2.dilate(sub, np.ones((5, 5), np.uint8), iterations=1) - sub).astype(bool)
        if border.sum() == 0:
            continue
        if main_dil[y0:y1 + 1, x0:x1 + 1][border].mean() < 0.5:
            continue  # enclosed by logo/legend ink, not by the building
        candidates.append((lbl, area, x0, y0, x1, y1))

    # ------------------------------------------------------------------
    # Label reading (global pass).
    #
    # Labels drive detection, not blobs. Scanning per-blob missed anything
    # whose enclosing white area never forms a room-sized region -- most
    # importantly STAIRS, which in construction drawings are drawn as a run
    # of tread lines, so the white space between treads is a set of thin
    # strips rather than one room. Those are essential for navigation, so
    # labels are found across the whole sheet first and geometry attached
    # afterwards where a blob exists.
    #
    # Do NOT use a digits-only whitelist: in this thin hand-drafted CAD
    # stencil font "0" reads as "O", "1" as "|", "5" as "S", and a digit
    # whitelist makes Tesseract silently DROP those glyphs (a real bug:
    # room "104" came back as "14"). Read free-form, then map look-alikes.
    # ------------------------------------------------------------------
    GLYPH_TO_DIGIT = str.maketrans({
        'O': '0', 'o': '0', 'D': '0', 'Q': '0', 'U': '0', 'C': '0', 'c': '0',
        'I': '1', 'l': '1', '|': '1', 'L': '1', 'T': '1', 'J': '1', 'i': '1',
        'Z': '2', 'z': '2', 'S': '5', 's': '5', 'G': '6', 'b': '6', 'e': '6',
        'B': '8', 'g': '9', 'q': '9', 'A': '4',
    })

    def ocr_line(gy0, gy1, gx0, gx1):
        crop = arr[gy0:gy1, gx0:gx1]
        if crop.size == 0:
            return ""
        f = max(2, int(90 / max(crop.shape[0], 1)))
        big = cv2.resize(crop, (crop.shape[1] * f, crop.shape[0] * f), interpolation=cv2.INTER_CUBIC)
        _, bb = cv2.threshold(big, 180, 255, cv2.THRESH_BINARY)
        bb = cv2.copyMakeBorder(bb, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
        return pytesseract.image_to_string(bb, config="--psm 7").strip()

    # only consider annotation inside the building envelope -- keeps the BCIT
    # logo, title block, compass rose and legend out of the room list
    main_pts = np.column_stack(np.where(ink_lbl == main_ink))[:, ::-1]
    hull = cv2.convexHull(main_pts.astype(np.int32))

    label_ink = ink & ~main_dil
    lab_lbl, lab_n = ndimage.label(label_ink, structure=np.ones((3, 3), np.uint8))
    objs = ndimage.find_objects(lab_lbl)
    comps = []
    for ci, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        cy0, cy1 = sl[0].start, sl[0].stop - 1
        cx0, cx1 = sl[1].start, sl[1].stop - 1
        h, w = cy1 - cy0 + 1, cx1 - cx0 + 1
        if h < 6 or h > 120 or w > 240:
            continue  # too small for a glyph, or a furniture/fixture symbol
        ccx, ccy = (cx0 + cx1) / 2.0, (cy0 + cy1) / 2.0
        if cv2.pointPolygonTest(hull, (float(ccx), float(ccy)), False) < 0:
            continue
        comps.append([cy0, cy1, cx0, cx1, h])

    blocks = []
    if comps:
        hmed = float(np.median([c[4] for c in comps]))
        gx, gy = hmed * 2.2, hmed * 1.8
        # bucket by row band so clustering stays near-linear on big sheets
        for c in sorted(comps, key=lambda c: (c[0], c[2])):
            placed = False
            for B in reversed(blocks[-60:]):
                if (c[2] <= B["x1"] + gx and c[3] >= B["x0"] - gx and
                        c[0] <= B["y1"] + gy and c[1] >= B["y0"] - gy):
                    B["items"].append(c)
                    B["x0"] = min(B["x0"], c[2]); B["x1"] = max(B["x1"], c[3])
                    B["y0"] = min(B["y0"], c[0]); B["y1"] = max(B["y1"], c[1])
                    placed = True
                    break
            if not placed:
                blocks.append({"items": [c], "x0": c[2], "x1": c[3], "y0": c[0], "y1": c[1]})

    parsed = []
    for B in blocks:
        rows = []
        for c in sorted(B["items"], key=lambda c: c[0]):
            for R in rows:
                if abs(c[0] - R[0][0]) < c[4] * 1.0:
                    R.append(c)
                    break
            else:
                rows.append([c])

        number, raw_parts = None, []
        for R in rows[:3]:
            ry0 = min(c[0] for c in R); ry1 = max(c[1] for c in R)
            rx0 = min(c[2] for c in R); rx1 = max(c[3] for c in R)
            th = ry1 - ry0 + 1
            padx = int(th * 1.5)  # small rooms: the label overflows the room
            txt = ocr_line(max(0, ry0 - 6), min(arr.shape[0], ry1 + 7),
                           max(0, rx0 - padx), min(arr.shape[1], rx1 + padx + 1))
            if not txt:
                continue
            raw_parts.append(txt)
            if number is None:
                digits = re.sub(r'[^0-9]', '', txt.translate(GLYPH_TO_DIGIT))
                if ROOM_RE.match(digits):
                    number = digits
        if not number and not raw_parts:
            continue
        parsed.append({
            "number": number,
            "raw": " ".join(raw_parts).upper(),
            "cx": (B["x0"] + B["x1"]) / 2.0,
            "cy": (B["y0"] + B["y1"]) / 2.0,
        })

    # Mapping look-alike letters to digits can over-produce: "1O9D CLASS" is
    # room 109, but D->0 makes it "1090". Room numbers on a floor share a
    # length, so take that as the truth and keep the leading digits of any
    # over-long read (109 from 1090, 111 from L116's "1116").
    num_lens = [len(p["number"]) for p in parsed if p["number"]]
    if num_lens:
        expected_digits = Counter(num_lens).most_common(1)[0][0]
        for p in parsed:
            if not p["number"]:
                continue
            if len(p["number"]) > expected_digits:
                p["number"] = p["number"][:expected_digits]
            elif len(p["number"]) < expected_digits:
                # short reads are clipped glyphs ("12" out of "112"), not
                # real rooms -- keep the label's text/position, drop the number
                p["number"] = None

    def classify(text):
        """Room type from the label's type line, matched fuzzily.

        OCR mangles these words badly in this stencil font ("STAIR" ->
        "SSIAIR", "SHAFT" -> "AHAFT"), so exact substring matching drops
        them -- which silently lost every stairwell, the one feature a
        router most needs for changing floors."""
        for k, v in KEYWORDS.items():
            if k in text:
                return v
        # fall back to fuzzy comparison against each alphabetic token
        for tok in re.findall(r'[A-Z][A-Z\-]{2,}', text):
            for k, v in KEYWORDS.items():
                if difflib.SequenceMatcher(None, tok, k).ratio() >= 0.7:
                    return v
        return "room"

    def normalize_number(t, kw):
        # stencil "S" reads as "5", so stairwell tags arrive as 5100/5120
        if kw == "stairs" and re.match(r'^5\d{2,3}$', t):
            return "S" + t[1:]
        return t

    # attach each label to the room blob it sits in
    cand_by_lbl = {c[0]: c for c in candidates}
    blocks_for = {}
    unattached = []
    def nearest_blob(ix, iy, reach=60):
        """Blob nearest a label whose own pixel isn't inside one.

        A label often sits on top of a wall, a tread line or a piece of
        furniture, so the pixel under it belongs to no room. Snapping to
        the closest room within a short reach keeps the label attached --
        which matters beyond the label itself: an unattached label became
        a placeholder square, and with the theatre's "1800 LECTURE" label
        floating free none of its seating rows had a labelled room to
        merge into, so the hall stayed a comb of strips.
        """
        y0 = max(0, iy - reach); y1 = min(labels.shape[0], iy + reach + 1)
        x0 = max(0, ix - reach); x1 = min(labels.shape[1], ix + reach + 1)
        win = labels[y0:y1, x0:x1]
        best, best_d = None, None
        for bid in np.unique(win):
            bid = int(bid)
            if not bid or bid not in cand_by_lbl:
                continue
            ys, xs = np.where(win == bid)
            d = ((xs + x0 - ix) ** 2 + (ys + y0 - iy) ** 2).min()
            if best_d is None or d < best_d:
                best, best_d = bid, d
        return best

    for p in parsed:
        ix, iy = int(round(p["cx"])), int(round(p["cy"]))
        blob = labels[iy, ix] if (0 <= iy < labels.shape[0] and 0 <= ix < labels.shape[1]) else 0
        if not (blob and blob in cand_by_lbl):
            blob = nearest_blob(ix, iy) or 0
        if blob and blob in cand_by_lbl:
            blocks_for.setdefault(blob, []).append(p)
        elif p["number"] or classify(p["raw"]) != "room":
            unattached.append(p)

    # ------------------------------------------------------------------
    # Absorb unlabelled regions into the room they belong to.
    #
    # A lecture theatre is drawn as a fan of tiered seating rows separated
    # by single tread lines, so segmentation returns one strip per row
    # rather than one room -- and only the strip containing "1800 LECTURE"
    # carries the label. Same story for stepped floors and platforms.
    # (Bridging the tread lines morphologically is not an option: the
    # lines are the same weight as partition walls, so any kernel wide
    # enough to merge seating rows also merges real rooms -- measured on
    # SE6, 94 rooms collapse to 28.)
    #
    # Instead, walk out from each unlabelled region through its unlabelled
    # neighbours. If that whole group touches exactly ONE labelled room,
    # it is part of that room, so merge it in. A corridor touches many
    # labelled rooms, so it is left alone.
    # ------------------------------------------------------------------
    def blob_neighbours(lbl, x0, y0, x1, y1, reach=7):
        pad = reach + 1
        sy0, sy1 = max(0, y0 - pad), min(labels.shape[0], y1 + pad + 1)
        sx0, sx1 = max(0, x0 - pad), min(labels.shape[1], x1 + pad + 1)
        win = labels[sy0:sy1, sx0:sx1]
        self_mask = (win == lbl).astype(np.uint8)
        ring = cv2.dilate(self_mask, np.ones((2 * reach + 1, 2 * reach + 1), np.uint8)) - self_mask
        ids = np.unique(win[ring.astype(bool)])
        return {int(i) for i in ids if i and int(i) != lbl and int(i) in cand_by_lbl}

    labelled_blobs = {lbl for lbl, blks in blocks_for.items()
                      if any(b["number"] for b in blks)}
    adj = {}
    for lbl, area, x0, y0, x1, y1 in candidates:
        adj[lbl] = blob_neighbours(lbl, x0, y0, x1, y1)

    absorbed_by = {}          # unlabelled blob -> owning labelled blob
    merged_into = {}          # labelled blob -> [unlabelled blobs]
    seen_group = set()
    for lbl in adj:
        if lbl in labelled_blobs or lbl in seen_group:
            continue
        # flood through unlabelled blobs, collecting labelled ones touched
        group, touching, stack = set(), set(), [lbl]
        while stack:
            cur = stack.pop()
            if cur in group:
                continue
            group.add(cur)
            for nb in adj.get(cur, ()):
                if nb in labelled_blobs:
                    touching.add(nb)
                elif nb not in group:
                    stack.append(nb)
        seen_group |= group
        if not touching:
            continue
        if len(touching) == 1:
            owner = next(iter(touching))
            for g in group:
                absorbed_by[g] = owner
            merged_into.setdefault(owner, []).extend(group)
        else:
            # The group reaches several labelled rooms -- a theatre's seating
            # rows run the width of the hall and touch every space along it.
            # Give each region to the labelled room it sits closest to, so a
            # tiered hall reassembles instead of staying a comb of strips.
            def ctr(i):
                _l, _a, bx0, by0, bx1, by1 = cand_by_lbl[i]
                return ((bx0 + bx1) / 2.0, (by0 + by1) / 2.0)
            for g in group:
                gx, gy = ctr(g)
                owner = min(touching, key=lambda t: (ctr(t)[0] - gx) ** 2
                                                    + (ctr(t)[1] - gy) ** 2)
                absorbed_by[g] = owner
                merged_into.setdefault(owner, []).append(g)

    def blob_union_mask(lbl, extra):
        """Mask + bbox covering a room and the regions absorbed into it."""
        ids = [lbl] + list(extra)
        boxes = [cand_by_lbl[i] for i in ids if i in cand_by_lbl]
        x0 = min(b[2] for b in boxes); y0 = min(b[3] for b in boxes)
        x1 = max(b[4] for b in boxes); y1 = max(b[5] for b in boxes)
        win = labels[y0:y1 + 1, x0:x1 + 1]
        m = np.isin(win, ids)
        # close the tread lines that separated the strips so the merged
        # region traces as one outline instead of a comb
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE,
                             np.ones((9, 9), np.uint8)).astype(bool)
        return m, x0, y0

    median_area = float(np.median([a for _, a, *_ in candidates])) if candidates else 0.0

    rooms = []
    for lbl, area, x0, y0, x1, y1 in candidates:
        if lbl in absorbed_by:
            continue  # emitted as part of the room that absorbed it
        if lbl in merged_into:
            mask_local, x0, y0 = blob_union_mask(lbl, merged_into[lbl])
            area = float(mask_local.sum())
        else:
            mask_local = (labels[y0:y1 + 1, x0:x1 + 1] == lbl)
        blks = blocks_for.get(lbl, [])
        full_text = " ".join(b["raw"] for b in blks).upper()
        numbered = [b for b in blks if b["number"]]

        if not numbered:
            kw = next((v for k, v in KEYWORDS.items() if k in full_text), None)
            if not kw:
                if area < 3 * min_frac * page_px_area:
                    continue
                kw = "unlabeled"
            poly = mask_to_polygon(mask_local.astype(np.uint8), x0, y0)
            if poly is None:
                continue
            rooms.append({"room": None, "type": kw, "raw_text": full_text,
                          "shell": poly[0], "holes": poly[1]})
            continue

        if len(numbered) == 1:
            b = numbered[0]
            kw = classify(b["raw"])
            t = normalize_number(b["number"], kw)
            poly = mask_to_polygon(mask_local.astype(np.uint8), x0, y0)
            if poly is None:
                continue
            rooms.append({"room": t, "type": kw, "raw_text": b["raw"],
                          "shell": poly[0], "holes": poly[1], "anchor": True})
        elif len(numbered) <= 12 and (median_area <= 0 or area <= median_area * 25):
            # Several rooms sharing one blob, because the wall or door
            # threshold between them wasn't captured. Split the pixels by
            # nearest label block. This gate used to be far tighter (<=4
            # labels) because shapes were then bounding boxes, and a box
            # drawn round a Voronoi wedge came out as a rotated diamond
            # overlapping its neighbours. Now that shapes are traced
            # contours the partitions tile the blob cleanly, so splitting
            # is preferable to dropping the geometry and placing markers.
            ys, xs = np.where(mask_local)
            pts = np.stack([xs, ys], axis=1).astype(np.float32)
            seeds = np.array([[b["cx"] - x0, b["cy"] - y0] for b in numbered], dtype=np.float32)
            assign = ((pts[:, None, :] - seeds[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
            for i, b in enumerate(numbered):
                sel = pts[assign == i]
                if len(sel) < 20:
                    continue
                kw = classify(b["raw"])
                t = normalize_number(b["number"], kw)
                poly = points_to_polygon(sel[:, 0] + x0, sel[:, 1] + y0)
                if poly is None:
                    continue
                rooms.append({"room": t, "type": kw, "raw_text": b["raw"],
                              "shell": poly[0], "holes": poly[1], "anchor": False})
        else:
            # Many labels in one big blob: the walls between them were never
            # captured. Splitting would invent shapes from pixels we cannot
            # attribute, so emit a small placeholder at each label instead --
            # findable and roughly located, without fabricating a footprint.
            half = math.sqrt(area / len(numbered)) * 0.4
            for b in numbered:
                kw = classify(b["raw"])
                t = normalize_number(b["number"], kw)
                box = np.array([[b["cx"] - half, b["cy"] - half], [b["cx"] + half, b["cy"] - half],
                                [b["cx"] + half, b["cy"] + half], [b["cx"] - half, b["cy"] + half]],
                               dtype=np.float64)
                rooms.append({"room": t, "type": kw, "raw_text": b["raw"],
                              "shell": box, "holes": [], "anchor": False,
                              "approx_location_only": True})

    # Labels with no room blob of their own -- stairs above all, whose treads
    # break the white space into strips too thin to segment. They matter for
    # navigation (they're how a route changes floor), so emit a small node at
    # the label position rather than losing them.
    half = math.sqrt(median_area) * 0.35 if median_area else 20.0
    for p in unattached:
        kw = classify(p["raw"])
        if kw == "room" and not p["number"]:
            continue
        t = normalize_number(p["number"], kw) if p["number"] else None
        if kw == "stairs" and not t:
            t = None
        box = np.array([[p["cx"] - half, p["cy"] - half], [p["cx"] + half, p["cy"] - half],
                        [p["cx"] + half, p["cy"] + half], [p["cx"] - half, p["cy"] + half]],
                       dtype=np.float64)
        rooms.append({"room": t, "type": kw, "raw_text": p["raw"],
                      "shell": box, "holes": [], "anchor": False,
                      "approx_location_only": True})

    # BCIT numbers rooms by floor: floor 1 is 1xx/1xxx, floor 2 is 2xxx, and
    # so on (verified against the hand-calibrated SW3 files). Anything whose
    # leading digit disagrees with the floor it was found on is an OCR
    # misread, not a room -- SE6 floor 1 was producing "411" and "441".
    # Stairs/elevators keep their geometry but not their number: their label
    # lines OCR far worse than room labels (a stairwell tag came back as
    # "[SP F SSIAIR"), which produced junk numbers like "514" -- and those
    # then tripped the floor-digit rule below and deleted the stairwell
    # entirely. They're waypoints, not destinations, so they're matched
    # across floors by position instead of by label.
    for r in rooms:
        if r["type"] in ("stairs", "elevator"):
            r["room"] = None

    if floor and str(floor).isdigit():
        fd = str(floor)[0]
        # applies to every numbered space: stairs/elevators already carry
        # room=None so the rule cannot affect them, and a numbered room whose
        # leading digit disagrees with its floor is an OCR misread whatever
        # its type says (floor 3 was publishing a room "100").
        rooms = [r for r in rooms
                 if not (r["room"] and r["room"][0].isdigit() and r["room"][0] != fd)]

    # BCIT room-number digit count varies by building (SW3 uses 4 digits,
    # SE6 uses 3), so it can't be hardcoded -- instead infer it per floor from
    # "anchor" detections (blobs with exactly one unambiguous digit token, so
    # there was no competing fragment to confuse the reading) and only trust
    # other digit tokens of that same length. This rejects the short fragments
    # (dropped-leading-digit OCR noise, e.g. "1650" misread as "650"/"165")
    # that a plain 2-5-digit regex would otherwise let through as fake rooms.
    anchor_lens = [len(r["room"]) for r in rooms if r.get("anchor") and r["room"]]
    expected_len = max(set(anchor_lens), key=anchor_lens.count) if anchor_lens else None

    # a floor's real room numbers almost always share a small set of leading-2-digit
    # "century" prefixes (e.g. SW3-F1 is entirely 16xx/17xx/19xx). A prefix that
    # shows up only once among anchor (unambiguous) detections is more likely a
    # multi-digit OCR misread than a genuine one-off room -> demote, don't drop,
    # so it still surfaces for manual review instead of polluting search silently.
    anchor_prefixes = [r["room"][:2] for r in rooms if r.get("anchor") and r["room"] and re.match(r'^\d+$', r["room"])]
    prefix_counts = Counter(anchor_prefixes)
    common_prefixes = {p for p, c in prefix_counts.items() if c >= 2} or set(prefix_counts)

    kept = []
    for r in rooms:
        t = r["room"]
        if t is None:
            r["confidence"] = "low"
            kept.append(r)
        elif re.match(r'^S\d{3}$', t):
            r["confidence"] = "medium"
            kept.append(r)
        elif re.match(r'^\d{2,5}$', t) and (expected_len is None or len(t) == expected_len):
            r["confidence"] = "high" if (not common_prefixes or t[:2] in common_prefixes) else "medium"
            kept.append(r)
        # else: digit-length doesn't match this floor's own numbering scheme --
        # almost certainly an OCR fragment of a neighbouring label -> drop

    by_room = {}
    for r in kept:
        key = r["room"] if r["room"] else f"__{r['type']}_{len(by_room)}"
        by_room.setdefault(key, []).append(r)

    final = []
    for key, group in by_room.items():
        if len(group) == 1:
            final.append(group[0])
        else:
            # Same number OCR'd in several blobs: keep the largest rather than
            # merging, since merging would span the gap between them and
            # produce a shape covering rooms in between.
            final.append(max(group, key=lambda g: abs(cv2.contourArea(
                g["shell"].astype(np.float32)))))

    return remove_overlapping_rooms(final), ZOOM, outline_px


def remove_overlapping_rooms(rooms):
    """Real floor plans don't have overlapping rooms, so overlap is always a
    segmentation artifact, not a legitimate result -- drop it rather than
    publish it. Two distinct failure modes end up here:
      - a small unlabeled blob (furniture/fixture noise kept so no real room
        goes missing silently) that's actually just sitting inside a real,
        already-labelled room's polygon -> drop the unlabeled one.
      - a labelled room whose underlying blob merged with unrelated
        neighbours (because OCR only recognised ONE of several labels inside
        a too-large, under-segmented blob, so nothing flagged it as a
        multi-room merge at extraction time) -> its polygon ends up far
        bigger than a normal room and swallows several real ones. Detected
        after the fact by size vs. the floor's own median room, and dropped
        (better to have a labelled room briefly missing than confidently
        wrong and overlapping its neighbours)."""
    if len(rooms) < 2:
        return rooms

    polys = []
    valid_idx = []
    for i, r in enumerate(rooms):
        try:
            poly = Polygon(r["shell"], r.get("holes") or [])
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area <= 0:
                continue
        except Exception:
            continue
        polys.append(poly)
        valid_idx.append(i)

    if len(polys) < 2:
        return rooms

    tree = STRtree(polys)
    overlaps = {i: [] for i in range(len(polys))}  # local idx -> [(other_local_idx, frac)]
    seen = set()
    for a, poly_a in enumerate(polys):
        for b in tree.query(poly_a):
            b = int(b)
            if b == a or (min(a, b), max(a, b)) in seen:
                continue
            seen.add((min(a, b), max(a, b)))
            poly_b = polys[b]
            if not poly_a.intersects(poly_b):
                continue
            inter = poly_a.intersection(poly_b).area
            smaller = min(poly_a.area, poly_b.area)
            frac = inter / smaller if smaller > 0 else 0
            if frac < 0.3:
                continue
            overlaps[a].append((b, frac))
            overlaps[b].append((a, frac))

    labelled_areas = [polys[li].area for li, i in enumerate(valid_idx) if rooms[i]["room"]]
    median_area = float(np.median(labelled_areas)) if labelled_areas else 0.0

    drop = set()
    for li, i in enumerate(valid_idx):
        if not overlaps[li]:
            continue
        r = rooms[i]
        if not r["room"]:
            drop.add(i)  # unlabeled fragment overlapping something real
            continue
        labelled_conflicts = sum(1 for ob, _ in overlaps[li] if rooms[valid_idx[ob]]["room"])
        if median_area and polys[li].area > 3 * median_area and labelled_conflicts >= 2:
            drop.add(i)  # oversized merged-blob room swallowing real neighbours

    kept = [r for i, r in enumerate(rooms) if i not in drop]
    return clip_overlapping_rooms(kept)


def clip_overlapping_rooms(rooms, min_frac=0.02, keep_area_frac=0.5):
    """Trim what still overlaps, instead of deleting a room to fix it.

    Dropping is the right answer for a fragment that is pure noise, but a
    wrong answer for two real rooms whose blobs bled into each other: one of
    them is roughly correct and the other has over-grown across a wall it
    should have stopped at. Deleting either loses a room that exists.

    Since no two rooms can occupy the same floor space, the overlap belongs
    to exactly one of them -- and the one that grew is the larger. Subtract
    the smaller from the larger and both survive with the boundary put back
    where the wall is. A subtraction that would shred the larger room (or
    split it in two) is refused and the overlap left alone: a visible
    overlap beats a room reduced to a sliver.
    """
    if len(rooms) < 2:
        return rooms

    polys, idx = [], []
    for i, r in enumerate(rooms):
        try:
            poly = Polygon(r["shell"], r.get("holes") or [])
            if not poly.is_valid:
                # repairing a self-intersecting trace can split it in two;
                # the room is the biggest piece, and the rest is the noise
                # that made it invalid
                poly = poly.buffer(0)
                if poly.geom_type == "MultiPolygon":
                    poly = max(poly.geoms, key=lambda g: g.area)
            if poly.is_empty or poly.area <= 0 or poly.geom_type != "Polygon":
                continue
        except Exception:
            continue
        polys.append(poly)
        idx.append(i)

    if len(polys) < 2:
        return rooms

    # largest first: an over-grown room is clipped by every smaller room it
    # swallowed, rather than each pair being resolved in arbitrary order
    order = sorted(range(len(polys)), key=lambda k: -polys[k].area)
    tree = STRtree(polys)

    for a in order:
        for b in tree.query(polys[a]):
            b = int(b)
            if b == a:
                continue
            poly_a, poly_b = polys[a], polys[b]
            if poly_b.area >= poly_a.area or not poly_a.intersects(poly_b):
                continue
            inter = poly_a.intersection(poly_b).area
            if inter <= 0 or inter / poly_b.area < min_frac:
                continue
            try:
                trimmed = poly_a.difference(poly_b)
            except Exception:
                continue
            if trimmed.geom_type == "MultiPolygon":
                continue  # clipping would break the room into pieces
            if trimmed.is_empty or trimmed.area < keep_area_frac * poly_a.area:
                continue
            polys[a] = trimmed

    for k, i in enumerate(idx):
        poly = polys[k]
        if poly.is_empty or poly.geom_type != "Polygon":
            continue
        rooms[i]["shell"] = np.array(poly.exterior.coords[:-1], dtype=np.float64)
        holes = [np.array(r.coords[:-1], dtype=np.float64) for r in poly.interiors]
        rooms[i]["holes"] = holes or None
    return rooms


# ---------------------------------------------------------------------------
# Geo-referencing: fit plan-local coords to the real building footprint
# ---------------------------------------------------------------------------

def load_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def lonlat_to_local(lon, lat, lon0, lat0):
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * R_EARTH
    y = math.radians(lat - lat0) * R_EARTH
    return x, y


def local_to_lonlat(x, y, lon0, lat0):
    lon = lon0 + math.degrees(x / (R_EARTH * math.cos(math.radians(lat0))))
    lat = lat0 + math.degrees(y / R_EARTH)
    return lon, lat


def find_footprints(building_code, buildings_index, coords_geojson):
    """Footprint rings for a building, matched strictly by BuildingName.

    There used to be a nearest-centroid fallback here. It was actively
    harmful: a building with no footprint got fitted to an adjacent one and
    its rooms were published inside it -- NE4's rooms rendered on top of
    NE2. Better to report no footprint and place the plan from its own
    drawing scale instead.

    Ten campus buildings (NE3, NE4, NE20, NW3 and the SW10-SW15 row) are
    stored as MultiPolygon rather than Polygon -- a main mass plus an
    annex. Reading Polygon only made those look footprint-free, so exactly
    the buildings with the most distinctive outlines were the ones placed
    approximately. Every part is taken, since the fit wants the whole
    outline.
    """
    named = []
    for feat in coords_geojson["features"]:
        if (feat["properties"].get("BuildingName") or "").strip() != building_code:
            continue
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            named.append(geom["coordinates"][0])
        elif geom["type"] == "MultiPolygon":
            for part in geom["coordinates"]:
                named.append(part[0])

    if not named:
        return [], "none", (None, None)

    pts = [q for ring in named for q in ring]
    entry = buildings_index.get(building_code)
    if entry:
        lon0, lat0 = entry["center"]
    else:
        lon0 = sum(q[0] for q in pts) / len(pts)
        lat0 = sum(q[1] for q in pts) / len(pts)
    return named, "name", (lon0, lat0)


# PDF points are 1/72 inch, so a plan plotted at 1:N has this many metres
# per point. Checked against SW3 (title block says 1:500): predicted
# 0.1764 m/pt vs 0.1747 fitted from its footprint, ~1% apart.
PT_TO_M = 0.0254 / 72.0
# Floor plans are plotted somewhere in this range; 1:1000+ is site-plan
# territory, and allowing it made a greedy 4-digit OCR match read "1200"
# (i.e. 1:200) as 1:2000 and reject the building as implausibly large.
PLAUSIBLE_SCALES = (50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600)


def read_plan_scale(pdf_path):
    """Candidate drawing-scale ratios from the title block, best first.

    OCR of the title block is noisy: the colon is lost or misread, so
    "1:200" arrives as "1200" and "1:300" as "17300", and the digits often
    run on into neighbouring text. Both readings of an ambiguous run are
    returned ("1500" -> 500 and 50) and the caller picks whichever implies
    a building of believable size -- that physical check disambiguates far
    more reliably than the text ever can.
    """
    try:
        doc = fitz.open(pdf_path)
        page = doc[0]
        pix = page.get_pixmap(matrix=fitz.Matrix(4, 4), colorspace=fitz.csGRAY, alpha=False)
        a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
        h, w = a.shape
        strip = a[int(h * 0.84):h, 0:int(w * 0.7)]
        big = cv2.resize(strip, (strip.shape[1] * 2, strip.shape[0] * 2), interpolation=cv2.INTER_CUBIC)
        _, b = cv2.threshold(big, 180, 255, cv2.THRESH_BINARY)
        txt = pytesseract.image_to_string(b, config="--psm 6").upper()
    except Exception:
        return []

    m = re.search(r'SCALE(.{0,18})', txt, re.S)
    tail = (m.group(1) if m else txt)
    tail = tail.replace('O', '0').replace('L', '1').replace('I', '1')
    digits = re.sub(r'[^0-9]', '', tail)
    if not digits:
        return []

    out = []
    runs = [digits[1:]] if digits.startswith('1') else []
    runs.append(digits)
    for run in runs:
        for n in (3, 2):
            for i in range(0, max(1, len(run) - n + 1)):
                v = int(run[i:i + n] or 0)
                if v in PLAUSIBLE_SCALES and v not in out:
                    out.append(v)
    return out


def dominant_angle(pts, closed=True):
    """Orientation of the longest-running edge direction, folded to 0-90 deg.

    Buildings are rectilinear, so this recovers the grid the plan (or the
    footprint) is drawn on.
    """
    pts = np.asarray(pts, dtype=np.float64)
    if len(pts) < 3:
        return 0.0
    seq = np.vstack([pts, pts[0]]) if closed else pts
    v = np.diff(seq, axis=0)
    lens = np.hypot(v[:, 0], v[:, 1])
    ang = (np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 90.0)
    bins = np.zeros(90)
    for a_, l_ in zip(ang, lens):
        bins[int(a_) % 90] += l_
    return float(np.argmax(bins))


def campus_grid_angle(coords_geojson, lat0):
    """The angle the campus itself is laid out on, from all named footprints."""
    bins = np.zeros(90)
    for feat in coords_geojson["features"]:
        if feat["geometry"]["type"] != "Polygon":
            continue
        if not (feat["properties"].get("BuildingName") or "").strip():
            continue
        ring = feat["geometry"]["coordinates"][0]
        loc = np.array([lonlat_to_local(x, y, ring[0][0], lat0) for x, y in ring])
        v = np.diff(np.vstack([loc, loc[0]]), axis=0)
        lens = np.hypot(v[:, 0], v[:, 1])
        ang = (np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 90.0)
        for a_, l_ in zip(ang, lens):
            bins[int(a_) % 90] += l_
    return float(np.argmax(bins))


def umeyama(src, dst):
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    s0, d0 = src - mu_s, dst - mu_d
    H = s0.T @ d0
    U, S, Vt = np.linalg.svd(H)
    D = np.eye(2)
    if np.linalg.det(Vt.T @ U.T) < 0:
        D[1, 1] = -1
    R = Vt.T @ D @ U.T
    var_src = (s0 ** 2).sum() / len(src)
    scale = np.trace(np.diag(S) @ D) / (len(src) * var_src)
    t = mu_d - scale * (R @ mu_s)
    return R, scale, t


def apply_sim(R, s, t, pts):
    pts = np.asarray(pts, dtype=np.float64)
    return (s * (R @ pts.T).T) + t


def pca_angle(pts):
    pts = np.asarray(pts, dtype=np.float64)
    c = pts - pts.mean(axis=0)
    cov = c.T @ c
    evals, evecs = np.linalg.eigh(cov)
    major = evecs[:, np.argmax(evals)]
    return math.atan2(major[1], major[0])


def icp_fit(src_pts, dst_pts, R0, s0, t0, iters=12, fix_scale=True):
    R, s, t = R0, s0, t0
    for _ in range(iters):
        transformed = apply_sim(R, s, t, src_pts)
        d = ((transformed[:, None, :] - dst_pts[None, :, :]) ** 2).sum(axis=2)
        nn = d.argmin(axis=1)
        targets = dst_pts[nn]
        if fix_scale:
            mu_s, mu_d = src_pts.mean(axis=0), targets.mean(axis=0)
            s0_, d0_ = src_pts - mu_s, targets - mu_d
            H = s0_.T @ d0_
            U, S, Vt = np.linalg.svd(H)
            D = np.eye(2)
            if np.linalg.det(Vt.T @ U.T) < 0:
                D[1, 1] = -1
            R = Vt.T @ D @ U.T
            t = mu_d - s0 * (R @ mu_s)
            s = s0
        else:
            R, s, t = umeyama(src_pts, targets)
    transformed = apply_sim(R, s, t, src_pts)
    d = ((transformed[:, None, :] - dst_pts[None, :, :]) ** 2).sum(axis=2)
    resid = np.sqrt(d.min(axis=1)).mean()
    return resid, R, s, t


def convex_hull_pts(pts):
    hull = cv2.convexHull(pts.astype(np.float32))
    return hull.reshape(-1, 2).astype(np.float64)


def fit_plan_to_footprint(plan_pts_local, footprint_pts,
                          plan_rooms=None, footprint_rings_local=None):
    # Matching every interior room corner to its nearest point on the
    # footprint BOUNDARY is an ill-posed ICP problem -- interior points have
    # no real boundary correspondence at all, so the optimizer is free to
    # satisfy it however it likes, and on real building shapes it regularly
    # locks onto a false ~45deg-rotated minimum with a *lower* residual than
    # the true fit (seen on SW1: rooms rendered as a field of diamonds
    # inside a plain rectangular building, from every seed angle tried).
    # Reducing both point sets to their convex hulls turns this into the
    # well-posed version of the problem -- outline matched to outline --
    # which is what ICP is actually meant to solve.
    plan_hull = convex_hull_pts(plan_pts_local)
    footprint_hull = convex_hull_pts(footprint_pts)

    ang_plan = pca_angle(plan_hull)
    ang_fp = pca_angle(footprint_hull)

    def bbox_diag(p):
        return math.hypot(p[:, 0].max() - p[:, 0].min(), p[:, 1].max() - p[:, 1].min())

    s_guess = bbox_diag(footprint_hull) / bbox_diag(plan_hull)
    mu_s = plan_hull.mean(axis=0)
    mu_d = footprint_hull.mean(axis=0)

    candidates = []
    for k in range(24):
        theta = (ang_fp - ang_plan) + k * (2 * math.pi / 24)
        R0 = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
        t0 = mu_d - s_guess * (R0 @ mu_s)
        candidates.append(icp_fit(plan_hull, footprint_hull, R0, s_guess, t0))
    candidates.sort(key=lambda c: c[0])

    # Hull residual alone cannot tell a correct fit from one turned 180deg
    # (or, on a near-square building, 90deg): a convex hull is symmetric in
    # a way the building is not, so both orientations score the same
    # distance-to-hull and which one wins is arbitrary. That is exactly what
    # "rotated wrongly" looks like on the map -- the outline lands on the
    # building, but every room is on the wrong side of it.
    #
    # The tie is broken on how much ROOM AREA ends up inside the footprint,
    # which is both the thing we actually want and the measure least
    # disturbed by drawing noise. Scoring the plan OUTLINE instead was tried
    # and is not safe: on sheets where the enlarged detail blocks touch the
    # plan, they join its ink component and bloat the outline, and maximising
    # the bloated outline's overlap flipped NE6 into the wrong orientation.
    # Detail blocks are a small share of total room area, so this measure
    # shrugs them off. Residual still does the coarse work; this only
    # re-ranks the handful of fits that survived it.
    if plan_rooms is None or not len(plan_rooms[0]) or not footprint_rings_local:
        return candidates[0]
    try:
        fp = unary_union([Polygon(r).buffer(0) for r in footprint_rings_local
                          if len(r) >= 4])
    except Exception:
        return candidates[0]
    if fp.is_empty:
        return candidates[0]

    sample, areas = plan_rooms
    total = float(areas.sum())
    if total <= 0:
        return candidates[0]

    best, best_inside = None, -1.0
    for resid, R, s, t in candidates[:8]:
        moved = apply_sim(R, s, t, sample)
        inside = shapely.contains_xy(fp, moved[:, 0], moved[:, 1])
        frac = float(areas[inside].sum()) / total
        if frac > best_inside + 1e-6:
            best, best_inside = (resid, R, s, t), frac
    return best if best is not None else candidates[0]


def _closest_point_on_segment(p, a, b):
    ab = b - a
    denom = ab @ ab
    if denom < 1e-9:
        return a, np.linalg.norm(p - a)
    tt = np.clip(((p - a) @ ab) / denom, 0.0, 1.0)
    proj = a + tt * ab
    return proj, np.linalg.norm(p - proj)


def closest_approach(rect_a, rect_b):
    """Nearest pair of points between two quad outlines (as edge segments), and
    the distance between them. Rects are Nx2 arrays of ordered corners."""
    best_d, best_pair = None, None
    for rect_p, rect_e in ((rect_a, rect_b), (rect_b, rect_a)):
        for p in rect_p:
            for i in range(len(rect_e)):
                a, b = rect_e[i], rect_e[(i + 1) % len(rect_e)]
                proj, d = _closest_point_on_segment(p, a, b)
                if best_d is None or d < best_d:
                    best_d, best_pair = d, (p, proj)
    mid = (best_pair[0] + best_pair[1]) / 2
    return best_d, mid


def find_doorways(rooms, zoom, scale_m_per_pt, max_gap_m=4.0):
    """Approximate doorway/connection points: for each room, the midpoint of
    its closest approach to the nearest corridor (or nearest other room, if the
    floor has no corridor feature). Not a true CAD door-symbol detection --
    but a practical proxy for navigation waypoints between spaces, given room
    labels are already flattened to unlabelled vector curves in these PDFs."""
    corridors = [r for r in rooms if r["type"] == "corridor"]
    routable = [r for r in rooms if r["type"] in ("room", "stairs") and r.get("room")]
    m_per_px = scale_m_per_pt / zoom

    doors = []
    for r in routable:
        pool = corridors if corridors else [o for o in routable if o is not r]
        best = None
        for other in pool:
            if other is r:
                continue
            d, mid = closest_approach(r["shell"], other["shell"])
            if best is None or d < best[0]:
                best = (d, mid, other)
        if best is None:
            continue
        d, mid, other = best
        if d * m_per_px > max_gap_m:  # not actually adjacent -> skip
            continue
        doors.append({
            "point_px": mid,
            "room": r["room"],
            "connects_to": other.get("room") or other["type"],
        })
    return doors


# ---------------------------------------------------------------------------
# End-to-end per floor
# ---------------------------------------------------------------------------

def trim_rooms_outside_outline(rooms, outline_px):
    """Drop segmented regions that are not part of the floor plan at all.

    BCIT sheets carry enlarged washroom/stair details and key plans beside
    the plan proper. Those are wall-enclosed white regions like any room, so
    segmentation happily returns them -- and once the sheet is fitted to the
    real footprint they land tens of metres outside the building (NE6 F1 put
    two detail blocks clear of its east wall). They are also what makes a
    building look "not aligned": a viewer sees rooms outside the outline and
    reads the whole fit as rotated.

    The main-ink outline already tells us where the plan proper is -- it is
    the same contour the footprint fit uses -- so anything whose centre sits
    outside it is off-plan. The margin keeps rooms that legitimately touch
    or straddle the outer wall.

    Refuses to act if it would remove half the floor: that means the outline
    itself is wrong, and a bad outline should not silently delete the plan.
    """
    if outline_px is None or len(outline_px) < 4 or not rooms:
        return rooms, 0
    contour = np.asarray(outline_px, dtype=np.float32).reshape(-1, 1, 2)
    x0, y0 = outline_px[:, 0].min(), outline_px[:, 1].min()
    x1, y1 = outline_px[:, 0].max(), outline_px[:, 1].max()
    margin = 0.01 * math.hypot(x1 - x0, y1 - y0)

    kept = []
    for r in rooms:
        shell = np.asarray(r["shell"], dtype=np.float64)
        cx, cy = shell[:, 0].mean(), shell[:, 1].mean()
        d = cv2.pointPolygonTest(contour, (float(cx), float(cy)), True)
        if d >= -margin:
            kept.append(r)
    dropped = len(rooms) - len(kept)
    if dropped > len(rooms) * 0.5:
        return rooms, 0
    return kept, dropped


def process_building(building, floors, buildings_index, coords, pdf_dir):
    """Geo-reference every floor of one building with a SINGLE shared transform.

    Each floor used to be fitted to the footprint independently, which let
    the floors of one building disagree with each other: stairwells landed
    up to 40m apart between floor 1 and floor 2, which is physically
    impossible -- a stair occupies the same shaft on every floor it serves.

    All floors of a BCIT building are drawn in the same CAD page coordinate
    system (verified: SE6's floors share an outline y-origin to the pixel),
    so one transform is not just sufficient but correct. Fitting once on the
    union of every floor's geometry also gives the fit more of the building
    outline to work with than any single floor has, and makes vertical
    features stack exactly as they do in the drawings.

    Returns (results_by_floor, error).
    """
    rings, method, (lon0, lat0) = find_footprints(building, buildings_index, coords)
    footprint_pts = None
    footprint_rings_local = None
    if rings:
        footprint_rings_local = [
            np.array([lonlat_to_local(lon, lat, lon0, lat0) for lon, lat in ring]) for ring in rings
        ]
        footprint_pts = np.vstack(footprint_rings_local)
    else:
        # No footprint exists for this building. Place it from its own
        # drawing instead of fitting it to a neighbour.
        entry = buildings_index.get(building)
        if not entry:
            return None, f"no footprint and no index centre for {building}"
        lon0, lat0 = entry["center"]

    per_floor = {}
    for floor in floors:
        pdf = os.path.join(pdf_dir, f"{building}-Floor{floor}.pdf")
        if not os.path.exists(pdf):
            continue
        try:
            rooms, zoom, outline_px = extract_rooms(pdf, floor)
        except Exception as e:  # one bad sheet shouldn't sink the building
            print(f"[WARN] {building}-Floor{floor}: extract failed ({e})")
            continue
        rooms, dropped = trim_rooms_outside_outline(rooms, outline_px)
        if dropped:
            print(f"[TRIM] {building}-Floor{floor}: dropped {dropped} off-plan "
                  f"region(s) outside the building outline")
        if rooms:
            per_floor[floor] = (rooms, zoom, outline_px)

    if not per_floor:
        return None, "no rooms segmented on any floor"

    # Fit each floor on its own, then adopt the single best-fitting floor's
    # transform for the whole building. Fitting the union of all floors
    # instead lets a sparse or noisy upper floor drag the shared fit off
    # true (SE6 came out visibly rotated that way); the ground floor
    # usually traces the full outline and fits best. One transform still
    # applies to every floor, so vertical features stay stacked.
    def plan_src(floor):
        rooms, zoom, outline_px = per_floor[floor]
        src = outline_px if outline_px is not None and len(outline_px) >= 4             else np.vstack([r["shell"] for r in rooms])
        px = np.asarray(src, dtype=np.float64) / zoom
        px[:, 1] *= -1
        return px

    SAMPLE_PER_ROOM = 24

    def plan_rooms(floor):
        """Sample points across the floor's rooms, with area weights.

        Scoring a placement by room CENTROIDS was too forgiving: a room can
        sit centred inside the building while half of it hangs out through a
        wall, and the score would call that perfect. SW3 floor 3 scored 97%
        that way while a fifth of its area was actually outside. Sampling the
        room outlines instead -- each room contributing its own area spread
        over its sample points -- measures coverage rather than position, so
        spilling out of the building costs what it should.
        """
        rooms, zoom, _outline = per_floor[floor]
        pts, weights = [], []
        for r in rooms:
            shell = np.asarray(r["shell"], dtype=np.float64) / zoom
            shell[:, 1] *= -1
            x, y = shell[:, 0], shell[:, 1]
            area = abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2
            if area <= 0:
                continue
            # outline vertices plus the centre, thinned so a finely traced
            # room does not cost more to score than a simple one
            if len(shell) > SAMPLE_PER_ROOM:
                idx = np.linspace(0, len(shell) - 1, SAMPLE_PER_ROOM).astype(int)
                sample = shell[idx]
            else:
                sample = shell
            sample = np.vstack([sample, shell.mean(axis=0)])
            pts.append(sample)
            weights.append(np.full(len(sample), area / len(sample)))
        if not pts:
            return np.zeros((0, 2)), np.zeros(0)
        return np.vstack(pts), np.concatenate(weights)

    approximate = False
    floor_fits = {}
    if footprint_pts is not None:
        candidates_fit = []
        for floor in per_floor:
            try:
                # the room layout lets the fit break rotation ties on how
                # much of the floor lands inside the building, rather than
                # on hull distance alone (which cannot see a 180deg flip)
                candidates_fit.append((
                    fit_plan_to_footprint(plan_src(floor), footprint_pts,
                                          plan_rooms=plan_rooms(floor),
                                          footprint_rings_local=footprint_rings_local),
                    floor))
            except Exception:
                continue
        if not candidates_fit:
            return None, "could not fit any floor to the footprint"

        fp_union = None
        try:
            fp_union = unary_union([Polygon(r).buffer(0)
                                    for r in footprint_rings_local if len(r) >= 4])
        except Exception:
            fp_union = None

        def frac_inside(floor, RR, ss, tt):
            """Share of a floor's room area that lands inside the footprint."""
            if fp_union is None or fp_union.is_empty:
                return 1.0
            sample, areas = plan_rooms(floor)
            if not len(areas) or areas.sum() <= 0:
                return 1.0
            moved = apply_sim(RR, ss, tt, sample)
            hit = shapely.contains_xy(fp_union, moved[:, 0], moved[:, 1])
            return float(areas[hit].sum()) / float(areas.sum())

        # Which floor's fit the whole building adopts used to be decided by
        # lowest hull residual. Residual measures how close the plan OUTLINE
        # sits to the footprint outline, which a fit turned 20-40 degrees can
        # satisfy perfectly well -- and that rotation was then imposed on
        # every other floor. Choose instead by how much room area the fit
        # puts inside the building, averaged over all the floors it will be
        # applied to, with residual only breaking ties.
        def building_score(entry):
            (r, RR, ss, tt), _floor = entry
            scores = [frac_inside(f, RR, ss, tt) for f in per_floor]
            return (sum(scores) / len(scores), -r)

        (resid, R, s, t), fit_floor = max(candidates_fit, key=building_score)

        # Every sheet is its own drawing: some upper floors are laid out at a
        # different angle on the page than the ground floor, so one shared
        # transform cannot be right for all of them -- SW1 floor 1 fits while
        # floor 3 comes out 61 degrees off, and SW3's floors 2 and 3 are 18
        # and 36 degrees off their own floor 1. Each floor is therefore
        # checked on its own and given its own fit when that is measurably
        # better, rather than inheriting a rotation that suits another sheet.
        def refine_floor_fit(floor, R0, s0, t0):
            """Nudge one floor into place, a piece at a time.

            A fit found from the outline can be a degree or two out, or a few
            metres adrift, and no amount of outline matching will notice --
            the outline still sits on the footprint. What is measurable is
            how much of the floor's ROOM area ends up inside the building, so
            this walks rotation and offset around the fit already found and
            keeps whichever placement puts most of the floor indoors.

            Coarse first, then fine, and the floor is spun about its own
            centre so it turns in place rather than swinging away. Ties go to
            the smallest movement: when two placements are equally good the
            one that disturbs the existing fit least is the honest choice.
            """
            sample, areas = plan_rooms(floor)
            if fp_union is None or fp_union.is_empty or not len(areas):
                return R0, s0, t0
            total = float(areas.sum())
            if total <= 0:
                return R0, s0, t0

            centre = apply_sim(R0, s0, t0, sample).mean(axis=0)

            def score(dtheta_deg, dx, dy):
                th = math.radians(dtheta_deg)
                Rot = np.array([[math.cos(th), -math.sin(th)],
                                [math.sin(th), math.cos(th)]])
                R2 = Rot @ R0
                t2 = Rot @ (t0 - centre) + centre + np.array([dx, dy])
                moved = apply_sim(R2, s0, t2, sample)
                hit = shapely.contains_xy(fp_union, moved[:, 0], moved[:, 1])
                return float(areas[hit].sum()) / total, R2, t2

            best = (score(0, 0, 0)[0], 0.0, 0.0, 0.0)
            for angles, offsets in (
                (np.arange(-60, 61, 2.0), np.arange(-8, 8.1, 4.0)),
                (np.arange(-2.5, 2.6, 0.25), np.arange(-3, 3.1, 1.0)),
            ):
                base_th, base_x, base_y = best[1], best[2], best[3]
                for dth in angles:
                    for dx in offsets:
                        for dy in offsets:
                            th, x, y = base_th + dth, base_x + dx, base_y + dy
                            f = score(th, x, y)[0]
                            moved_by = abs(th) + math.hypot(x, y)
                            best_moved = abs(best[1]) + math.hypot(best[2], best[3])
                            if f > best[0] + 1e-9 or (
                                    abs(f - best[0]) <= 1e-9 and moved_by < best_moved):
                                best = (f, th, x, y)

            _, R2, t2 = score(best[1], best[2], best[3])
            return R2, s0, t2

        MISPLACED_BELOW = 0.85
        floor_fits = {}
        for floor in per_floor:
            shared_score = frac_inside(floor, R, s, t)
            if floor == fit_floor or shared_score >= MISPLACED_BELOW:
                continue
            try:
                own = fit_plan_to_footprint(
                    plan_src(floor), footprint_pts,
                    plan_rooms=plan_rooms(floor),
                    footprint_rings_local=footprint_rings_local)
            except Exception:
                continue
            own_score = frac_inside(floor, own[1], own[2], own[3])
            if own_score > shared_score + 0.05:
                floor_fits[floor] = own
                print(f"[REFIT] {building}-Floor{floor}: shared transform left "
                      f"{100 * (1 - shared_score):.0f}% of the floor outside the "
                      f"building; own fit leaves {100 * (1 - own_score):.0f}%")

        # Last pass: with each floor's transform settled, walk each one into
        # its best position individually. Floors that already sit right barely
        # move; the ones that were out find their place.
        for floor in per_floor:
            base = floor_fits.get(floor, (resid, R, s, t))
            before = frac_inside(floor, base[1], base[2], base[3])
            R2, s2, t2 = refine_floor_fit(floor, base[1], base[2], base[3])
            after = frac_inside(floor, R2, s2, t2)
            if after > before + 0.005:
                floor_fits[floor] = (base[0], R2, s2, t2)
                print(f"[NUDGE] {building}-Floor{floor}: "
                      f"{100 * (1 - before):.0f}% -> {100 * (1 - after):.0f}% "
                      f"of the floor outside the building")
    else:
        # Footprint-free placement: scale from the title block, orientation
        # from the campus grid, position from the buildings index. Rotation
        # can't be verified without a footprint, so this is flagged as
        # approximate rather than presented as a measured fit -- but it puts
        # the rooms in the right building, which fitting to a neighbour did
        # not.
        fit_floor = max(per_floor, key=lambda f: len(plan_src(f)))
        px = plan_src(fit_floor)
        span_pt = max(px[:, 0].max() - px[:, 0].min(), px[:, 1].max() - px[:, 1].min())
        ratios = read_plan_scale(os.path.join(pdf_dir, f"{building}-Floor{fit_floor}.pdf"))
        ratio = next((r for r in ratios if 12.0 <= span_pt * r * PT_TO_M <= 220.0), None)
        if not ratio:
            return None, (f"no footprint, and no drawing scale in {ratios or 'unreadable'} "
                          f"implies a believable size for {building}")
        s = ratio * PT_TO_M
        span = span_pt * s
        theta = math.radians(((campus_grid_angle(coords, lat0) - dominant_angle(px)) + 45) % 90 - 45)
        R = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
        t = -s * (R @ px.mean(axis=0))
        resid = float("nan")
        approximate = True

    results = {}
    for floor, (rooms, zoom, _outline) in per_floor.items():
        f_resid, fR, fs, ft = floor_fits.get(floor, (resid, R, s, t))
        own_fit = floor in floor_fits

        def transform_ring(px_ring, _zoom=zoom, _R=fR, _s=fs, _t=ft):
            pts_pt = (np.asarray(px_ring, dtype=np.float64) / _zoom).copy()
            pts_pt[:, 1] *= -1
            local = apply_sim(_R, _s, _t, pts_pt)
            ring = [list(local_to_lonlat(x, y, lon0, lat0)) for x, y in local]
            ring.append(ring[0])
            return ring

        features = []
        for r in rooms:
            geom_rings = [transform_ring(r["shell"])]
            for h in (r.get("holes") or []):
                geom_rings.append(transform_ring(h))
            props = {
                "room": r["room"], "building": building, "floor": floor,
                "type": r["type"], "confidence": r.get("confidence", "low"),
            }
            if r.get("approx_location_only"):
                props["approx_location_only"] = True
            if approximate:
                # placed from drawing scale + campus grid, not fitted to a
                # measured footprint (none exists for this building)
                props["approximate_placement"] = True
            features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Polygon", "coordinates": geom_rings},
            })

        doors = find_doorways(rooms, zoom, fs)
        for door in doors:
            pt_pt = (door["point_px"] / zoom).copy()
            pt_pt[1] *= -1
            local = apply_sim(fR, fs, ft, pt_pt.reshape(1, 2))[0]
            lon, lat = local_to_lonlat(local[0], local[1], lon0, lat0)
            features.append({
                "type": "Feature",
                "properties": {
                    "room": None, "building": building, "floor": floor, "type": "door",
                    "connects": [door["room"], door["connects_to"]],
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            })

        fc = {"type": "FeatureCollection", "features": features}
        meta = {
            "building": building, "floor": floor,
            "footprint_match": method,
            "fit_residual_m": (None if f_resid != f_resid else round(f_resid, 2)),
            "approximate_placement": approximate,
            "shared_building_fit": not own_fit,
            "fit_from_floor": fit_floor,
            "n_features": len(features),
            "n_doors": len(doors),
            "n_high_confidence": sum(1 for f in features if f["properties"].get("confidence") == "high"),
            "n_needs_review": sum(1 for f in features
                                  if f["properties"].get("confidence") in ("low", None)
                                  and f["geometry"]["type"] == "Polygon"),
        }
        results[floor] = (fc, meta)

    return results, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("building", nargs="?")
    ap.add_argument("floor", nargs="?")
    ap.add_argument("--all-burnaby", action="store_true")
    ap.add_argument("--out", default="public/data/floor-coordinates-auto")
    ap.add_argument("--skip-existing", dest="skip_existing", action="store_true", default=True)
    ap.add_argument("--no-skip-existing", dest="skip_existing", action="store_false")
    args = ap.parse_args()

    os.chdir(REPO_ROOT)
    buildings_index = load_json("public/data/bcit-buildings-index.json")
    coords = load_json("public/data/bcit-coordinates.geojson")
    pdf_dir = "public/data/floorplans"
    existing_dir = "public/data/floor-coordinates"

    os.makedirs(args.out, exist_ok=True)

    # group by building: floors of one building share a single fit
    by_building = {}
    if args.all_burnaby:
        for pdf in sorted(glob.glob(os.path.join(pdf_dir, "*-Floor*.pdf"))):
            name = os.path.splitext(os.path.basename(pdf))[0]
            m = re.match(r"(.+)-Floor(\d+)$", name)
            if not m:
                continue
            by_building.setdefault(m.group(1), []).append(m.group(2))
    else:
        if not args.building:
            print("specify BUILDING FLOOR, or --all-burnaby")
            sys.exit(1)
        if args.floor:
            by_building[args.building] = [args.floor]
        else:
            for pdf in sorted(glob.glob(os.path.join(pdf_dir, f"{args.building}-Floor*.pdf"))):
                name = os.path.splitext(os.path.basename(pdf))[0]
                m = re.match(r"(.+)-Floor(\d+)$", name)
                if m:
                    by_building.setdefault(m.group(1), []).append(m.group(2))

    report = []
    for building, floors in sorted(by_building.items()):
        floors = sorted(set(floors), key=lambda f: (len(f), f))
        if args.skip_existing:
            floors = [f for f in floors
                      if not os.path.exists(os.path.join(existing_dir, f"{building}-Floor{f}.geojson"))]
            if not floors:
                report.append({"building": building, "status": "skipped_existing"})
                continue

        results, err = process_building(building, floors, buildings_index, coords, pdf_dir)
        if err:
            print(f"[FAIL] {building}: {err}")
            report.append({"building": building, "floors": floors, "status": "error", "error": err})
            continue

        for floor in sorted(results, key=lambda f: (len(f), f)):
            fc, meta = results[floor]
            out_path = os.path.join(args.out, f"{building}-Floor{floor}.geojson")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(fc, f, indent=2)
            meta["status"] = "ok"
            report.append(meta)
            print(f"[OK]   {building}-Floor{floor}: {meta['n_features']} features, "
                  f"residual {meta['fit_residual_m']}m, "
                  f"{meta['n_high_confidence']} high-confidence labels, "
                  f"{meta['n_needs_review']} need review")

    report_path = os.path.join(args.out, "_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport written to {report_path}")


if __name__ == "__main__":
    main()