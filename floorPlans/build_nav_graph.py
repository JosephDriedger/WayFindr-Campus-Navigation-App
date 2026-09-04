"""
Build the campus walking network from the traced nodes and links.

The graph is what somebody drew and nothing else: nodes where you can stand,
links where you can walk between them. Every edge exists because a person put
it there.

Rooms are not part of it. A room is a label carried by the node that serves
it, so "route me to 1750" means "route me to a node that says it serves 1750".
This used to work the other way round -- a node was invented at each room's
centroid and attached to whatever walkable thing was nearest -- which made
every room a graph dependency and routed people through walls to reach rooms
nobody had put a node in. A room with no node is now simply not reachable, and
this says which ones those are, instead of guessing.

Buildings and floors are labels too. There is one graph for the whole campus,
so a link between two buildings, or from a building out to a path across the
lawn, is just a link: nothing happens at a threshold. Outdoor nodes need no
building at all.

What is inferred, rather than drawn, is limited to one thing and reported:
nodes standing in the same stairwell on different floors of a building are
joined, because floors are traced one sheet at a time and there is nowhere to
draw the step between them.

Output: public/data/nav-graph.json
  { "generated": iso8601,
    "nodes": [{nid, building, floor, room, name, space, lng, lat}, ...],
    "edges": [[i, j, metres], ...],
    "buildings": {"SW3": {"nodes": N, "floors": [...]}},
    "unreachableRooms": {"SW3": ["1950", ...]},
    "components": N }

Usage: py -3 floorPlans/build_nav_graph.py [src_dir] [out_path]
"""
import sys, os, json, glob, math, datetime
from collections import defaultdict

R_EARTH = 6378137.0

NODE_TYPE = "node"
PATH_TYPE = "path"

# Cost of stepping between floors in the same stairwell. Not a distance --
# a flight of stairs is slower than the metre or two it covers on the plan.
FLOOR_CHANGE_M = 15.0

# A room is the only thing anyone is routed to, so a room is the only thing
# worth reporting as unreachable. A hallway, a stairwell and a service
# cupboard are all parts of the floor you pass through.
DESTINATION_TYPE = "room"
VERTICAL_SPACES = {"stairs", "elevator"}

# What to call the part of the network that is not in any building. It is not
# a building, so it is not counted as one -- but it is worth seeing.
OUTDOORS = "(outdoors)"


