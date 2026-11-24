"""
Score every floor-plan placement against its building footprint.

Two numbers per sheet:

  IoU       how much the drawing and the footprint agree overall. High only
            when the drawing really is the whole building, so a ground floor
            should score well and a small top floor should not.

  inside    the share of the drawing that lands within the footprint. This is
            the one that matters for an upper floor: it cannot fill the
            outline, but it should still be within one.

Usage: py -3 floorPlans/audit_placements.py [--json OUT]
"""
import os, sys, json, math, argparse

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import align_placements as A

RES = 0.5


def score(stem, p, geom):
    mask = A.building_mask(stem)
    if mask is None or not mask.any():
        return None
    H, W = mask.shape
    s = p["widthM"] / W
    target, (minx, maxy) = A.rasterise(geom, RES, 60.0)
    th = math.radians(p["rotation"])
    c, sn = math.cos(th), math.sin(th)
    f = s / RES
    E = (p["lng"] - A.LNG0) * A.M_PER_DEG_LNG
    N = (p["lat"] - A.LAT0) * A.M_PER_DEG_LAT
    M = np.array([[f * c, f * sn, 0.0], [f * sn, -f * c, 0.0]])
    M[0, 2] = (E - minx) / RES - (M[0, 0] * W / 2 + M[0, 1] * H / 2)
    M[1, 2] = (maxy - N) / RES - (M[1, 0] * W / 2 + M[1, 1] * H / 2)
    mv = cv2.warpAffine(mask, M, (target.shape[1], target.shape[0]),
                        flags=cv2.INTER_NEAREST)
    tot = int(mv.sum())
    if not tot:
        return {"iou": 0.0, "inside": 0.0, "planM2": 0.0,
                "footM2": float(target.sum()) * RES * RES}
    inter = int(np.logical_and(target, mv).sum())
    union = int(target.sum()) + tot - inter
    return {"iou": inter / union, "inside": inter / tot,
            "planM2": tot * RES * RES,
            "footM2": float(target.sum()) * RES * RES,
            "ratio": round(s * A.DPI / 0.0254, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="out")
    args = ap.parse_args()

    index = json.load(open(A.INDEX, encoding="utf-8"))
    placed = json.load(open(A.PLACEMENTS, encoding="utf-8"))
    feet = A.footprints()

    rows, missing = [], []
    for stem in sorted(index):
        b = index[stem]["building"]
        if stem not in placed:
            missing.append(stem)
            continue
        if b not in feet:
            continue
        r = score(stem, placed[stem], feet[b])
        if r:
            rows.append(dict(r, stem=stem, building=b))

    rows.sort(key=lambda r: r["inside"])
    print(f"{'sheet':16s} {'1:N':>6s} {'IoU':>6s} {'inside':>7s} "
          f"{'plan m2':>9s} {'foot m2':>9s}")
    for r in rows:
        flag = "  <-- check" if r["inside"] < 0.80 else ""
        print(f"{r['stem']:16s} {r['ratio']:6.0f} {r['iou']:6.3f} "
              f"{r['inside']:7.3f} {r['planM2']:9.0f} {r['footM2']:9.0f}{flag}")
    ins = [r["inside"] for r in rows]
    print(f"\n{len(rows)} placed sheets; inside: median "
          f"{sorted(ins)[len(ins)//2]:.3f}, "
          f"{sum(1 for v in ins if v >= 0.9)} at 0.90+, "
          f"{sum(1 for v in ins if v < 0.8)} below 0.80")
    if missing:
        print(f"unplaced: {', '.join(missing)}")
    if args.out:
        json.dump(rows, open(args.out, "w", encoding="utf-8"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
