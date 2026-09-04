"""
Aggregates per-floor room GeoJSON files into a room-search-index.json
(same schema the live search UI already expects, see public/js/bcit-map-search.js).

Usage:
    py -3 floorPlans/build_room_search_index.py public/data/floor-coordinates-auto public/data/room-search-index-auto.json
"""
import sys, os, json, glob

def main():
    src_dir = sys.argv[1] if len(sys.argv) > 1 else "public/data/floor-coordinates-auto"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "public/data/room-search-index-auto.json"

    rooms = []
    seen = set()
    for path in sorted(glob.glob(os.path.join(src_dir, "*.geojson"))):
        with open(path, encoding="utf-8") as f:
            fc = json.load(f)
        source = os.path.basename(path)
        for feat in fc.get("features", []):
            props = feat.get("properties", {})
            room = props.get("room")
            kind = props.get("type") or "room"

            # Only a room is somewhere you can be sent. A walking node names
            # the room it serves and a path names nothing, so indexing those
            # listed room 1600 thirteen times, once per node standing in it --
            # and a hallway or a riser cupboard is not a destination at all.
            if kind != "room":
                continue

            # Outlines are the usual case, but a labelled navigation marker --
            # "West Entrance" -- is a place people look for by name, and
            # indexing polygons only made those unfindable.
            geom_type = feat["geometry"]["type"]
            if not room or geom_type not in ("Polygon", "Point"):
                continue

            # the same number traced twice is one place, not two
            key = (props.get("building", ""), props.get("floor", ""), room)
            if key in seen:
                continue
            seen.add(key)
            building = props.get("building", "")
            label = f"{building}-{room}"
            # People look for the lecture hall, not for 1750. Carrying the
            # name into the index means both find it, and the search box can
            # show which room the name belongs to.
            name = (props.get("name") or "").strip() or None
            rooms.append({
                "label": label,
                "building": building,
                "floor": props.get("floor", ""),
                "room": room,
                "name": name,
                "type": props.get("type", "room"),
                "confidence": props.get("confidence"),
                "source": source,
                "query": f"{label} {name}" if name else label,
            })

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"rooms": rooms}, f, indent=2)
    print(f"wrote {len(rooms)} room entries -> {out_path}")


if __name__ == "__main__":
    main()
