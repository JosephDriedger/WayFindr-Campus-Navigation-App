"""
Join a hand-placed walking network into one connected piece.

Nodes are placed, and links drawn between them, by hand -- and by hand it is
easy to leave two halves of a floor joined to nothing but themselves. That
looks fine on screen and quietly breaks routing: a room in one half cannot
reach a room in the other, and the router falls back to guessing.

This links whatever is left adrift:

  * a node with no links at all is joined to its nearest neighbour;
  * separate pieces of the network are joined by their closest pair.

A link is only drawn where the straight line between the two nodes stays
inside traced space, so it does not cut through a wall. Where no such pair
exists between two pieces -- because nothing has been traced along the way --
the closest pair is used anyway and reported, since a network in pieces is
worse than one optimistic link you can see and delete.

Usage: py -3 floorPlans/autolink_nodes.py [src_dir] [--dry-run]
"""
import sys, os, json, glob, math, shutil, datetime
from collections import defaultdict

from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union

SRC_DEFAULT = "public/data/floor-coordinates"
SKIP_OUTLINE_TYPES = {"building"}
# traced outlines of neighbouring spaces rarely meet exactly; this closes the
# hairline gaps so a link through a shared wall is not rejected on a rounding
WALL_TOLERANCE_DEG = 0.000004  # roughly 0.3 m


def metres(a, b):
    """Ground distance between two lon/lat pairs."""
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6378137 * math.asin(math.sqrt(h))


def components(node_ids, adj):
    seen, out = set(), []
    for start in node_ids:
        if start in seen:
            continue
        stack, comp = [start], []
        seen.add(start)
        while stack:
            n = stack.pop()
            comp.append(n)
            for m in adj[n]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        out.append(comp)
    return out


def process(path, dry):
    fc = json.load(open(path, encoding="utf-8"))
    feats = fc.get("features", [])

    nodes = {}
    for f in feats:
        p = f.get("properties") or {}
        if f.get("geometry", {}).get("type") == "Point" and p.get("type") == "node" and p.get("nid"):
            nodes[p["nid"]] = tuple(f["geometry"]["coordinates"])
    if len(nodes) < 2:
        return None

    adj = defaultdict(set)
    for f in feats:
        p = f.get("properties") or {}
        if p.get("type") != "path":
            continue
        pair = p.get("nodes") or []
        if len(pair) == 2 and pair[0] in nodes and pair[1] in nodes:
            adj[pair[0]].add(pair[1])
            adj[pair[1]].add(pair[0])

    walkable = []
    for f in feats:
        p = f.get("properties") or {}
        if f.get("geometry", {}).get("type") != "Polygon":
            continue
        if (p.get("type") or "room") in SKIP_OUTLINE_TYPES:
            continue
        try:
            poly = Polygon(f["geometry"]["coordinates"][0])
            if poly.is_valid and not poly.is_empty:
                walkable.append(poly)
        except Exception:
            continue
    space = unary_union([p.buffer(WALL_TOLERANCE_DEG) for p in walkable]) if walkable else None

    def clear_run(a, b):
        """Does the straight line between two nodes stay inside traced space?"""
        if space is None:
            return True
        try:
            return space.covers(LineString([nodes[a], nodes[b]]))
        except Exception:
            return False

    added = []

    def link(a, b, forced):
        adj[a].add(b)
        adj[b].add(a)
        added.append((a, b, metres(nodes[a], nodes[b]), forced))

    # 1. nodes with nothing attached at all
    for nid in list(nodes):
        if adj[nid]:
            continue
        others = [o for o in nodes if o != nid]
        clear = [o for o in others if clear_run(nid, o)]
        pool = clear or others
        nearest = min(pool, key=lambda o: metres(nodes[nid], nodes[o]))
        link(nid, nearest, not clear)

    # 2. separate pieces, joined closest-pair first until only one remains
    for _ in range(len(nodes)):
        comps = components(list(nodes), adj)
        if len(comps) <= 1:
            break
        comps.sort(key=len, reverse=True)
        main = set(comps[0])
        best = None
        for comp in comps[1:]:
            for a in comp:
                for b in main:
                    d = metres(nodes[a], nodes[b])
                    ok = clear_run(a, b)
                    # a clear run always beats a shorter one through a wall
                    rank = (0 if ok else 1, d)
                    if best is None or rank < best[0]:
                        best = (rank, a, b, ok)
        if best is None:
            break
        _, a, b, ok = best
        link(a, b, not ok)

    if added and not dry:
        for a, b, _d, _f in added:
            feats.append({
                "type": "Feature",
                "properties": {
                    "room": None,
                    "building": (feats[0].get("properties") or {}).get("building"),
                    "floor": (feats[0].get("properties") or {}).get("floor"),
                    "type": "path", "source": "traced", "nodes": [a, b],
                },
                "geometry": {"type": "LineString",
                             "coordinates": [list(nodes[a]), list(nodes[b])]},
            })
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy(path, f"{path}.{stamp}.bak")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(fc, f, indent=2)

    return added, len(components(list(nodes), adj))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    src = args[0] if args else SRC_DEFAULT

    for path in sorted(glob.glob(os.path.join(src, "*.geojson"))):
        result = process(path, dry)
        if result is None:
            continue
        added, pieces = result
        stem = os.path.basename(path)
        forced = sum(1 for a in added if a[3])
        print(f"{stem}: added {len(added)} link(s), network now in {pieces} piece(s)")
        for a, b, d, f in added:
            note = "  (no traced route -- check this one)" if f else ""
            print(f"    {a} - {b}   {d:.1f} m{note}")
        if forced:
            print(f"  {forced} link(s) could not be drawn through traced space")
    if dry:
        print("\n(dry run -- nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
