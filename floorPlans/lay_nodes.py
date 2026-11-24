"""Put a walking network on a floor that has none.

A traced floor is a set of shapes, and shapes are not a route. Routing needs
nodes you can stand on and links you can walk along, and until now every one of
those was placed by hand in the tracer -- which is why SW3 and SE12 have a
network between them and the other eighty-odd floors have nothing. A floor with
rooms and no nodes is worse than it sounds: it draws, it searches, and it
cannot be walked to.

What a person draws, drawing it well, is a line down the middle of the corridor
and a dot in each room. That is what this does:

  * the corridors, lobbies and vestibules of the floor are one walkable
    region, and points are laid through the middle of it -- far enough from a
    wall to stand, four metres apart, joined where the straight line between
    two of them stays inside the corridor;
  * every room, stairwell, lift and cupboard gets a node of its own, at a
    point inside itself, joined to the nearest corridor node it can actually
    reach -- which is the node that "route me to 1750" is answered with;
  * what is left in pieces is joined closest-pair first, the way
    autolink_nodes.py joins a hand-drawn floor, and the joins that had to cut
    through a wall are counted and said out loud.

The result is a floor you can route across. It is not a floor somebody
checked: a corridor node sits where the middle of the corridor is, not where
the doorway is, so a route through a room's node turns at its centre rather
than at its door. Every node written here says `source: "auto"`, so a floor
can be re-laid, or the lot deleted, without touching a node anybody placed.

Usage:
    py -3 floorPlans/lay_nodes.py SE6-Floor1
    py -3 floorPlans/lay_nodes.py --all            # every floor with no nodes yet
    py -3 floorPlans/lay_nodes.py --all --relay    # and re-lay the ones it laid
"""
import sys, os, re, json, math, glob, time, shutil, argparse, datetime
from collections import defaultdict, Counter

import numpy as np
import cv2
from shapely.geometry import Polygon, LineString, Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FLOOR_DIR = os.path.join(REPO, "public", "data", "floor-coordinates")
NETWORK = os.path.join(REPO, "public", "data", "walking-network.geojson")

R_EARTH = 6378137.0
M_PER_DEG_LAT = (math.pi / 180) * R_EARTH

# What counts as somewhere to walk rather than somewhere to go. A lobby is a
# corridor with chairs in it; a vestibule is a corridor with a door at each end.
CIRCULATION = {"hallway", "corridor", "lobby", "vestibule"}
# Spaces that are destinations, in the order a route would rather enter them
PLACES = {"room", "service", "stairs", "elevator", "washroom", "shaft"}
# Not a place and not a route: the outline of the building itself
SKIP = {"building", "node", "path"}

STEP_M = 4.0              # how far apart corridor nodes stand
CLEAR_M = 0.55            # how far from a wall a node has to be to stand there
REACH_M = 7.5             # how far a corridor node will look for its neighbour
DOOR_M = 22.0             # how far a room will look for a corridor to join
CELL_M = 0.25             # the raster the middle of the corridor is found on
SLACK_M = 0.35            # traced outlines rarely meet exactly; close the hairlines
TRIED = 8                 # how many nearest pairs a stranded piece asks about


# ---------------------------------------------------------------------------
# A floor, in metres
# ---------------------------------------------------------------------------
class Frame:
    """Lng/lat to metres and back, about a point on this floor.

    Everything here is a distance -- four metres apart, half a metre off the
    wall -- and none of it can be said in degrees, where a metre east and a
    metre north are different numbers. So the floor is flattened about its own
    middle first, which over a building is exact enough to ignore.
    """

    def __init__(self, lng0, lat0):
        self.lng0, self.lat0 = lng0, lat0
        self.ew = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    def to_m(self, lng, lat):
        return ((lng - self.lng0) * self.ew, (lat - self.lat0) * M_PER_DEG_LAT)

    def to_deg(self, x, y):
        return [self.lng0 + x / self.ew, self.lat0 + y / M_PER_DEG_LAT]


def flat(geom, frame):
    """A feature's polygon, in metres, repaired if the tracing left it crossed."""
    try:
        g = shape(geom)
    except Exception:
        return None
    if g.is_empty or g.geom_type not in ("Polygon", "MultiPolygon"):
        return None
    def ring(coords):
        return [frame.to_m(c[0], c[1]) for c in coords]
    try:
        if g.geom_type == "Polygon":
            p = Polygon(ring(g.exterior.coords))
        else:
            p = unary_union([Polygon(ring(q.exterior.coords)) for q in g.geoms])
    except Exception:
        return None
    if not p.is_valid:
        p = p.buffer(0)
    return p if (not p.is_empty and p.area > 0) else None


