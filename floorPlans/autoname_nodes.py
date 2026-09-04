"""
Give every unnamed walking node the room it stands in.

A node that names no space is invisible to the router -- it is just a dot on
the floor. Which room a node is in is already implied by where it sits, so
this reads it off the traced outlines rather than making somebody type it a
hundred times.

The smallest containing outline wins, so a node inside a room that sits within
a wing is named for the room. The building outline is skipped entirely, since
everything is inside it and naming a node "the building" says nothing.

The tracer has the same thing on a button; this is the batch version, for
floors that were traced before it existed.

Usage: py -3 floorPlans/autoname_nodes.py [src_dir] [--dry-run]
"""
import sys, os, json, glob, shutil, datetime

SRC_DEFAULT = "public/data/floor-coordinates"
SKIP_OUTLINE_TYPES = {"building"}


def ring_of(feat):
    return feat["geometry"]["coordinates"][0]


def contains(ring, x, y):
    """Even-odd point-in-polygon."""
    inside = False
    for i in range(len(ring)):
        ax, ay = ring[i - 1][0], ring[i - 1][1]
        bx, by = ring[i][0], ring[i][1]
        if (by > y) != (ay > y) and x < (ax - bx) * (y - by) / (ay - by) + bx:
            inside = not inside
    return inside


def area_of(ring):
    a = 0.0
    for i in range(len(ring)):
        ax, ay = ring[i - 1][0], ring[i - 1][1]
        bx, by = ring[i][0], ring[i][1]
        a += (ax + bx) * (ay - by)
    return abs(a) / 2


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    src = args[0] if args else SRC_DEFAULT

    files = sorted(glob.glob(os.path.join(src, "*.geojson")))
    if not files:
        print(f"no floors in {src}")
        return 1

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    total_named = total_outside = total_already = 0

    for path in files:
        fc = json.load(open(path, encoding="utf-8"))
        feats = fc.get("features", [])

        outlines = [
            f for f in feats
            if f.get("geometry", {}).get("type") == "Polygon"
            and (f.get("properties") or {}).get("room")
            and (f["properties"].get("type") or "room") not in SKIP_OUTLINE_TYPES
        ]
        nodes = [
            f for f in feats
            if f.get("geometry", {}).get("type") == "Point"
            and (f.get("properties") or {}).get("type") == "node"
        ]
        if not nodes:
            continue

        named = outside = already = 0
        for n in nodes:
            props = n["properties"]
            if props.get("room"):
                already += 1
                continue
            x, y = n["geometry"]["coordinates"]
            holding = [o for o in outlines if contains(ring_of(o), x, y)]
            if not holding:
                outside += 1
                continue
            holding.sort(key=lambda o: area_of(ring_of(o)))
            props["room"] = holding[0]["properties"]["room"]
            named += 1

        stem = os.path.basename(path)
        print(f"{stem:<22} {named:>4} named  {already:>4} already  {outside:>4} outside any room")
        total_named += named
        total_already += already
        total_outside += outside

        if named and not dry:
            # keep the version being replaced, in case a name looks wrong later
            shutil.copy(path, f"{path}.{stamp}.bak")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(fc, f, indent=2)

    print(f"\n{total_named} named, {total_already} already had a room, "
          f"{total_outside} sit outside any numbered outline")
    if dry:
        print("(dry run -- nothing written)")
    elif total_named:
        print(f"previous versions kept as *.{stamp}.bak")
        print("rebuild search and routing to put these to work")
    return 0


if __name__ == "__main__":
    sys.exit(main())
