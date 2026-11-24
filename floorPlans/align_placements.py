"""
Place every floor-plan image on the map by fitting it to the building footprint.

The tracer needs to know where a drawing sits in the world: a centre, a width
in metres and an angle. Doing that by hand means dragging each of ninety
sheets onto the map by eye. But the answer is already in the data -- BCIT's
GIS footprints say exactly where each building is, and the ground-floor
drawing is a picture of that same outline. Fitting one to the other gets the
placement from geometry rather than from a steady hand.

Two facts make this cheap:

  * Every sheet of a building is the same page at the same drawing scale, and
    the renderer crops each to its ink. Undo the crop and all floors of a
    building share one page frame -- so one fit, against the ground floor,
    places the whole building. (The three SE2 floors placed by hand agree on
    that frame to within three centimetres, which is what suggested it.)

  * Architects draw to round scales. The fitted metres-per-pixel lands on
    1:200, 1:300, 1:500 and friends, so a fit that comes out at 1:298 is
    really 1:300 and can be snapped there.

Usage:
  py -3 floorPlans/align_placements.py            # fit every unplaced building
  py -3 floorPlans/align_placements.py NE1 NE2    # just these
  py -3 floorPlans/align_placements.py --write    # save into _placements.json
"""
import os, sys, json, glob, math, argparse, collections

import numpy as np
import cv2
import pymupdf as fitz
from shapely.geometry import shape
from shapely.ops import unary_union, transform as shp_transform

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
IMG_DIR = os.path.join(REPO, "public", "data", "floorplan-images")
PDF_DIR = os.path.join(REPO, "public", "data", "floorplans")
FOOTPRINTS = os.path.join(REPO, "public", "data", "bcit-coordinates.geojson")
PLACEMENTS = os.path.join(IMG_DIR, "_placements.json")
INDEX = os.path.join(IMG_DIR, "_index.json")
CACHE = os.path.join(os.path.dirname(__file__), "_pageframes.json")

ZOOM = 3.0            # the render scale used by render_plan_images.py
WHITE_CUTOFF = 245
MARGIN_PX = 12
DPI = 72 * ZOOM

R_EARTH = 6371008.8
LAT0, LNG0 = 49.2505, -123.0020          # campus reference for the local frame
M_PER_DEG_LAT = (math.pi / 180) * R_EARTH
M_PER_DEG_LNG = M_PER_DEG_LAT * math.cos(math.radians(LAT0))

# the scales these sheets are actually drawn at, as metres per rendered pixel
RATIOS = [75, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 500, 600]

# The only angles a sheet is placed at. BCIT's drawings sit square on their
# pages, so a plan meets the map at a quarter turn and never on a diagonal.
# Left free, the footprint match drifts a few degrees off to buy overlap
# against outlines that are themselves approximate, which is noise, not
# survey. A building genuinely drawn askew needs an explicit rotation in
# alignment_overrides.json.
SQUARE = (0.0, 90.0, 180.0, 270.0)


def ratio_to_scale(r):
    return r * 0.0254 / DPI


# ---------------------------------------------------------------------------
# The page frame: where the renderer's crop sat on the sheet
# ---------------------------------------------------------------------------
def ink_bbox(pix):
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    grey = arr[:, :, :3].min(axis=2) if pix.n >= 3 else arr[:, :, 0]
    ink = grey < WHITE_CUTOFF
    rows = np.flatnonzero(ink.any(axis=1))
    cols = np.flatnonzero(ink.any(axis=0))
    if not len(rows) or not len(cols):
        return None
    return (max(int(cols[0]) - MARGIN_PX, 0),
            max(int(rows[0]) - MARGIN_PX, 0),
            min(int(cols[-1]) + MARGIN_PX, pix.width - 1),
            min(int(rows[-1]) + MARGIN_PX, pix.height - 1))


def page_frames():
    """Crop origin of every sheet, cached -- re-rendering 89 PDFs is slow."""
    if os.path.exists(CACHE):
        return json.load(open(CACHE, encoding="utf-8"))
    out = {}
    for pdf in sorted(glob.glob(os.path.join(PDF_DIR, "*-Floor*.pdf"))):
        stem = os.path.splitext(os.path.basename(pdf))[0]
        doc = fitz.open(pdf)
        pix = doc[0].get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM))
        box = ink_bbox(pix)
        out[stem] = {"page_w": pix.width, "page_h": pix.height, "crop": box}
        doc.close()
    json.dump(out, open(CACHE, "w", encoding="utf-8"), indent=1)
    return out