def read_floor(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def spaces_of(fc, frame):
    """The floor as (properties, polygon in metres), the network left out."""
    out = []
    for f in fc.get("features") or []:
        p = f.get("properties") or {}
        if (p.get("type") or "room") in SKIP:
            continue
        g = flat(f.get("geometry") or {}, frame)
        if g is not None:
            out.append((p, g))
    return out


# ---------------------------------------------------------------------------
# The middle of the corridor
# ---------------------------------------------------------------------------
def spine_points(halls):
    """Standing room down the middle of the walkable region.

    Found on a raster rather than by skeletonising it: what is wanted is not
    the medial axis -- which wanders into every alcove and gives a node to each
    -- but somewhere to stand every few metres, well clear of the walls. A
    distance transform says how clear each quarter-metre of floor is, and the
    clearest cell near each point of a four-metre lattice is where somebody
    would stand.
    """
    x0, y0, x1, y1 = halls.bounds
    W = max(int((x1 - x0) / CELL_M) + 3, 4)
    H = max(int((y1 - y0) / CELL_M) + 3, 4)
    if W * H > 40_000_000:                    # a floor the size of a runway
        return []
    mask = np.zeros((H, W), np.uint8)
    polys = halls.geoms if halls.geom_type == "MultiPolygon" else [halls]
    for q in polys:
        ring = np.array([[(x - x0) / CELL_M + 1, (y - y0) / CELL_M + 1]
                         for x, y in q.exterior.coords], np.int32)
        cv2.fillPoly(mask, [ring], 1)
        for h in q.interiors:
            hole = np.array([[(x - x0) / CELL_M + 1, (y - y0) / CELL_M + 1]
                             for x, y in h.coords], np.int32)
            cv2.fillPoly(mask, [hole], 0)
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5) * CELL_M
    # Far enough from a wall to stand -- but a corridor a metre wide is still a
    # corridor, so the bar drops rather than leaving the floor with no nodes.
    for bar in (CLEAR_M, 0.4, 0.25, 0.0):
        ok = dist > bar
        if ok.any():
            break
    else:
        return []
    pts, step = [], max(int(STEP_M / CELL_M), 1)
    half = step // 2
    for gy in range(1, H, step):
        for gx in range(1, W, step):
            sub = dist[gy:gy + step, gx:gx + step]
            if sub.size == 0 or sub.max() <= bar:
                continue
            iy, ix = np.unravel_index(int(sub.argmax()), sub.shape)
            pts.append((x0 + (gx + ix - 1) * CELL_M, y0 + (gy + iy - 1) * CELL_M))
    # a lattice cell can win twice over, at two corners of the same wide lobby
    kept = []
    for p in pts:
        if all(math.hypot(p[0] - q[0], p[1] - q[1]) > STEP_M * 0.6 for q in kept):
            kept.append(p)
    return kept


def clear_run(space, a, b, through=None):
    """Does the straight line from a to b stay inside walkable space?

    `through` is one more shape the line may pass through -- the room it
    starts in -- and is taken off the line before the rest is asked of the
    corridors.
    """
    try:
        line = LineString([a, b])
        if through is not None:
            line = line.difference(through)
            if line.is_empty:
                return True
        return space.covers(line)
    except Exception:
        return False


def pieces(n, adj):
    seen, out = set(), []
    for s in range(n):
        if s in seen:
            continue
        stack, group = [s], []
        seen.add(s)
        while stack:
            u = stack.pop()
            group.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        out.append(group)
    return out


# ---------------------------------------------------------------------------
# A floor, laid
# ---------------------------------------------------------------------------
_seq = [0]


def new_nid(taken):
    """The tracer's own shape of id, so a laid node and a drawn one look alike."""
    while True:
        _seq[0] += 1
        nid = "n%s%s" % (np.base_repr(int(time.time() * 1000), 36).lower(),
                         np.base_repr(_seq[0], 36).lower())
        if nid not in taken:
            taken.add(nid)
            return nid


