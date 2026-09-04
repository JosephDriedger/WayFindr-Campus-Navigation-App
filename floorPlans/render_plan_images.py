"""
Rasterise each floor-plan PDF to a PNG for the tracing tool to sit under the
map.

The admin tracer overlays the drawing on the campus map and lets you trace the
rooms by hand, so the only thing needed from the PDF is a faithful picture --
no segmentation, no OCR, no interpretation. Rendering once up front keeps the
browser out of the PDF business entirely.

Pages are cropped to their ink before saving: BCIT sheets sit inside a wide
title border, and keeping it would mean the useful drawing occupies a fraction
of the overlay and every placement starts by scaling the border off-screen.

Usage: py -3 floorPlans/render_plan_images.py [--zoom 3] [--force] [BUILDING]
Output: public/data/floorplan-images/{CODE}-Floor{N}.png  (+ _index.json)
"""
import sys, os, re, json, glob, argparse

import numpy as np
import fitz  # PyMuPDF

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PDF_DIR = os.path.join(REPO, "public", "data", "floorplans")
OUT_DIR = os.path.join(REPO, "public", "data", "floorplan-images")

WHITE_CUTOFF = 245   # anything lighter than this counts as blank paper
MARGIN_PX = 12


def ink_bbox(pix):
    """Bounding box of the drawn content, or None if the page is blank."""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("building", nargs="?")
    ap.add_argument("--zoom", type=float, default=3.0,
                    help="render scale; 3 gives ~216 dpi, enough to trace from")
    ap.add_argument("--force", action="store_true", help="re-render existing images")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    pattern = f"{args.building}-Floor*.pdf" if args.building else "*-Floor*.pdf"
    pdfs = sorted(glob.glob(os.path.join(PDF_DIR, pattern)))
    if not pdfs:
        print(f"no PDFs matching {pattern} in {PDF_DIR}")
        return 1

    index = {}
    index_path = os.path.join(OUT_DIR, "_index.json")
    if os.path.exists(index_path):
        try:
            index = json.load(open(index_path, encoding="utf-8"))
        except Exception:
            index = {}

    done = skipped = failed = 0
    for pdf in pdfs:
        stem = os.path.splitext(os.path.basename(pdf))[0]
        m = re.match(r"(.+)-Floor(\d+)$", stem)
        if not m:
            continue
        out = os.path.join(OUT_DIR, f"{stem}.png")
        if os.path.exists(out) and not args.force:
            skipped += 1
            continue
        try:
            doc = fitz.open(pdf)
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(args.zoom, args.zoom))
            box = ink_bbox(pix)
            if box:
                x0, y0, x1, y1 = box
                clip = fitz.Rect(x0 / args.zoom, y0 / args.zoom,
                                 (x1 + 1) / args.zoom, (y1 + 1) / args.zoom)
                pix = page.get_pixmap(matrix=fitz.Matrix(args.zoom, args.zoom), clip=clip)
            pix.save(out)
            index[stem] = {
                "building": m.group(1), "floor": m.group(2),
                "image": f"/data/floorplan-images/{stem}.png",
                "width": pix.width, "height": pix.height,
            }
            done += 1
            print(f"[OK] {stem}: {pix.width}x{pix.height}")
            doc.close()
        except Exception as e:
            failed += 1
            print(f"[FAIL] {stem}: {e}")

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, sort_keys=True)
    print(f"\n{done} rendered, {skipped} already present, {failed} failed "
          f"-> {OUT_DIR}")
    print(f"index -> {index_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