# ---------------------------------------------------------------------------
# The two things being matched
# ---------------------------------------------------------------------------
def building_mask(stem):
    """The drawn building, as a filled mask -- title block and arrow dropped."""
    im = cv2.imread(os.path.join(IMG_DIR, stem + ".png"), cv2.IMREAD_GRAYSCALE)
    if im is None:
        return None
    H, W = im.shape
    ink = (im < WHITE_CUTOFF).astype(np.uint8)
    # the sheet border sits just inside the crop; without this it becomes one
    # component wrapping the whole page and swallows the plan
    m = int(round(0.02 * max(H, W)))
    ink[:m, :] = 0
    ink[-m:, :] = 0
    ink[:, :m] = 0
    ink[:, -m:] = 0
    k = max(3, int(round(0.006 * max(H, W))) | 1)
    closed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(closed, 8)
    best, best_area = None, 0
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 0.0005 * H * W:
            continue
        comp = (lab == i).astype(np.uint8)
        holes = comp.copy()
        cv2.floodFill(holes, np.zeros((H + 2, W + 2), np.uint8), (0, 0), 1)
        filled = comp | (1 - holes)
        area = int(filled.sum())
        # A plan is walls and lettering all through it, so a good fraction of
        # what it encloses is ink -- a sixth of it, typically. A big shape
        # whose outline is all there is to it is a site boundary or a shaded
        # zone, not a drawing: NE3's sheet carries one nearly three times the
        # size of the plan, and NW4's swallowed all four of its floors.
        if int(comp.sum()) < 0.025 * area:
            continue
        if area > best_area:
            best, best_area = filled, area
    return best


def to_metres(geom):
    return shp_transform(lambda x, y, z=None: ((x - LNG0) * M_PER_DEG_LNG,
                                               (y - LAT0) * M_PER_DEG_LAT), geom)


def footprints():
    """Building outlines, in local metres, keyed by building code."""
    gj = json.load(open(FOOTPRINTS, encoding="utf-8"))
    by_name = collections.defaultdict(list)
    for f in gj["features"]:
        name = (f["properties"].get("BuildingName")
                or f["properties"].get("Display_Name"))
        if not name:
            continue
        by_name[name.strip()].append(shape(f["geometry"]))
    return {n: to_metres(unary_union(g)) for n, g in by_name.items()}


def rasterise(geom, res, pad):
    """Footprint as a mask, with the world coordinate of its (0,0) pixel."""
    minx, miny, maxx, maxy = geom.bounds
    minx -= pad
    miny -= pad
    maxx += pad
    maxy += pad
    w = int(math.ceil((maxx - minx) / res))
    h = int(math.ceil((maxy - miny) / res))
    img = np.zeros((h, w), np.uint8)
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    for p in polys:
        for i, ring in enumerate([p.exterior] + list(p.interiors)):
            pts = np.array([[(x - minx) / res, (maxy - y) / res]
                            for x, y in ring.coords], np.int32)
            cv2.fillPoly(img, [pts], 0 if i else 1)
    return img, (minx, maxy)


# ---------------------------------------------------------------------------
# The fit
# ---------------------------------------------------------------------------
def warp(mask, s, theta_deg, res, cap):
    """Put an image-pixel mask into the metric raster at scale s and angle t.

    Image x runs right and image y runs *down*, while north runs up, so the y
    axis flips on the way out. Rotation follows the tracer: positive is
    counter-clockwise on the map. The result is snug to its own bounding box;
    the caller slides it with a translation.
    """
    th = math.radians(theta_deg)
    c, sn = math.cos(th), math.sin(th)
    f = s / res                                   # image px -> raster px
    M = np.array([[f * c,  f * sn, 0.0],
                  [f * sn, -f * c, 0.0]], np.float64)
    h, w = mask.shape
    corners = np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]])
    xs = M[0, 0] * corners[:, 0] + M[0, 1] * corners[:, 1]
    ys = M[1, 0] * corners[:, 0] + M[1, 1] * corners[:, 1]
    ow = int(math.ceil(xs.max() - xs.min())) + 1
    oh = int(math.ceil(ys.max() - ys.min())) + 1
    if ow > cap or oh > cap:
        return None, None
    M[0, 2] = -xs.min()
    M[1, 2] = -ys.min()
    return cv2.warpAffine(mask, M, (ow, oh), flags=cv2.INTER_NEAREST), (-xs.min(), -ys.min())