def lay(name, fc, taken):
    """Nodes and links for one floor, in lng/lat, ready for the network file."""
    building, _, floor = name.partition("-Floor")
    coords = []
    for f in fc.get("features") or []:
        g = f.get("geometry") or {}
        if g.get("type") == "Polygon" and g.get("coordinates"):
            coords.extend(g["coordinates"][0])
    if not coords:
        return None, "nothing traced"
    frame = Frame(sum(c[0] for c in coords) / len(coords),
                  sum(c[1] for c in coords) / len(coords))

    spaces = spaces_of(fc, frame)
    if not spaces:
        return None, "nothing traced"
    halls = [g for p, g in spaces if (p.get("type") or "room") in CIRCULATION]
    if not halls:
        return None, "no corridor traced, so there is no way through the floor"
    walk = unary_union([g.buffer(SLACK_M / 2) for g in halls])
    # A floor asks "does this line stay inside the corridors?" thousands of
    # times against one unchanging shape, which is exactly what a prepared
    # geometry is for -- it indexes the shape once instead of per question.
    inside = prep(walk)

    pts = spine_points(walk)
    if not pts:
        return None, "the corridors are too thin to stand in"

    nodes = [dict(xy=p, room=None, space=None) for p in pts]
    # a corridor node belongs to the corridor it stands in, so a route can name
    # the hallway it is sending somebody down
    for n in nodes:
        here = Point(n["xy"])
        for p, g in spaces:
            if (p.get("type") or "room") in CIRCULATION and g.covers(here):
                n["room"], n["space"] = p.get("room"), p.get("type")
                break

    adj = defaultdict(set)
    forced = 0

    def link(i, j):
        adj[i].add(j)
        adj[j].add(i)

    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            a, b = nodes[i]["xy"], nodes[j]["xy"]
            if math.hypot(a[0] - b[0], a[1] - b[1]) > REACH_M:
                continue
            if clear_run(inside, a, b):
                link(i, j)

    spine = len(nodes)

    # Every place on the floor gets its own node, joined to the corridor
    for p, g in spaces:
        kind = p.get("type") or "room"
        if kind in CIRCULATION or not p.get("room"):
            continue
        here = g.representative_point()
        xy = (here.x, here.y)
        # The way out of a room runs through the room and then through the
        # corridors, so the part of it inside its own room is taken off and
        # the rest asked of the corridors. Unioning the room into the whole
        # walkable region to ask once would rebuild that region per room, two
        # hundred times a floor.
        room = g.buffer(SLACK_M / 2)
        near = sorted(range(spine),
                      key=lambda k: math.hypot(xy[0] - nodes[k]["xy"][0],
                                               xy[1] - nodes[k]["xy"][1]))
        pick, through = None, False
        for k in near[:30]:
            d = math.hypot(xy[0] - nodes[k]["xy"][0], xy[1] - nodes[k]["xy"][1])
            if d > DOOR_M:
                break
            if clear_run(inside, xy, nodes[k]["xy"], room):
                pick = k
                break
        if pick is None and near:
            pick, through = near[0], True
        if pick is None:
            continue
        nodes.append(dict(xy=xy, room=p.get("room"), space=kind))
        link(len(nodes) - 1, pick)
        forced += through

    # What is still adrift, joined closest pair first -- a floor in two halves
    # looks right and routes wrong.
    #
    # Distance decides which pairs are worth asking about and the corridors
    # decide between those. Asking the corridors about every pair instead is
    # the same answer at a hundred times the cost: a floor can leave fifty
    # pieces behind and each round would then put a quarter of a million
    # line-in-polygon tests through shapely.
    for _ in range(len(nodes)):
        groups = pieces(len(nodes), adj)
        if len(groups) <= 1:
            break
        groups.sort(key=len, reverse=True)
        main, best = groups[0], None
        for grp in groups[1:]:
            pairs = sorted((math.hypot(nodes[a]["xy"][0] - nodes[b]["xy"][0],
                                       nodes[a]["xy"][1] - nodes[b]["xy"][1]), a, b)
                           for a in grp for b in main)
            for d, a, b in pairs[:TRIED]:
                ok = clear_run(inside, nodes[a]["xy"], nodes[b]["xy"])
                rank = (0 if ok else 1, d)
                if best is None or rank < best[0]:
                    best = (rank, a, b, ok)
                if ok:
                    break           # the nearest clear run of this piece
        if best is None:
            break
        _rank, a, b, ok = best
        link(a, b)
        forced += not ok

    for n in nodes:
        n["nid"] = new_nid(taken)

    feats = []
    for n in nodes:
        props = {"type": "node", "nid": n["nid"], "building": building,
                 "floor": floor, "source": "auto"}
        if n["room"]:
            props["room"] = str(n["room"])
            props["name"] = "%s-%s" % (building, n["room"])
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point",
                                   "coordinates": frame.to_deg(*n["xy"])}})
    done = set()
    for i, ns in adj.items():
        for j in ns:
            key = (i, j) if i < j else (j, i)
            if key in done:
                continue
            done.add(key)
            feats.append({
                "type": "Feature",
                "properties": {"type": "path", "source": "auto",
                               "nodes": [nodes[i]["nid"], nodes[j]["nid"]]},
                "geometry": {"type": "LineString",
                             "coordinates": [frame.to_deg(*nodes[i]["xy"]),
                                             frame.to_deg(*nodes[j]["xy"])]}})
    served = sum(1 for n in nodes if n["room"] and n["space"] not in CIRCULATION)
    want = sum(1 for p, _g in spaces
               if p.get("room") and (p.get("type") or "room") not in CIRCULATION)
    return feats, dict(nodes=len(nodes), spine=spine, links=len(done),
                       served=served, rooms=want, forced=forced,
                       pieces=len(pieces(len(nodes), adj)))


