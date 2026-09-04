"""
Move the walking network out of the floor plan sheets.

The network was stored inside whichever floor sheet it was drawn on, so every
node in it inherited that sheet's building and floor from the file name. That
is fine while you are tracing one floor and wrong the moment you walk outside:
paths across the campus, and the nodes at the door of every other building,
were all labelled as being on floor 1 of SW3 -- which is why routing to SW7
reported that SW7 had no nodes while a traced path ran right up to it.

The network is one campus-wide thing and now lives in one campus-wide file, in
world coordinates, with each node saying for itself which building it is in --
read from the campus outlines, so a node is in SW7 because it stands in SW7,
not because of the file it happens to be in. A node outside every building is
outdoors, and says so by naming no building at all.

Usage: py -3 floorPlans/split_network.py [--dry-run]
"""
import sys, os, json, glob, shutil

FLOOR_DIR = "public/data/floor-coordinates"
CAMPUS = "public/data/bcit-coordinates.geojson"
NETWORK = "public/data/walking-network.geojson"

NETWORK_TYPES = {"node", "path"}


def rings(geom):
    """Every outer ring of a polygon or multipolygon."""
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [poly[0] for poly in geom["coordinates"]]
    return []


def contains(ring, pt):
    x, y = pt
    inside = False
    for i in range(len(ring)):
        j = (i - 1) % len(ring)
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


def load_campus():
    """The named building footprints, biggest last so the smallest wins."""
    with open(CAMPUS, encoding="utf-8") as fh:
        fc = json.load(fh)
    out = []
    for f in fc["features"]:
        name = (f.get("properties") or {}).get("BuildingName")
        if name:
            out.append((str(name), rings(f["geometry"])))
    return out


def building_at(campus, pt):
    for name, polys in campus:
        if any(contains(r, pt) for r in polys):
            return name
    return None


def main():
    dry = "--dry-run" in sys.argv
    campus = load_campus()

    nodes, links = [], []
    touched = {}
    stats = {"indoor": 0, "outdoor": 0, "moved": 0}

    for path in sorted(glob.glob(os.path.join(FLOOR_DIR, "*.geojson"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        sheet_building, sheet_floor = (stem.split("-Floor", 1) + [None])[:2] \
            if "-Floor" in stem else (stem, None)

        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)

        keep = []
        for feat in fc.get("features", []):
            props = feat.get("properties") or {}
            kind = props.get("type")
            if kind not in NETWORK_TYPES:
                keep.append(feat)
                continue

            if kind == "path":
                links.append({
                    "type": "Feature",
                    "properties": {"type": "path", "nodes": props.get("nodes")},
                    "geometry": feat["geometry"],
                })
                continue

            # Where the node really is, rather than which file it was in.
            here = building_at(campus, feat["geometry"]["coordinates"])
            # It keeps the sheet's floor only if it is inside that sheet's own
            # building; anywhere else there is no floor to speak of.
            floor = sheet_floor if here and here == sheet_building else None
            if here:
                stats["indoor"] += 1
            else:
                stats["outdoor"] += 1
            if here != sheet_building:
                stats["moved"] += 1

            nodes.append({
                "type": "Feature",
                "properties": {
                    "type": "node",
                    "nid": props.get("nid"),
                    "building": here,
                    "floor": floor,
                    "room": props.get("room"),
                },
                "geometry": feat["geometry"],
            })

        if len(keep) != len(fc.get("features", [])):
            touched[path] = {**fc, "features": keep}

    print(f"{len(nodes)} nodes, {len(links)} links pulled out of "
          f"{len(touched)} sheet(s)")
    print(f"  {stats['indoor']} inside a building, {stats['outdoor']} outdoors")
    print(f"  {stats['moved']} were labelled with a building they are not in")

    from collections import Counter
    where = Counter((n["properties"]["building"] or "outdoors") for n in nodes)
    for name, count in where.most_common():
        print(f"    {name}: {count}")

    if dry:
        print("(dry run -- nothing written)")
        return

    for path, fc in touched.items():
        if not os.path.exists(path + ".bak"):
            shutil.copy2(path, path + ".bak")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(fc, fh, indent=2)

    with open(NETWORK, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": nodes + links}, fh, indent=1)
    print(f"wrote {NETWORK}")


if __name__ == "__main__":
    main()