def best_shift(target, moving):
    """Translation of `moving` over `target` maximising overlap, by FFT."""
    h = target.shape[0] + moving.shape[0]
    w = target.shape[1] + moving.shape[1]
    F = np.fft.rfft2(target.astype(np.float32), (h, w))
    G = np.fft.rfft2(moving[::-1, ::-1].astype(np.float32), (h, w))
    corr = np.fft.irfft2(F * G, (h, w))
    i = int(np.argmax(corr))
    y, x = divmod(i, w)
    return y - moving.shape[0] + 1, x - moving.shape[1] + 1


def iou_at(target, moving, dy, dx):
    th, tw = target.shape
    mh, mw = moving.shape
    y0, x0 = max(0, dy), max(0, dx)
    y1, x1 = min(th, dy + mh), min(tw, dx + mw)
    if y1 <= y0 or x1 <= x0:
        return 0.0
    a = target[y0:y1, x0:x1]
    b = moving[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    inter = int(np.logical_and(a, b).sum())
    union = int(target.sum()) + int(moving.sum()) - inter
    return inter / union if union else 0.0


def search(mask, geom, scales, thetas, res, work=700, pad=40.0, target=None,
           origin=None):
    """Best (IoU, scale, angle, world centre) over the given grid."""
    if target is None:
        target, origin = rasterise(geom, res, pad)
    minx, maxy = origin
    H, W = mask.shape
    f = min(1.0, work / max(H, W))
    small = mask if f == 1.0 else cv2.resize(mask, (0, 0), fx=f, fy=f,
                                             interpolation=cv2.INTER_AREA)
    small = (small > 0).astype(np.uint8)
    px = 1.0 / f                                  # small-px -> full-image px
    cap = 4 * max(target.shape)
    best = None
    for s in scales:
        for t in thetas:
            mv, off = warp(small, s * px, t, res, cap)
            if mv is None or not mv.any():
                continue
            dy, dx = best_shift(target, mv)
            v = iou_at(target, mv, dy, dx)
            if best is None or v > best[0]:
                # where the image centre landed, in world metres
                th = math.radians(t)
                c, sn = math.cos(th), math.sin(th)
                sm_h, sm_w = small.shape
                cx = (sm_w / 2 * c + sm_h / 2 * sn) * (s * px) / res + off[0]
                cy = (sm_w / 2 * sn - sm_h / 2 * c) * (s * px) / res + off[1]
                best = (v, s, t % 360,
                        minx + (dx + cx) * res, maxy - (dy + cy) * res)
    return best


def candidate_scales(mask, geom):
    """Drawing scales worth trying, in metres per image pixel.

    The ground-floor drawing is a picture of the footprint, so its ink covers
    about the same ground area -- that alone fixes the scale to within a few
    per cent. Architects then draw to round ratios, so the real answer is one
    of the standard ones near that estimate. Searching those few beats
    sweeping a continuous range, and lands exactly on the drawn scale.
    """
    px = float(mask.sum())
    if px <= 0:
        return [ratio_to_scale(r) for r in RATIOS]
    seed = math.sqrt(geom.area / px)              # metres per pixel by area
    lo, hi = seed / 1.30, seed * 1.30
    near = [ratio_to_scale(r) for r in RATIOS if lo <= ratio_to_scale(r) <= hi]
    return sorted(set(near + [seed])) or [seed]


def north_on_sheet(stem):
    """Which way is north on the drawing, in degrees of map rotation.

    A footprint match alone cannot tell a building from the same building
    turned around: SW5 scores 0.97 either way up. But every BCIT sheet
    carries a north symbol -- a circle with a chord straight across it and a
    triangle standing on that chord, apex pointing north. Find the circle,
    find the chord, and the apex is on whichever side of the chord the ink
    reaches furthest. That settles the half-turn.

    The BCIT logo is a circle too, so a candidate only counts if something
    close to a diameter is drawn across it -- the logo swoosh has no such
    chord. Draughtsmen round the symbol to the nearest right angle, so this
    is a coarse bearing to search around, not the final answer.
    """
    im = cv2.imread(os.path.join(IMG_DIR, stem + ".png"), cv2.IMREAD_GRAYSCALE)
    if im is None:
        return None
    H, W = im.shape
    lo, hi = int(0.010 * max(H, W)), int(0.045 * max(H, W))
    circles = cv2.HoughCircles(cv2.medianBlur(im, 3), cv2.HOUGH_GRADIENT, dp=1,
                               minDist=int(0.6 * hi), param1=120, param2=55,
                               minRadius=max(20, lo), maxRadius=hi)
    if circles is None:
        return None
    ink = (im < WHITE_CUTOFF).astype(np.uint8)
    # section bubbles and door swings inside the plan are circles with chords
    # too; the north symbol is the one standing clear of the drawing
    plan = building_mask(stem)
    if plan is not None:
        plan = cv2.dilate(plan, np.ones((25, 25), np.uint8))
    best = None
    for cx, cy, r in np.asarray(circles, dtype=np.float64).reshape(-1, 3):
        cx, cy, r = float(cx), float(cy), float(r)
        if plan is not None and plan[int(cy), int(cx)]:
            continue
        x0, y0 = int(cx - r), int(cy - r)
        x1b, y1b = int(cx + r) + 1, int(cy + r) + 1
        if x0 < 0 or y0 < 0 or x1b > W or y1b > H:
            continue
        tile = ink[y0:y1b, x0:x1b]
        yy, xx = np.ogrid[:tile.shape[0], :tile.shape[1]]
        rad = np.sqrt((xx - r) ** 2 + (yy - r) ** 2)
        # Hough will happily report a circle over a patch of logo or text, so
        # insist the ring is actually drawn: without this the BCIT roundel
        # under the title block wins on several sheets
        annulus = (rad >= 0.88 * r) & (rad <= 1.10 * r)
        ang = np.arctan2(yy - r, xx - r)
        bins = np.floor((ang[annulus] + math.pi) / (math.pi / 18)).astype(int)
        hit = np.unique(bins[tile[annulus] > 0])
        if len(hit) < 27:                               # of 36 ten-degree arcs
            continue
        # keep only what is well inside the ring, so the ring itself and any
        # label sitting beside the symbol cannot pose as the chord
        inside = rad <= 0.86 * r
        tri = (tile & inside).astype(np.uint8)
        if tri.sum() < 0.02 * math.pi * r * r:
            continue
        segs = cv2.HoughLinesP(tri * 255, 1, math.pi / 360,
                               threshold=int(0.8 * r),
                               minLineLength=int(1.1 * r),
                               maxLineGap=int(0.25 * r))
        if segs is None:
            continue
        segs = np.asarray(segs).reshape(-1, 4)
        sx1, sy1, sx2, sy2 = max(
            segs, key=lambda s: (s[2] - s[0]) ** 2 + (s[3] - s[1]) ** 2)
        L = math.hypot(sx2 - sx1, sy2 - sy1)
        if L < 1.1 * r:
            continue
        pts = np.column_stack(np.nonzero(tri))          # (row, col)
        nx, ny = -(sy2 - sy1) / L, (sx2 - sx1) / L      # a normal to the chord
        # the triangle stands on a chord through the middle, not on a tangent
        if abs((r - sx1) * nx + (r - sy1) * ny) > 0.35 * r:
            continue
        d = (pts[:, 1] - sx1) * nx + (pts[:, 0] - sy1) * ny
        reach = max(d.max(), -d.min())
        if d.max() < -d.min():                          # apex on the other side
            nx, ny = -nx, -ny
        if reach < 0.35 * r:                            # no triangle: not it
            continue
        score = L / r + reach / r
        if best is None or score > best[0]:
            # image (x right, y down) -> plan metres (x, -y); the rotation
            # brings the sheet's north round to map north
            best = (score, (90.0 - math.degrees(math.atan2(-ny, nx))) % 360)
    return best[1] if best else None


def fit_building(mask, geom, angles=None, ratio=None):
    """Coarse sweep over scale and angle, then a local refinement.

    `near` narrows the angle search to the bearing the north symbol implies,
    which is what stops a symmetric building settling in the upside-down
    basin that scores just as well. `ratio` pins the drawing scale, for the
    sheets that print it or print their floor area -- matching a drawing to
    a footprint that is not the same shape (SW9's outline is three times its
    drawn floor) otherwise stretches the plan to fill it.
    """
    if ratio:
        scales = [ratio_to_scale(ratio)]
    else:
        scales = candidate_scales(mask, geom)
    thetas = list(angles) if angles is not None else list(SQUARE)
    coarse = search(mask, geom, scales, thetas, res=1.2, work=460)
    if coarse is None:
        return None
    _, s0, t0, _, _ = coarse
    # the angle is one of a fixed few, so only the scale is refined
    fine_scales = [s0] if ratio else sorted(
        {s0 * k for k in (0.96, 0.98, 1.0, 1.02, 1.04)})
    fine = search(mask, geom, fine_scales, [t0], res=0.5, work=850)
    return fine if fine and fine[0] >= coarse[0] else coarse


def rotation_runner_up(mask, geom, best_theta):
    """Best IoU at least 90 degrees away -- a near tie means the shape is
    too symmetric to trust the angle, and the fit wants human eyes."""
    scales = candidate_scales(mask, geom)
    alt = [t for t in SQUARE
           if abs((t - best_theta + 180) % 360 - 180) >= 90]
    if not alt:
        return 0.0
    r = search(mask, geom, scales, alt, res=1.2, work=460)
    return r[0] if r else 0.0


def snap_scale(s):
    """Nudge a fitted scale onto the round ratio the sheet was drawn at."""
    ratio = s * DPI / 0.0254
    near = min(RATIOS, key=lambda r: abs(r - ratio))
    if abs(near - ratio) / near <= 0.05:
        return ratio_to_scale(near), near, True
    return s, ratio, False


# ---------------------------------------------------------------------------
# Page frame maths -- carrying one fit to the other floors
# ---------------------------------------------------------------------------
def to_page_frame(p, W, H, crop):
    """A placement, re-expressed as the world pose of the sheet's origin."""
    s = p["widthM"] / W
    th = math.radians(p["rotation"])
    cx, cy = crop[0] + W / 2, crop[1] + H / 2
    E = (p["lng"] - LNG0) * M_PER_DEG_LNG
    N = (p["lat"] - LAT0) * M_PER_DEG_LAT
    px, py = -cx * s, cy * s
    return {"s": s, "rot": p["rotation"],
            "E0": E + px * math.cos(th) - py * math.sin(th),
            "N0": N + px * math.sin(th) + py * math.cos(th)}


def from_page_frame(fr, W, H, crop):
    """The inverse: this sheet's placement, given the page pose."""
    s, th = fr["s"], math.radians(fr["rot"])
    cx, cy = crop[0] + W / 2, crop[1] + H / 2
    px, py = cx * s, -cy * s
    E = fr["E0"] + px * math.cos(th) - py * math.sin(th)
    N = fr["N0"] + px * math.sin(th) + py * math.cos(th)
    return {"lng": LNG0 + E / M_PER_DEG_LNG, "lat": LAT0 + N / M_PER_DEG_LAT,
            "widthM": s * W, "rotation": fr["rot"] % 360}


# ---------------------------------------------------------------------------
# Choosing what to believe, sheet by sheet
#
# Fitting against a footprint rewards a drawing that fills it, so it only
# tells the truth for a sheet that really does cover the whole building.
# Upper floors are smaller and partial plans smaller still -- matched alone
# they come out scaled up to fill the outline, which is wrong. So each sheet
# is fitted on its own, the most convincing one becomes the building's
# anchor, and the rest are placed from the anchor's page frame. A sheet whose
# own fit found a different drawing scale is not on that page frame at all
# (SE12's ground floor is drawn at 1:125 while its upper floors are 1:300),
# so it keeps its own fit and gets flagged.
# ---------------------------------------------------------------------------
def overlap(mask, geom, p, res=0.6):
    """(coverage, IoU) of a drawing placed against its footprint.

    Coverage is the share of the drawing that lands inside the outline -- the
    check for a partial floor, which cannot fill it but should still be
    within it. On its own coverage rewards shrinking, since a small enough
    plan fits inside anything, so anywhere a choice is being made it is
    paired with IoU, which does not.
    """
    H, W = mask.shape
    s = p["widthM"] / W
    target, (minx, maxy) = rasterise(geom, res, 25.0)
    th = math.radians(p["rotation"])
    c, sn = math.cos(th), math.sin(th)
    f = s / res
    E = (p["lng"] - LNG0) * M_PER_DEG_LNG
    N = (p["lat"] - LAT0) * M_PER_DEG_LAT
    M = np.array([[f * c, f * sn, 0.0], [f * sn, -f * c, 0.0]])
    M[0, 2] = (E - minx) / res - (M[0, 0] * W / 2 + M[0, 1] * H / 2)
    M[1, 2] = (maxy - N) / res - (M[1, 0] * W / 2 + M[1, 1] * H / 2)
    mv = cv2.warpAffine(mask, M, (target.shape[1], target.shape[0]),
                        flags=cv2.INTER_NEAREST)
    tot = int(mv.sum())
    if not tot:
        return 0.0, 0.0
    inter = int(np.logical_and(target, mv).sum())
    union = int(target.sum()) + tot - inter
    return inter / tot, (inter / union if union else 0.0)


def coverage(mask, geom, p, res=0.6):
    return overlap(mask, geom, p, res)[0]


def fit_sheet(stem, geom, mask, ratio=None, angles=None):
    """Independent fit of one sheet, with its scale snapped to a round ratio."""
    best = fit_building(mask, geom, ratio=ratio, angles=angles)
    if best is None:
        return None
    iou, s, rot, E, N = best
    s, ratio, snapped = snap_scale(s)
    H, W = mask.shape
    return {"iou": iou, "ratio": ratio, "snapped": snapped, "rotation": rot,
            "placement": {"lng": LNG0 + E / M_PER_DEG_LNG,
                          "lat": LAT0 + N / M_PER_DEG_LAT,
                          "widthM": s * W, "rotation": rot}}


def choose_anchor(fits, masks, geom, frames, index):
    """Which sheet's fit should set the building's page frame.

    Not simply the best-scoring one. A floor smaller than the footprint gets
    blown up to fill it, and can still score well doing so -- NE4's second
    floor matched at 0.87 eighty degrees away from where its ground floor
    plainly sits. What gives a wrong anchor away is its siblings: carry its
    frame across to them and they hang off the building. So each candidate
    is judged on its own match *and* on how well every other sheet of the
    building lands once placed from it.
    """
    best, best_score = None, None
    for cand, f in fits.items():
        m = index[cand]
        frame = to_page_frame(f["placement"], m["width"], m["height"],
                              frames[cand]["crop"])
        # scored on IoU, not coverage: a frame that shrinks every sheet keeps
        # them all inside the outline and would win on coverage alone
        ious = []
        for stem, mask in masks.items():
            mm = index[stem]
            ious.append(overlap(mask, geom,
                                from_page_frame(frame, mm["width"], mm["height"],
                                                frames[stem]["crop"]),
                                res=1.0)[1])
        score = f["iou"] + sum(ious) / len(ious)
        if best_score is None or score > best_score:
            best, best_score = cand, score
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("buildings", nargs="*")
    ap.add_argument("--write", action="store_true",
                    help="save the fits into _placements.json")
    ap.add_argument("--redo-placed", action="store_true",
                    help="also refit sheets that already have a placement")
    ap.add_argument("--report", default=os.path.join(os.path.dirname(__file__),
                                                     "alignment_fits.json"))
    ap.add_argument("--diag", metavar="DIR",
                    help="write a footprint overlay per building for review")
    args = ap.parse_args()

    index = json.load(open(INDEX, encoding="utf-8"))
    placed = json.load(open(PLACEMENTS, encoding="utf-8"))
    frames = page_frames()
    feet = footprints()
    overrides = load_overrides()
    if args.diag:
        os.makedirs(args.diag, exist_ok=True)

    sheets = collections.defaultdict(list)
    for stem, meta in index.items():
        sheets[meta["building"]].append(stem)
    for b in sheets:
        sheets[b].sort(key=lambda s: int(index[s]["floor"]))

    results = {}
    for b in (args.buildings or sorted(sheets)):
        if b not in sheets:
            print(f"[skip] {b}: no sheets")
            continue
        wanted = [s for s in sheets[b] if args.redo_placed or s not in placed]
        if not wanted:
            print(f"[keep] {b}: already placed by hand")
            continue
        if b not in feet:
            print(f"[fail] {b}: no footprint in bcit-coordinates.geojson")
            continue
        geom = feet[b]

        masks = {}
        for s in sheets[b]:
            m = building_mask(s)
            if m is not None and m.any():
                masks[s] = m
        if not masks:
            print(f"[fail] {b}: no drawing found on any sheet")
            continue

        pinned = overrides.get(b, {}).get("ratio")
        # an override's angle is taken as given; otherwise the four squares
        stated = overrides.get(b, {}).get("rotation")
        allowed = [float(stated)] if stated is not None else list(SQUARE)
        fits = {s: fit_sheet(s, geom, masks[s], ratio=pinned, angles=allowed)
                for s in masks}
        fits = {k: v for k, v in fits.items() if v}
        if not fits:
            print(f"[fail] {b}: no fit")
            continue
        anchor = choose_anchor(fits, masks, geom, frames, index)
        af = fits[anchor]
        am = masks[anchor]
        runner = rotation_runner_up(am, geom, af["rotation"])

        # The bearing read off the sheet's own north symbol. An override
        # already pinned the angle above, so this only covers the case where
        # the footprint match cannot tell a building from itself turned
        # around and the symbol is the only other witness.
        north = None
        if stated is None:
            read = north_on_sheet(anchor)
            if read is not None and runner >= af["iou"] - 0.05:
                # the symbol is drawn square like everything else
                north = min(SQUARE, key=lambda t: abs((t - read + 180) % 360 - 180))
        if north is not None and abs((af["rotation"] - north + 180) % 360 - 180) > 1:
            re = fit_building(am, geom, angles=[north], ratio=pinned)
            # Turning the sheet to the stated bearing should cost little --
            # that is what "the footprint cannot decide" means. If it costs a
            # lot, the ring that was read is a detail marker rather than a
            # north symbol, and the match is the better witness: NE4 drops
            # from 0.87 to 0.50 that way, and at 0.50 the drawing is plainly
            # off its building.
            if re and re[0] >= af["iou"] - 0.06:
                iou2, s2, rot2, E2, N2 = re
                s2, ratio2, snapped2 = snap_scale(s2)
                af = {"iou": iou2, "ratio": ratio2, "snapped": snapped2,
                      "rotation": rot2,
                      "placement": {"lng": LNG0 + E2 / M_PER_DEG_LNG,
                                    "lat": LAT0 + N2 / M_PER_DEG_LAT,
                                    "widthM": s2 * am.shape[1],
                                    "rotation": rot2}}
            elif re:
                print(f"       {b}: north {north:.0f} rejected "
                      f"({re[0]:.2f} vs {af['iou']:.2f}); keeping the match")
                north = None
        frame = to_page_frame(af["placement"], am.shape[1], am.shape[0],
                              frames[anchor]["crop"])

        out, notes = {}, {}
        for stem in sheets[b]:
            if stem not in wanted or stem not in masks:
                continue
            m = index[stem]
            prop = from_page_frame(frame, m["width"], m["height"],
                                   frames[stem]["crop"])
            # Every sheet keeps the building's page frame. Matching a sheet
            # on its own looks tempting where its fitted scale disagrees,
            # but that disagreement is the artefact this whole approach
            # exists to avoid: a floor smaller than the footprint gets blown
            # up to fill it. Trusting those solo fits put NE4's second floor
            # eighty degrees off its own ground floor. A sheet genuinely on
            # another frame shows up as poor coverage and is flagged for a
            # human instead.
            own = fits.get(stem)
            out[stem] = prop
            notes[stem] = {"coverage": round(coverage(masks[stem], geom, prop), 3),
                           "ownIou": round(own["iou"], 3) if own else None,
                           "ownRatio": round(own["ratio"], 1) if own else None}

        ambiguous = runner >= af["iou"] - 0.05
        results[b] = {
            "anchor": anchor, "iou": round(af["iou"], 4),
            "ratio": round(af["ratio"], 1), "snapped": af["snapped"],
            "rotation": round(af["rotation"], 2),
            "runnerUpIou": round(runner, 4), "ambiguousAngle": ambiguous,
            "northUsed": None if north is None else round(float(north), 1),
            "placements": out, "notes": notes,
        }
        if args.diag:
            draw_overlay(anchor, af["placement"], geom,
                         os.path.join(args.diag, f"{b}.png"),
                         note=f"IoU {af['iou']:.2f} 1:{af['ratio']:.0f} "
                              f"rot {af['rotation']:.0f}")
        flags = []
        if af["iou"] < 0.55:
            flags.append("LOW IoU")
        if ambiguous:
            flags.append("ANGLE AMBIGUOUS")
        if not af["snapped"]:
            flags.append("ODD SCALE")
        worst = min((n["coverage"] for n in notes.values()), default=1.0)
        if worst < 0.85:
            flags.append(f"COVERAGE {worst:.2f}")
        if north is not None and abs((af["rotation"] - north + 180) % 360 - 180) > 8:
            flags.append(f"NORTH SAYS {float(north):.0f}")
        print(f"[fit ] {b:5s} IoU {af['iou']:.3f}  1:{af['ratio']:5.0f}"
              f"{'*' if af['snapped'] else ' '}  rot {af['rotation']:6.1f}  "
              f"{len(out)} sheet(s)  anchor {index[anchor]['floor']}"
              + ("   <-- " + ", ".join(flags) if flags else ""))

    json.dump(results, open(args.report, "w", encoding="utf-8"), indent=1)
    print(f"\nreport -> {args.report}")

    if args.write:
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z")
        n = 0
        for b, r in results.items():
            for stem, p in r["placements"].items():
                placed[stem] = dict(p, updated=now)
                n += 1
        json.dump(placed, open(PLACEMENTS, "w", encoding="utf-8"), indent=2)
        print(f"{n} placement(s) -> {PLACEMENTS}")
    return 0




# ---------------------------------------------------------------------------
# Diagnostics and overrides
#
# The fit can be confident and still be upside down: a footprint match cannot
# tell a symmetric building from itself turned around, and the north symbol
# is not always readable (some sheets label it with a filled dart and an N
# rather than a triangle on a chord). So every building gets a picture --
# the sheet laid on its footprint, north up -- and anything the eye rejects
# is corrected in overrides.json rather than by fudging the fitter.
# ---------------------------------------------------------------------------
OVERRIDES = os.path.join(os.path.dirname(__file__), "alignment_overrides.json")


def load_overrides():
    if os.path.exists(OVERRIDES):
        return json.load(open(OVERRIDES, encoding="utf-8"))
    return {}


def draw_overlay(stem, p, geom, path, res=0.32, note=""):
    """The whole sheet, warped onto the map, with the footprint outlined.

    The sheet's own north symbol comes round with it, so a correct placement
    is one where the outlines agree *and* that symbol points up the page.
    """
    im = cv2.imread(os.path.join(IMG_DIR, stem + ".png"), cv2.IMREAD_GRAYSCALE)
    if im is None:
        return None
    H, W = im.shape
    s = p["widthM"] / W
    minx, miny, maxx, maxy = geom.bounds
    pad = 0.30 * max(maxx - minx, maxy - miny) + 20
    minx -= pad; miny -= pad; maxx += pad; maxy += pad
    ow, oh = int((maxx - minx) / res), int((maxy - miny) / res)
    if ow * oh > 40_000_000:
        return None
    th = math.radians(p["rotation"])
    c, sn = math.cos(th), math.sin(th)
    f = s / res
    E = (p["lng"] - LNG0) * M_PER_DEG_LNG
    N = (p["lat"] - LAT0) * M_PER_DEG_LAT
    M = np.array([[f * c, f * sn, 0.0], [f * sn, -f * c, 0.0]])
    M[0, 2] = (E - minx) / res - (M[0, 0] * W / 2 + M[0, 1] * H / 2)
    M[1, 2] = (maxy - N) / res - (M[1, 0] * W / 2 + M[1, 1] * H / 2)
    vis = cv2.cvtColor(cv2.warpAffine(im, M, (ow, oh), flags=cv2.INTER_AREA,
                                      borderValue=255), cv2.COLOR_GRAY2BGR)
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    for poly in polys:
        pts = np.array([[(x - minx) / res, (maxy - y) / res]
                        for x, y in poly.exterior.coords], np.int32)
        cv2.polylines(vis, [pts], True, (0, 0, 235), max(2, int(0.9 / res)))
    g = 820 / max(vis.shape[:2])
    if g < 1:
        vis = cv2.resize(vis, (0, 0), fx=g, fy=g, interpolation=cv2.INTER_AREA)
    cv2.putText(vis, f"{stem}  {note}", (10, 26), cv2.FONT_HERSHEY_SIMPLEX,
                0.62, (190, 60, 0), 2)
    h2, w2 = vis.shape[:2]
    cv2.arrowedLine(vis, (w2 - 28, 76), (w2 - 28, 24), (190, 60, 0), 3,
                    tipLength=0.45)
    cv2.imwrite(path, vis)
    return path


if __name__ == "__main__":
    sys.exit(main())