# ---------------------------------------------------------------------------
# The campus network
# ---------------------------------------------------------------------------
def load_network():
    if not os.path.exists(NETWORK):
        return {"type": "FeatureCollection", "features": []}
    with open(NETWORK, encoding="utf-8") as fh:
        return json.load(fh)


HAND_NETWORK = 5          # fewer nodes than this is a stray, not a network


def laid_already(net):
    """Which floors already have nodes, and which of those this script laid.

    A floor counts as somebody's only if there are several nodes on it. Three
    buildings carry a single node apiece -- somebody clicked once, years ago,
    and moved on -- and treating that one dot as a network would leave the
    whole building unroutable to protect it.
    """
    drawn, auto = Counter(), set()
    for f in net.get("features") or []:
        p = f.get("properties") or {}
        if p.get("type") != "node":
            continue
        key = (p.get("building"), str(p.get("floor")) if p.get("floor") else None)
        if p.get("source") == "auto":
            auto.add(key)
        else:
            drawn[key] += 1
    return {k for k, v in drawn.items() if v >= HAND_NETWORK}, auto


def strip_auto(net, keys):
    """Take out the nodes this script laid on these floors, and their links."""
    gone = set()
    keep = []
    for f in net["features"]:
        p = f.get("properties") or {}
        key = (p.get("building"), str(p.get("floor")) if p.get("floor") else None)
        if p.get("type") == "node" and p.get("source") == "auto" and key in keys:
            gone.add(p.get("nid"))
            continue
        keep.append(f)
    net["features"] = [f for f in keep
                       if not ((f.get("properties") or {}).get("type") == "path"
                               and set((f["properties"].get("nodes") or [])) & gone)]
    return len(gone)


DOOR_REACH_M = 45.0


def join_campus(net, floors):
    """One link from each ground floor to the paths outside it.

    A floor laid on its own is a network of its own: perfect inside the
    building and reachable from nowhere. Nothing in the drawings says where
    the front door is -- a door in the outer wall is a gap in a line -- so the
    nearest point where the campus paths come to the building is taken for it,
    which is where a door usually is and is at worst a few metres out.

    One per building, on its lowest laid floor, and no second one: this is a
    way in, not a guess at every entrance. Each says `door: true`, so they can
    be found, moved or deleted as a set once somebody walks the campus.
    """
    out, pos, mine = [], {}, defaultdict(list)
    for f in net["features"]:
        p = f.get("properties") or {}
        if p.get("type") != "node" or not p.get("nid"):
            continue
        pos[p["nid"]] = f["geometry"]["coordinates"]
        key = (p.get("building"), str(p.get("floor")) if p.get("floor") else None)
        mine[key].append(p["nid"])
    outside = [n for (b, _f), ns in mine.items() if not b for n in ns]
    if not outside:
        return []

    linked = set()
    for f in net["features"]:
        p = f.get("properties") or {}
        if p.get("type") != "path":
            continue
        a, b = (p.get("nodes") or [None, None])[:2]
        for x, y in ((a, b), (b, a)):
            if x in set(outside) and y in pos:
                linked.add(y)

    lowest = {}
    for building, floor in floors:
        if building not in lowest or (floor or "9") < (lowest[building] or "9"):
            lowest[building] = floor
    for building, floor in sorted(lowest.items()):
        here = mine.get((building, floor)) or []
        if not here or any(n in linked for n in here):
            continue
        best = None
        for a in here:
            for b in outside:
                d = metres(pos[a], pos[b])
                if best is None or d < best[0]:
                    best = (d, a, b)
        if best is None or best[0] > DOOR_REACH_M:
            print("%-14s no campus path within %d m, so it stands on its own"
                  % ("%s-Floor%s" % (building, floor), DOOR_REACH_M))
            continue
        d, a, b = best
        out.append({"type": "Feature",
                    "properties": {"type": "path", "source": "auto", "door": True,
                                   "nodes": [a, b], "metres": round(d, 1)},
                    "geometry": {"type": "LineString",
                                 "coordinates": [pos[a], pos[b]]}})
        print("%-14s joined to the campus paths, %.0f m away"
              % ("%s-Floor%s" % (building, floor), d))
    return out


