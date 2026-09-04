"""
Alignment check: how much of each floor lands outside its own building.

The per-floor fit residual says the plan outline sits near the footprint
outline. It does NOT say the rooms ended up inside the building -- a fit
turned 180 degrees, or scaled slightly large, scores a fine residual while
putting rooms in the street. This measures the thing that actually matters:
the share of room area that falls outside the real footprint.

It is the check that caught two live bugs:
  * ten buildings (NE3, NE4, NE20, NW3, SW10-SW15) are stored as
    MultiPolygon in bcit-coordinates.geojson, and the extractor read
    Polygon only -- so it believed they had no footprint and placed them
    approximately;
  * NE12's fit was rotated a couple of degrees, pushing 42% of its ground
    floor outside the building.

Buildings with no footprint on file are reported separately: their
placement can't be measured this way, and scoring them as 100% wrong would
bury the floors that really are misfitted.

Usage: py -3 floorPlans/validate_alignment.py [src_dir]
"""
import sys, os, json, glob, math
from collections import defaultdict

from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

R_EARTH = 6378137.0
FOOTPRINT_SLACK_M = 2.0   # eaves, wall thickness, footprint digitising error
BAD_PCT = 15.0


def lonlat_to_local(lon, lat, lon0, lat0):
    return (math.radians(lon - lon0) * math.cos(math.radians(lat0)) * R_EARTH,
            math.radians(lat - lat0) * R_EARTH)


def load_footprints():
    """building -> list of exterior rings, reading Polygon AND MultiPolygon."""
    coords = json.load(open("public/data/bcit-coordinates.geojson", encoding="utf-8"))
    out = defaultdict(list)
    for f in coords.get("features", []):
        name = (f["properties"].get("BuildingName") or "").strip().upper()
        geom = f.get("geometry") or {}
        if not name or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        g = shape(geom)
        parts = g.geoms if g.geom_type == "MultiPolygon" else [g]
        out[name].extend(list(p.exterior.coords) for p in parts)
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "public/data/floor-coordinates"
    foot = load_footprints()

    rows, no_footprint = [], []
    for path in sorted(glob.glob(os.path.join(src, "*.geojson"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if "-Floor" not in stem:
            continue
        building = stem.split("-Floor")[0].upper()
        fc = json.load(open(path, encoding="utf-8"))
        polys = [f for f in fc.get("features", [])
                 if (f.get("geometry") or {}).get("type") == "Polygon"]
        if not polys:
            continue
        if building not in foot:
            no_footprint.append(stem)
            continue

        pts = [p for f in polys for p in f["geometry"]["coordinates"][0]]
        lon0 = sum(p[0] for p in pts) / len(pts)
        lat0 = sum(p[1] for p in pts) / len(pts)

        fp = unary_union([
            Polygon([lonlat_to_local(x, y, lon0, lat0) for x, y in ring]).buffer(0)
            for ring in foot[building] if len(ring) >= 4
        ]).buffer(FOOTPRINT_SLACK_M)

        total = outside = 0.0
        mostly_out = 0
        for f in polys:
            try:
                g = Polygon([lonlat_to_local(x, y, lon0, lat0)
                             for x, y in f["geometry"]["coordinates"][0]]).buffer(0)
            except Exception:
                continue
            if g.is_empty or g.area <= 0:
                continue
            total += g.area
            o = g.difference(fp).area
            outside += o
            if o > 0.5 * g.area:
                mostly_out += 1
        if total > 0:
            rows.append((stem, 100 * outside / total, mostly_out, len(polys)))

    rows.sort(key=lambda r: -r[1])
    print(f"{'floor':<18}{'% area outside':>15}{'rooms mostly out':>18}{'polys':>7}")
    for stem, pct, mo, n in rows:
        if pct < 1 and len(rows) > 25:
            break
        print(f"{stem:<18}{pct:>15.1f}{mo:>18}{n:>7}")

    bad = [r for r in rows if r[1] > BAD_PCT]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} floors keep at least "
          f"{100 - BAD_PCT:.0f}% of their room area inside the building")
    if bad:
        print(f"misaligned ({len(bad)}): " + ", ".join(r[0] for r in bad))
    if no_footprint:
        print(f"\nno footprint on file, alignment not measurable "
              f"({len(no_footprint)}): " + ", ".join(no_footprint))

    with open("floorPlans/alignment_audit.json", "w", encoding="utf-8") as f:
        json.dump({"floors": [{"floor": s, "pct_area_outside": round(p, 2),
                               "rooms_mostly_outside": m, "polygons": n}
                              for s, p, m, n in rows],
                   "no_footprint": no_footprint}, f, indent=2)
    print("report -> floorPlans/alignment_audit.json")


if __name__ == "__main__":
    main()
