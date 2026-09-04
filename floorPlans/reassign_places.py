"""
Give every walking node the place it actually stands in.

A node's building is decided when it is placed or moved, and stored -- working
it out again on every redraw was costing a point-in-polygon test against every
outline on campus for every node, which is what made a large network unusable
to trace. That leaves one job for a one-off pass: nodes placed before a set of
outlines existed. Adding the car parks, for instance, did not retro-fit the
nodes already standing in them, so a lot with a path running through it still
claimed to be outdoors and could not be routed to.

Buildings win over car parks where the two overlap: a node inside SW3 is in
SW3, not in the lot the outline clips.

Usage: py -3 floorPlans/reassign_places.py [--dry-run]
"""
import sys, json, shutil, os
from collections import Counter

NETWORK = "public/data/walking-network.geojson"
CAMPUS = "public/data/bcit-coordinates.geojson"
PARKING = "public/data/parking-lots.geojson"


def rings(geom):
    if not geom:
        return []
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


def places():
    """Every named outline, buildings first."""
    out = []
    for path, key in ((CAMPUS, "BuildingName"), (PARKING, "name")):
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)
        for f in fc.get("features", []):
            name = (f.get("properties") or {}).get(key)
            polys = rings(f.get("geometry"))
            if name and polys:
                out.append((str(name), polys))
    return out


def main():
    dry = "--dry-run" in sys.argv
    where = places()

    with open(NETWORK, encoding="utf-8") as fh:
        fc = json.load(fh)

    moves = Counter()
    changed = 0
    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("type") != "node":
            continue
        pt = feat["geometry"]["coordinates"]
        found = None
        for name, polys in where:
            if any(contains(r, pt) for r in polys):
                found = name
                break
        if found != props.get("building"):
            moves[f'{props.get("building") or "outdoors"} -> {found or "outdoors"}'] += 1
            if not dry:
                props["building"] = found
                # a floor only means something inside a building it was traced on
                if found is None:
                    props["floor"] = None
            changed += 1

    print(f"{changed} node(s) belong somewhere other than they say")
    for move, n in moves.most_common():
        print(f"  {move}: {n}")

    if dry:
        print("(dry run -- nothing written)")
        return
    if not changed:
        return

    shutil.copy2(NETWORK, NETWORK + ".prev")
    with open(NETWORK, "w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[\n')
        fh.write(",\n".join(json.dumps(f) for f in fc["features"]))
        fh.write("\n]}\n")
    print(f"rewrote {NETWORK} (previous kept as {NETWORK}.prev)")


if __name__ == "__main__":
    main()