def metres(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("floors", nargs="*")
    ap.add_argument("--all", action="store_true",
                    help="every traced floor that has no nodes on it yet")
    ap.add_argument("--relay", action="store_true",
                    help="lay a floor again, replacing the nodes this laid before")
    ap.add_argument("--no-doors", action="store_true",
                    help="leave each floor on its own instead of joining it "
                         "to the campus paths at the nearest point")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    net = load_network()
    drawn, auto = laid_already(net)
    taken = {(f.get("properties") or {}).get("nid")
             for f in net["features"] if (f.get("properties") or {}).get("nid")}

    names = list(args.floors)
    if args.all:
        for path in sorted(glob.glob(os.path.join(FLOOR_DIR, "*.geojson"))):
            stem = os.path.splitext(os.path.basename(path))[0]
            if "-Floor" not in stem:
                continue
            building, floor = stem.split("-Floor", 1)
            if (building, floor) in drawn:
                continue
            if (building, floor) in auto and not args.relay:
                continue
            names.append(stem)
    if not names:
        ap.error("name a floor, or pass --all")

    again = set()
    for name in names:
        building, _, floor = name.partition("-Floor")
        if (building, floor) in auto:
            again.add((building, floor))
    if again:
        print("re-laying %d floor(s): %d node(s) removed"
              % (len(again), strip_auto(net, again)))

    added, totals, laid = 0, Counter(), []
    for name in names:
        building, _, floor = name.partition("-Floor")
        if (building, floor) in drawn:
            # Somebody has already walked this floor and put the nodes where
            # the doors are. A second network laid over the top of theirs
            # would not replace it -- it would double it.
            print("%-14s has a network somebody drew, left alone" % name)
            continue
        path = os.path.join(FLOOR_DIR, name + ".geojson")
        if not os.path.exists(path):
            print("%-14s no traced floor" % name)
            continue
        try:
            feats, how = lay(name, read_floor(path), taken)
        except Exception as e:
            print("%-14s failed: %s: %s" % (name, type(e).__name__, e))
            continue
        if feats is None:
            print("%-14s %s" % (name, how))
            continue
        net["features"].extend(feats)
        added += 1
        laid.append((name.partition("-Floor")[0], name.partition("-Floor")[2]))
        for k, v in how.items():
            totals[k] += v
        print("%-14s %3d nodes (%d down the corridors), %3d links, "
              "%d of %d places reachable%s%s"
              % (name, how["nodes"], how["spine"], how["links"], how["served"],
                 how["rooms"],
                 ", %d link(s) cut through a wall" % how["forced"] if how["forced"] else "",
                 ", still in %d pieces" % how["pieces"] if how["pieces"] > 1 else ""))

    doors = join_campus(net, laid) if laid and not args.no_doors else []
    net["features"].extend(doors)

    print("\n%d floor(s) laid: %d nodes, %d links, %d place(s) reachable of %d"
          % (added, totals["nodes"], totals["links"], totals["served"], totals["rooms"]))
    if doors:
        print("%d building(s) joined to the paths outside them" % len(doors))
    if totals["forced"]:
        print("%d link(s) could not be drawn through traced space -- look at these"
              % totals["forced"])
    if args.dry_run:
        print("(dry run -- nothing written)")
        return 0
    if added:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy(NETWORK, "%s.%s.bak" % (NETWORK, stamp))
        with open(NETWORK, "w", encoding="utf-8") as fh:
            json.dump(net, fh, indent=1)
        print("written to %s (previous kept as .%s.bak)"
              % (os.path.relpath(NETWORK, REPO), stamp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
