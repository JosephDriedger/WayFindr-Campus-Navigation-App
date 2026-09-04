"""
Systematic audit of every floor-coordinates geojson: flags floors with
significant room-to-room overlap (a real floor plan should have ~none) and
reports how "busy" each floor is, so problems can be found and prioritized
instead of caught one screenshot at a time.

Usage: py -3 floorPlans/validate_rooms.py [public/data/floor-coordinates]
"""
import sys, os, json, glob
from shapely.geometry import Polygon
from shapely.strtree import STRtree

def load_rooms(path):
    fc = json.load(open(path, encoding="utf-8"))
    polys = []
    for feat in fc.get("features", []):
        if feat["geometry"]["type"] != "Polygon":
            continue
        ring = feat["geometry"]["coordinates"][0]
        if len(ring) < 4:
            continue
        try:
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty or poly.area == 0:
                continue
        except Exception:
            continue
        polys.append((feat["properties"].get("room"), poly))
    return polys


def audit_floor(path):
    rooms = load_rooms(path)
    if len(rooms) < 2:
        return {"n_rooms": len(rooms), "overlap_pairs": 0, "worst_overlap_frac": 0.0, "total_overlap_area_frac": 0.0}

    polys = [p for _, p in rooms]
    tree = STRtree(polys)
    total_area = sum(p.area for p in polys)
    overlap_pairs = 0
    total_overlap_area = 0.0
    worst_frac = 0.0
    seen = set()

    for i, (name_a, pa) in enumerate(rooms):
        for j in tree.query(pa):
            j = int(j)
            if j <= i:
                continue
            key = (i, j)
            if key in seen:
                continue
            seen.add(key)
            name_b, pb = rooms[j]
            if not pa.intersects(pb):
                continue
            inter = pa.intersection(pb).area
            if inter <= 0:
                continue
            smaller = min(pa.area, pb.area)
            frac = inter / smaller if smaller > 0 else 0
            if frac < 0.05:  # ignore trivial edge-touching overlap
                continue
            overlap_pairs += 1
            total_overlap_area += inter
            worst_frac = max(worst_frac, frac)

    return {
        "n_rooms": len(rooms),
        "overlap_pairs": overlap_pairs,
        "worst_overlap_frac": round(worst_frac, 3),
        "total_overlap_area_frac": round(total_overlap_area / total_area, 3) if total_area else 0.0,
    }


def main():
    src_dir = sys.argv[1] if len(sys.argv) > 1 else "public/data/floor-coordinates"
    results = []
    for path in sorted(glob.glob(os.path.join(src_dir, "*.geojson"))):
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            stats = audit_floor(path)
        except Exception as e:
            stats = {"error": str(e)}
        stats["floor"] = name
        results.append(stats)

    bad = [r for r in results if r.get("overlap_pairs", 0) > 0]
    bad.sort(key=lambda r: -r.get("total_overlap_area_frac", 0))

    print(f"{len(results)} floors checked, {len(bad)} have room-to-room overlap\n")
    print(f"{'floor':<20}{'rooms':>7}{'pairs':>7}{'worst%':>9}{'total%':>9}")
    for r in bad:
        print(f"{r['floor']:<20}{r.get('n_rooms',0):>7}{r.get('overlap_pairs',0):>7}"
              f"{r.get('worst_overlap_frac',0)*100:>8.1f}%{r.get('total_overlap_area_frac',0)*100:>8.1f}%")

    with open(os.path.join(os.path.dirname(src_dir) if False else "floorPlans", "overlap_audit.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nfull report -> floorPlans/overlap_audit.json")


if __name__ == "__main__":
    main()
