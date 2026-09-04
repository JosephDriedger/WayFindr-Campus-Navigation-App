"""
Collapse the traced space types onto the five that mean something.

The type field had grown to carry two different ideas at once: what a space
IS (washroom, storage, janitor) and what the app should DO with it (offer it
as a destination, draw it, connect floors through it). Eight types expressed
three behaviours, so every consumer carried its own list of exceptions.

What a space is called it already says in `name` -- "Women's Washroom", "AV
Room", "Janitor" -- so the type is now only the behaviour:

    room      you can be routed to it, and it is drawn
    hallway   drawn or not, never a destination
    stairs    drawn with an icon, connects floors
    elevator  drawn with an icon, connects floors
    service   drawn, never a destination (storage, plant, shafts, cupboards)

A shaft named for an elevator becomes an elevator: it was typed `shaft`, and
because the builder only links floors through stairs and elevators, that lift
could never have connected anything.

Usage: py -3 floorPlans/migrate_types.py [--dry-run] [dir]
"""
import sys, os, json, glob, shutil
from collections import Counter

# Everything that is not one of the five, and what it becomes.
DIRECT = {
    "corridor": "hallway",
    "washroom": "room",     # the name already says it is a washroom
    "storage": "service",
    "mech": "service",
    "elec": "service",
    "plant": "service",
}
KEEP = {"room", "hallway", "stairs", "elevator", "service",
        # markers and the network are a different vocabulary and untouched
        "door", "entrance", "node", "path", "building"}


def retype(props):
    """The new type for one feature, or None to leave it alone."""
    old = props.get("type") or "room"
    if old in DIRECT:
        return DIRECT[old]
    if old == "shaft":
        # a lift you can ride, or the hole it runs in
        name = (props.get("name") or "").lower()
        return "elevator" if ("elevator" in name or "lift" in name) else "service"
    if old in KEEP:
        return None
    # anything unforeseen is a space you can see but are not sent to
    return "service"


# What a room offers, as opposed to what the router does with it. A washroom
# used to be its own type, which conflated the two; the name already says
# which one it is, so this only has to spot that it IS one.
AMENITY_FROM_NAME = [
    ("washroom", ("washroom", "restroom", "toilet", "lavatory")),
]


def amenity_for(props):
    """The amenity a room advertises, read from what it is called."""
    if (props.get("type") or "room") != "room":
        return None
    name = (props.get("name") or "").lower()
    for amenity, words in AMENITY_FROM_NAME:
        if any(w in name for w in words):
            return amenity
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    src = args[0] if args else "public/data/floor-coordinates"

    moves = Counter()
    for path in sorted(glob.glob(os.path.join(src, "*.geojson"))):
        with open(path, encoding="utf-8") as fh:
            fc = json.load(fh)

        changed = 0
        for feat in fc.get("features", []):
            props = feat.get("properties") or {}
            new = retype(props)
            if new and new != props.get("type"):
                moves[f'{props.get("type")} -> {new}'] += 1
                props["type"] = new
                changed += 1

            amenity = amenity_for(props)
            if amenity and props.get("amenity") != amenity:
                moves[f'amenity: {amenity}'] += 1
                props["amenity"] = amenity
                changed += 1

        if not changed:
            continue
        print(f"{os.path.basename(path)}: {changed} feature(s) retyped")
        if dry:
            continue
        # the traced file is hand work; keep a copy before touching it
        if not os.path.exists(path + ".bak"):
            shutil.copy2(path, path + ".bak")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(fc, fh, indent=2)

    if not moves:
        print("nothing to change; every type is already one of the five")
        return
    for move, n in sorted(moves.items()):
        print(f"  {move}: {n}")
    if dry:
        print("(dry run -- nothing written)")


if __name__ == "__main__":
    main()
