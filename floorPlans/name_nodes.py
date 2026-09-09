"""
Give every walking node a name that says where it is.

A node used to be called "Node 412" -- a number counted off whatever order the
file happened to be in, which changed whenever anything before it was deleted
and meant nothing on the map. You could not look at a dot and a row in the
list and tell they were the same thing.

So a node is named after somewhere instead: the building it stands in, then
the room it serves. SW3-1615 is the form the search box and the deep links
have always used, so it is the form somebody already reads without being told.
A node in no room -- in a corridor, or on a path across the campus -- takes its
floor and the next free number, marked H: SW3-2H1 is the first unassigned node
on floor 2 of SW3, and one standing outside every building, on no storey at
all, is OUT-H1. A room with two doors has two nodes in it and they cannot both
be SW3-1615, so the second is SW3-1615-2.

The floor is there because it is the first thing you need to know about a
corridor node and the only thing its name could not otherwise tell you: a room
number carries its own floor here (1602 is floor 1, 2690 is floor 2) and a bare
count carries nothing. It also means each floor counts from one.

The H keeps the two forms apart. Room numbers are digits, so without it SW3-1
and SW3-1602 are the same shape of name and there is no telling by looking
whether a node sits in room 1 or is simply the first unassigned node in SW3.

Nodes that already have a name are left exactly as they are, unless --rename
is given: a name that was typed by somebody is not this script's to overwrite.

The tracer does the same thing on a button for nodes placed since; this is the
batch version, for the network as it stands.

Standing within a building's footprint is not the same as being in the
building. A path across the campus runs right past the wall, and part of a
traced floor is often nothing but the space between the rooms -- so a node
inside SW3's outline but inside none of SW3's rooms, corridors or stairwells
is not somewhere in SW3, and is named OUT-H1 rather than SW3-2H4. The test is
only asked where it can be answered: a car park has no traced shapes and never
will, so a node in one is in the lot it says it is in.

Usage: py -3 floorPlans/name_nodes.py [network.geojson] [floors_dir]
                                      [--dry-run] [--rename] [--rooms]
"""
import sys, os, json, glob, shutil, datetime
from collections import Counter, defaultdict

SRC_DEFAULT = "public/data/walking-network.geojson"
FLOORS_DEFAULT = "public/data/floor-coordinates"

# What a node standing in no building at all is named after. It is not a
# building, so it cannot borrow one's code.
OUTDOOR_PREFIX = "OUT"

# What marks a name as a count rather than a room, inside a building: H, for
# the hallway or corridor such a node almost always stands in.
#
# Only where there are hallways to stand in, and room numbers to be confused
# with. Outdoors has neither -- there is no corridor across the grass, and no
# room number for OUT-5 to be mistaken for -- so out there a count is just a
# count. The same goes for a car park.
SPARE_MARK = "H"


def place_is_marked(prefix, shapes):
    """Does this place have floors, and so hallways and room numbers?"""
    if prefix == OUTDOOR_PREFIX:
        return False
    return any(k[0] == prefix.upper() for k in shapes)


def floor_mark(props):
    """The floor written into a spare name, or nothing for no storey."""
    floor = props.get("floor")
    return "" if floor is None or floor == "" else str(floor)


def rings_of(feat):
    """Every outer ring of a feature, whichever kind of polygon it is."""
    geom = feat.get("geometry") or {}
    if geom.get("type") == "Polygon":
        return [geom["coordinates"][0]]
    if geom.get("type") == "MultiPolygon":
        return [poly[0] for poly in geom["coordinates"]]
    return []


def contains(ring, x, y):
    """Even-odd point-in-polygon."""
    inside = False
    for i in range(len(ring)):
        ax, ay = ring[i - 1][0], ring[i - 1][1]
        bx, by = ring[i][0], ring[i][1]
        if (by > y) != (ay > y) and x < (ax - bx) * (y - by) / (ay - by) + bx:
            inside = not inside
    return inside


