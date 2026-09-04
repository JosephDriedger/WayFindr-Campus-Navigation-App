"""
Cross-floor consistency check.

Each floor is geo-referenced independently against the building footprint,
so nothing forces the floors of one building to agree with each other. But
they must: a stairwell, elevator or service shaft occupies the *same*
physical location on every floor it serves. If floor 2's stairs don't land
on floor 1's stairs, at least one of those two floor fits is wrong.

This gives an accuracy signal the per-floor fit residual cannot: residual
only says "the rooms fill the footprint", which a rotated or mirrored fit
can also satisfy.

Reports, per building, how far each vertical feature on one floor sits from
its nearest counterpart on the next floor up, plus how far the floors'
overall centres drift apart.

Usage: py -3 floorPlans/validate_stairs.py [src_dir]
"""
import sys, os, json, glob, math
from collections import defaultdict

R_EARTH = 6378137.0
VERTICAL_TYPES = {"stairs", "elevator", "shaft"}


def lonlat_to_local(lon, lat, lon0, lat0):
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * R_EARTH
    y = math.radians(lat - lat0) * R_EARTH
    return x, y


def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def load_floor(path):
    fc = json.load(open(path, encoding="utf-8"))
    verticals, allpts = [], []
    for f in fc.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") != "Polygon":
            continue
        ring = g["coordinates"][0]
        allpts.extend(ring)
        if (f["properties"].get("type") or "") in VERTICAL_TYPES:
            verticals.append(centroid(ring))
    return verticals, allpts


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "public/data/floor-coordinates"
    by_building = defaultdict(dict)
    for path in glob.glob(os.path.join(src, "*.geojson")):
        name = os.path.splitext(os.path.basename(path))[0]
        if "-Floor" not in name:
            continue
        b, f = name.split("-Floor", 1)
        by_building[b][f] = path

    rows = []
    for b, floors in sorted(by_building.items()):
        keys = sorted(floors, key=lambda k: (len(k), k))
        if len(keys) < 2:
            continue

        data = {}
        for k in keys:
            v, pts = load_floor(floors[k])
            if not pts:
                continue
            lon0, lat0 = centroid(pts)
            data[k] = {
                "verticals": v,
                "center": (lon0, lat0),
                "n_vert": len(v),
            }

        ks = [k for k in keys if k in data]
        if len(ks) < 2:
            continue

        base = ks[0]
        blon, blat = data[base]["center"]

        # A vertical feature detected on BOTH floors must land in the same
        # place. One detected on only one floor says nothing about alignment
        # -- OCR simply missed it on the other sheet -- so matched and
        # unmatched are counted separately rather than blended into one
        # misleading average.
        MATCH_M = 8.0
        matched, unmatched = [], 0
        worst_center = 0.0
        for k in ks[1:]:
            cx, cy = lonlat_to_local(*data[k]["center"], blon, blat)
            worst_center = max(worst_center, math.hypot(cx, cy))

            a = [lonlat_to_local(x, y, blon, blat) for x, y in data[base]["verticals"]]
            bb = [lonlat_to_local(x, y, blon, blat) for x, y in data[k]["verticals"]]
            if not a or not bb:
                unmatched += len(a)
                continue
            for p in a:
                d = min(math.hypot(p[0] - q[0], p[1] - q[1]) for q in bb)
                if d <= MATCH_M:
                    matched.append(d)
                else:
                    unmatched += 1

        med = sorted(matched)[len(matched) // 2] if matched else None
        rows.append({
            "building": b,
            "floors": len(ks),
            "verticals_per_floor": [data[k]["n_vert"] for k in ks],
            "matched": len(matched),
            "unmatched": unmatched,
            "matched_median_m": round(med, 2) if med is not None else None,
            "matched_worst_m": round(max(matched), 2) if matched else None,
            "center_drift_m": round(worst_center, 1),
        })

    rows.sort(key=lambda r: -(r["matched_median_m"] if r["matched_median_m"] is not None else -1))
    print(f"{'building':<10}{'flrs':>5}{'vert/floor':>14}{'matched':>9}{'unmatch':>9}"
          f"{'med off':>10}{'worst off':>11}{'ctr drift':>11}")
    for r in rows:
        vp = ",".join(str(x) for x in r["verticals_per_floor"])
        med = "-" if r["matched_median_m"] is None else f"{r['matched_median_m']}m"
        wor = "-" if r["matched_worst_m"] is None else f"{r['matched_worst_m']}m"
        print(f"{r['building']:<10}{r['floors']:>5}{vp:>14}{r['matched']:>9}{r['unmatched']:>9}"
              f"{med:>10}{wor:>11}{str(r['center_drift_m'])+'m':>11}")

    usable = [r for r in rows if r["matched_median_m"] is not None]
    if usable:
        good = [r for r in usable if r["matched_median_m"] <= 2]
        print(f"\n{len(good)}/{len(usable)} buildings have their shared vertical "
              f"features stacking within 2m across floors")
        tot_m = sum(r["matched"] for r in rows)
        tot_u = sum(r["unmatched"] for r in rows)
        print(f"{tot_m} vertical features matched across floors, {tot_u} seen on only one floor")
    with open("floorPlans/stair_alignment.json", "w") as f:
        json.dump(rows, f, indent=2)
    print("report -> floorPlans/stair_alignment.json")


if __name__ == "__main__":
    main()