def metres(a, b):
    """Great-circle distance between two [lng, lat] points."""
    lon1, lat1 = a
    lon2, lat2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def floor_files(src):
    """Every traced sheet, as (building, floor, path).

    A file named BUILDING-FloorN is that floor of that building. Anything else
    is taken as a network with no floor -- which is how an outdoor path across
    the campus gets in, once there is a way to trace one.
    """
    out = []
    for path in sorted(glob.glob(os.path.join(src, "*.geojson"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        if "-Floor" in stem:
            building, floor = stem.split("-Floor", 1)
        else:
            building, floor = stem, None
        out.append((building, floor, path))
    return out


def read_sheet(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as err:
        print(f"  ! could not read {os.path.basename(path)}: {err}")
        return {}


def read_network(path):
    """The campus walking network: every node and every link, in one place.

    Kept apart from the floor sheets because it is not part of any one of
    them. A path across the campus belongs to no floor, and a node at the door
    of SW7 belongs to SW7 -- neither is a fact about the sheet somebody
    happened to be tracing at the time.
    """
    if not os.path.exists(path):
        return [], []
    data = read_sheet(path)
    nodes, links = [], []
    for f in data.get("features") or []:
        props = f.get("properties") or {}
        geom = f.get("geometry") or {}
        if props.get("type") == NODE_TYPE and geom.get("type") == "Point":
            nodes.append((props, geom["coordinates"]))
        elif props.get("type") == PATH_TYPE:
            pair = props.get("nodes") or []
            if len(pair) == 2:
                links.append((pair[0], pair[1], props.get("metres")))
    return nodes, links


def collect(src, network_path):
    """The nodes, the links between them, and what each room is called."""
    nodes = []           # in file order; index is the graph id
    by_nid = {}
    links = []           # (nid_a, nid_b, metres or None)
    labels = {}          # (building, floor, room) -> {"name": ..., "space": ...}
    rooms_seen = defaultdict(set)   # building -> room numbers worth reaching

    # The network first, since that is where it lives now.
    net_nodes, net_links = read_network(network_path)
    for props, (lng, lat) in net_nodes:
        nid = props.get("nid")
        if not nid or nid in by_nid:
            continue
        by_nid[nid] = len(nodes)
        nodes.append({
            "nid": nid,
            # a node says which building it is in; no building means outdoors
            "building": props.get("building") or None,
            "floor": props.get("floor") or None,
            "room": str(props["room"]) if props.get("room") else None,
            "lng": round(float(lng), 7),
            "lat": round(float(lat), 7),
        })
    links.extend(net_links)

    for building, floor, path in floor_files(src):
        data = read_sheet(path)
        feats = data.get("features") or []

        # What each space is called and what kind it is. This is the node's
        # label, not a graph edge -- nothing here can connect anything.
        for f in feats:
            props = f.get("properties") or {}
            room = props.get("room")
            kind = props.get("type") or "room"
            if not room or f.get("geometry", {}).get("type") != "Polygon":
                continue
            entry = labels.setdefault((building, floor, str(room)), {})
            if props.get("name"):
                entry.setdefault("name", str(props["name"]).strip())
            entry.setdefault("space", kind)
            if kind == DESTINATION_TYPE:
                rooms_seen[building].add(str(room))

        # A sheet traced before the network was separated still carries its
        # own nodes; they are read so nothing is lost, and take the sheet's
        # building and floor as they always did.
        for f in feats:
            props = f.get("properties") or {}
            geom = f.get("geometry") or {}
            if geom.get("type") == "Point" and props.get("type") == NODE_TYPE:
                nid = props.get("nid")
                if not nid or nid in by_nid:
                    continue
                lng, lat = geom["coordinates"]
                by_nid[nid] = len(nodes)
                nodes.append({
                    "nid": nid,
                    "building": building,
                    "floor": floor,
                    "room": str(props["room"]) if props.get("room") else None,
                    "lng": round(float(lng), 7),
                    "lat": round(float(lat), 7),
                })
            elif geom.get("type") == "LineString" and props.get("type") == PATH_TYPE:
                pair = props.get("nodes") or []
                if len(pair) == 2:
                    links.append((pair[0], pair[1], None))

        # Explicit links held outside the features: how a sheet says it joins
        # something on another sheet, in another building or outside entirely.
        for l in data.get("links") or []:
            pair = l.get("nodes") or []
            if len(pair) == 2:
                links.append((pair[0], pair[1], l.get("metres")))

    return nodes, links, labels, rooms_seen, by_nid


def stairwell_links(nodes):
    """Join the same stairwell across floors.

    The only thing here that nobody drew. Floors are traced one sheet at a
    time, so there is no way to draw the step from the bottom of a flight to
    the top of it; nodes standing in the same numbered stairwell of the same
    building, on different floors, are the step.
    """
    wells = defaultdict(list)
    for i, n in enumerate(nodes):
        if n.get("space") in VERTICAL_SPACES and n.get("room"):
            wells[(n["building"], n["room"])].append(i)

    out = []
    for members in wells.values():
        by_floor = defaultdict(list)
        for i in members:
            by_floor[nodes[i]["floor"]].append(i)
        floors = sorted(by_floor, key=lambda f: (f is None, f))
        for a, b in zip(floors, floors[1:]):
            # one step per pair of adjacent floors, from the closest nodes
            best = min(
                ((i, j, metres((nodes[i]["lng"], nodes[i]["lat"]),
                               (nodes[j]["lng"], nodes[j]["lat"])))
                 for i in by_floor[a] for j in by_floor[b]),
                key=lambda t: t[2],
                default=None,
            )
            if best:
                out.append((best[0], best[1]))
    return out


def components(count, adjacency):
    """Islands of the network that cannot reach each other."""
    seen = set()
    groups = []
    for start in range(count):
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            u = stack.pop()
            group.append(u)
            for v in adjacency.get(u, ()):
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        groups.append(group)
    return groups


def build(src, network_path):
    nodes, links, labels, rooms_seen, by_nid = collect(src, network_path)

    # Labels come from the sheet the node sits on, keyed by the room it says
    # it serves -- so a node in the lecture hall knows it is in a lecture hall
    # without the graph ever holding the room itself.
    for n in nodes:
        # the label for the space this node stands in, on its own floor --
        # falling back to any floor of that building, which is what an
        # outdoor node standing at a door needs
        label = labels.get((n["building"], n["floor"], n["room"] or "")) or next(
            (v for (b, _f, r), v in labels.items()
             if b == n["building"] and r == (n["room"] or "")), {})
        if label.get("name"):
            n["name"] = label["name"]
        if label.get("space"):
            n["space"] = label["space"]

    edges = {}
    unknown = 0

    def add(i, j, weight):
        if i == j:
            return
        key = (i, j) if i < j else (j, i)
        if key not in edges or weight < edges[key]:
            edges[key] = weight

    for a, b, given in links:
        i, j = by_nid.get(a), by_nid.get(b)
        if i is None or j is None:
            unknown += 1
            continue
        walk = given if isinstance(given, (int, float)) and given > 0 else metres(
            (nodes[i]["lng"], nodes[i]["lat"]), (nodes[j]["lng"], nodes[j]["lat"]))
        add(i, j, float(walk))

    inferred = stairwell_links(nodes)
    for i, j in inferred:
        add(i, j, FLOOR_CHANGE_M)

    adjacency = defaultdict(set)
    for (i, j) in edges:
        adjacency[i].add(j)
        adjacency[j].add(i)

    served = defaultdict(set)
    for n in nodes:
        if n["room"]:
            served[n["building"]].add(n["room"])
    unreachable = {
        b: sorted(rooms - served.get(b, set()))
        for b, rooms in rooms_seen.items()
        if rooms - served.get(b, set())
    }

    buildings = defaultdict(lambda: {"nodes": 0, "floors": set()})
    for n in nodes:
        entry = buildings[n["building"]]
        entry["nodes"] += 1
        if n["floor"] is not None:
            entry["floors"].add(n["floor"])

    groups = components(len(nodes), adjacency)

    out_nodes = []
    for n in nodes:
        entry = {"nid": n["nid"], "building": n["building"], "floor": n["floor"],
                 "room": n["room"], "lng": n["lng"], "lat": n["lat"]}
        if n.get("name"):
            entry["name"] = n["name"]
        if n.get("space"):
            entry["space"] = n["space"]
        out_nodes.append(entry)

    graph = {
        "generated": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds"),
        "floor_change_penalty_m": FLOOR_CHANGE_M,
        "nodes": out_nodes,
        "edges": [[i, j, round(w, 2)] for (i, j), w in sorted(edges.items())],
        "buildings": {
            (b or OUTDOORS): {"nodes": v["nodes"], "floors": sorted(v["floors"])}
            # outdoors last, and only named buildings are sorted among
            # themselves -- None does not compare with a string
            for b, v in sorted(buildings.items(), key=lambda kv: (kv[0] is None, kv[0] or ""))
        },
        "unreachableRooms": unreachable,
        "components": len(groups),
    }
    return graph, {"unknown": unknown, "inferred": len(inferred), "groups": groups}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "public/data/floor-coordinates"
    out = sys.argv[2] if len(sys.argv) > 2 else "public/data/nav-graph.json"
    network = sys.argv[3] if len(sys.argv) > 3 else "public/data/walking-network.geojson"

    graph, stats = build(src, network)

    with open(out, "w", encoding="utf-8") as fh:
        json.dump(graph, fh, separators=(",", ":"))

    named = [b for b in graph["buildings"] if b != OUTDOORS]
    print(f"{len(graph['nodes'])} nodes, {len(graph['edges'])} links "
          f"across {len(named)} place(s) -> {out}")
    for b, v in graph["buildings"].items():
        if b == OUTDOORS:
            print(f"  {OUTDOORS}: {v['nodes']} nodes on paths between buildings")
            continue
        floors = ", ".join(v["floors"]) or "no floor"
        print(f"  {b}: {v['nodes']} nodes on floor {floors}")

    if stats["inferred"]:
        print(f"  {stats['inferred']} stairwell step(s) inferred between floors")
    if stats["unknown"]:
        print(f"  ! {stats['unknown']} link(s) name a node that does not exist")

    # A network in pieces is the one thing that silently breaks routing, so it
    # is said plainly rather than patched over by joining the nearest points.
    if graph["components"] > 1:
        sizes = sorted((len(g) for g in stats["groups"]), reverse=True)
        print(f"  ! the network is in {graph['components']} disconnected pieces "
              f"({', '.join(str(s) for s in sizes[:6])} nodes) -- "
              f"routes between them are impossible until they are linked")

    for b, rooms in graph["unreachableRooms"].items():
        print(f"  ! {b}: {len(rooms)} room(s) have no node, so nothing can route "
              f"to them: {', '.join(rooms)}")


if __name__ == "__main__":
    main()