def read_shapes(floors_dir):
    """Every traced outline, by (BUILDING, floor).

    The building's own boundary is left out: everything on the floor is inside
    it, so it would answer "is this node in a space" with yes for the whole
    site.
    """
    shapes = defaultdict(list)
    for path in sorted(glob.glob(os.path.join(floors_dir, "*.geojson"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        building, _, floor = stem.partition("-Floor")
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        for feat in data.get("features") or []:
            kind = (feat.get("properties") or {}).get("type")
            if not kind or kind == "building":
                continue
            for ring in rings_of(feat):
                shapes[(building.upper(), floor)].append(ring)
    return shapes


def inside_a_shape(props, at, shapes):
    """Is this node standing in a room, a corridor, a stairwell -- anything?

    A node on a floor of its own can only be held by that floor's outlines.
    One on no floor is answered by any storey of the building, because a node
    at a door belongs to whichever it opens onto.
    """
    floor = floor_mark(props)
    # A node on no storey is on nobody's floor plan, so no floor plan holds
    # it. These are the ones placed while another building's sheet was open --
    # the paths that run across the campus and past the wall -- and clipping
    # the edge of a corridor three floors up by half a metre is not being in
    # that corridor.
    if not floor:
        return False
    building = str(props.get("building") or "").upper()
    x, y = at
    return any(contains(ring, x, y)
               for ring in shapes.get((building, floor), ()))


def ring_area(ring):
    a = 0.0
    for i in range(len(ring)):
        ax, ay = ring[i - 1][0], ring[i - 1][1]
        bx, by = ring[i][0], ring[i][1]
        a += (ax + bx) * (ay - by)
    return abs(a) / 2


def read_numbered(floors_dir):
    """Outlines that name a room, by (BUILDING, floor).

    What a node is named after when it stands in one. The building outline
    is skipped: everything is inside it, so naming a node after it says
    nothing.
    """
    out = defaultdict(list)
    for path in sorted(glob.glob(os.path.join(floors_dir, "*.geojson"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        building, _, floor = stem.partition("-Floor")
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        for feat in data.get("features") or []:
            p = feat.get("properties") or {}
            if not p.get("room") or p.get("type") in (None, "building"):
                continue
            for ring in rings_of(feat):
                out[(building.upper(), floor)].append(
                    (ring_area(ring), str(p["room"]), ring))
    return out


def room_at(props, at, numbered):
    """The smallest numbered outline this node stands in, on its own floor.

    Smallest wins, so a node inside a room within a wing is named for the
    room. A node on no storey is on no floor plan and gets nothing.
    """
    floor = floor_mark(props)
    if not floor:
        return None
    building = str(props.get("building") or "").upper()
    x, y = at
    holding = [(area, room)
               for area, room, ring in numbered.get((building, floor), ())
               if contains(ring, x, y)]
    return min(holding)[1] if holding else None


def prefix_of(props, at=None, shapes=None):
    """The building, car park, or OUT, that this node's name is built on."""
    place = str(props.get("building") or "").strip()
    if not place:
        return OUTDOOR_PREFIX
    # A node that names a room is in that room by saying so, and a place with
    # nothing traced has no shapes to be inside or outside of.
    if props.get("room") or shapes is None:
        return place
    if not any(k[0] == place.upper() for k in shapes):
        return place
    return place if inside_a_shape(props, at, shapes) else OUTDOOR_PREFIX


def candidates(props, prefix, marked=True):
    """The names this node could take, best first."""
    room = props.get("room")
    if room:
        room = str(room).strip()
        yield f"{prefix}-{room}"
        for i in range(2, 100):
            yield f"{prefix}-{room}-{i}"
    if not marked:
        # nothing here to tell a count apart from, so it is told plainly
        i = 1
        while True:
            yield f"{prefix}-{i}"
            i += 1
    floor = floor_mark(props)
    i = 1
    while True:
        yield f"{prefix}-{floor}{SPARE_MARK}{i}"
        i += 1


def free_name(props, used, prefix, marked=True):
    for name in candidates(props, prefix, marked):
        if name not in used:
            return name
    return None  # unreachable: the numbered run has no end


def body(features, version):
    """One feature per line, the way the server writes it."""
    lines = ",\n".join(json.dumps(f, separators=(",", ":")) for f in features)
    head = '{"type":"FeatureCollection","version":%d,"features":[' % version
    return f"{head}\n{lines}\n]}}\n"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    rename = "--rename" in sys.argv
    # Matching a node to the room it stands in changes more than its name,
    # so it is asked for rather than assumed.
    rooms_too = "--rooms" in sys.argv
    src = args[0] if args else SRC_DEFAULT
    floors_dir = args[1] if len(args) > 1 else FLOORS_DEFAULT

    if not os.path.exists(src):
        print(f"no network at {src}")
        return 1

    shapes = read_shapes(floors_dir)
    numbered = read_numbered(floors_dir)
    print(f"{sum(len(v) for v in shapes.values())} traced outlines "
          f"across {len(shapes)} sheets")

    with open(src, encoding="utf-8") as fh:
        doc = json.load(fh)
    features = doc.get("features") or []
    nodes = [f for f in features
             if (f.get("properties") or {}).get("type") == "node"]
    if not nodes:
        print("no nodes in the network")
        return 1

    # A name already there is a name in use, so a new one cannot collide with
    # it -- unless we are replacing the lot, in which case nothing is spoken
    # for and the numbering comes out dense.
    used = set()
    todo = []
    kept = 0
    for f in nodes:
        props = f["properties"]
        name = props.get("name")
        if name and not rename:
            used.add(str(name))
            kept += 1
        else:
            todo.append(f)

    # Which room each node stands in, before any of them is named -- a name
    # is built out of the room, so a node given its room afterwards would be
    # named for a room it did not have yet. The tracer does this a sheet at a
    # time, because it can only measure against the floor you have open; here
    # every sheet is to hand, so every floor is done at once.
    matched = 0
    if rooms_too:
        for f in nodes:
            props = f["properties"]
            if props.get("room"):
                # A node that already names a room is left alone, even when it
                # stands somewhere else. That is the ordinary way to place one:
                # the node serving 1600 sits in the corridor outside its door,
                # so it stands in the hallway and serves the room. Reading the
                # hallway back over it would replace a room somebody can be
                # routed to with a corridor nobody asks for.
                continue
            at = (f.get("geometry") or {}).get("coordinates") or (0, 0)
            found = room_at(props, at, numbered)
            if found:
                props["room"] = found
                matched += 1

    # Room nodes first: SW3-1615 has to still be free for the node that
    # actually serves 1615, and a numbered node would otherwise have taken it.
    in_rooms = [f for f in todo if (f["properties"].get("room"))]
    spare = [f for f in todo if not (f["properties"].get("room"))]

    named = 0
    changed = 0
    put_outside = 0
    per_place = Counter()
    for f in in_rooms + spare:
        props = f["properties"]
        at = (f.get("geometry") or {}).get("coordinates") or (0, 0)
        prefix = prefix_of(props, at, shapes)
        if prefix == OUTDOOR_PREFIX and props.get("building"):
            put_outside += 1
        name = free_name(props, used, prefix,
                         place_is_marked(prefix, shapes))
        if not name:
            continue
        if props.get("name") != name:
            changed += 1
        props["name"] = name
        used.add(name)
        named += 1
        per_place[prefix] += 1

    # A drawing-only property that had been leaking into the file: which
    # colour a node gets depends on the floor you have open in the tracer,
    # which is not a fact about the node and not something to store.
    zones = 0
    for f in nodes:
        if f["properties"].pop("zone", None) is not None:
            zones += 1

    version = int(doc.get("version") or 0) + 1
    out = body(features, version)

    print(f"{len(nodes)} nodes, {len(features) - len(nodes)} links")
    for place, n in sorted(per_place.items()):
        print(f"  {place:<10} {n}")
    if matched:
        print(f"matched {matched} nodes to the room each stands in")
    print(f"named {named} ({changed} changed), left {kept} already named")
    if put_outside:
        print(f"{put_outside} stand in a building outline but in none of its "
              f"traced shapes, so they are named as outside")
    if zones:
        print(f"dropped a stale 'zone' from {zones} nodes")

    if dry:
        print("dry run - nothing written")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{src}.{stamp}.bak"
    shutil.copyfile(src, backup)
    with open(src, "w", encoding="utf-8", newline="") as fh:
        fh.write(out)
    print(f"wrote {src} at version {version} (backup: {os.path.basename(backup)})")
    print("reload the tracer before saving from it - the version has moved on")
    return 0


if __name__ == "__main__":
    sys.exit(main())
