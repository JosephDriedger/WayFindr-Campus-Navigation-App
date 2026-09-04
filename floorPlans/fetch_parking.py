"""
Fetch the campus parking lot outlines.

Same source as the building footprints: BCIT's own ArcGIS site data, through
the feature service behind their published parking map. Kept as its own file
because a car park is not a building -- you drive into it, it has no floors,
and it wants its own colour on the map -- but it IS a place you can be routed
to, so a node standing in one belongs to it exactly as a node in SW3 belongs
to SW3.

The service carries a lot of retail detail (payment links, rate cards, hours
as prose). None of that is navigation, so only what identifies the lot and
what someone would want to know at a glance is kept.

Usage: py -3 floorPlans/fetch_parking.py [out_path]
"""
import sys, json, urllib.request

SERVICE = (
    "https://services2.arcgis.com/IgcrRjRW95F0HKSw/arcgis/rest/services/"
    "Bsite_ParkingBoundaries_ParkingFilter/FeatureServer/0/query"
    "?where=1%3D1&outFields=*&outSR=4326&f=geojson"
)

# What a lot is called on the signs, what kind of parking it is, and how big
# it is. Everything else the service returns is somebody else's problem.
KEEP = {
    "Name": "name",
    "Type2": "kind",
    "StallCount": "stalls",
    "Hours": "hours",
    "isStaffOnly": "staffOnly",
}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "public/data/parking-lots.geojson"

    req = urllib.request.Request(SERVICE, headers={"User-Agent": "wayfindr/1.0"})
    with urllib.request.urlopen(req, timeout=60) as fh:
        source = json.load(fh)

    # The service publishes one polygon per lot PER CATEGORY -- the same
    # LOT A appears once for "Student and Public", once for "Student and
    # Daily" and once for contractors, because the published map lets you
    # filter by who may park there. Some of those repeats are the identical
    # outline and some are genuinely different corners of the lot, so exact
    # duplicates are dropped and the categories are collected onto what
    # remains: one lot, one name, everything it is used for.
    by_name = {}
    for f in source.get("features", []):
        props = f.get("properties") or {}
        name = (props.get("Name") or "").strip()
        if not name or not f.get("geometry"):
            continue
        by_name.setdefault(name, []).append((props, f["geometry"]))

    features = []
    for name, parts in sorted(by_name.items()):
        kinds = sorted({(p.get("Type2") or p.get("Type") or "").strip()
                        for p, _ in parts} - {""})
        first = parts[0][0]
        seen_geometry = set()
        keep = []
        for props, geom in parts:
            fingerprint = json.dumps(geom, sort_keys=True)
            if fingerprint in seen_geometry:
                continue
            seen_geometry.add(fingerprint)
            keep.append(geom)

        # Only the largest piece carries the name, or a lot in four parts
        # would write its name across the map four times.
        biggest = max(range(len(keep)),
                      key=lambda i: json.dumps(keep[i]).__len__())
        for i, geom in enumerate(keep):
            kept = {
                "name": name,
                "type": "parking",
                "kinds": kinds,
                "label": i == biggest,
                "source": "BCIT ArcGIS Bsite_ParkingBoundaries",
            }
            if first.get("StallCount"):
                kept["stalls"] = first["StallCount"]
            if first.get("Hours"):
                kept["hours"] = str(first["Hours"]).strip()
            if first.get("isStaffOnly"):
                kept["staffOnly"] = first["isStaffOnly"]
            features.append({"type": "Feature", "properties": kept, "geometry": geom})

    with open(out, "w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[\n')
        fh.write(("," + "\n").join(json.dumps(f) for f in features))
        fh.write("\n]}\n")

    stalls = sum(next(iter([f["properties"].get("stalls") or 0]))
                 for f in features if f["properties"].get("label"))
    print(f"{len(features)} parking lots, {stalls} stalls -> {out}")
    print(f"  {len(by_name)} distinct lots, {len(features)} outlines after "
          f"dropping repeats")


if __name__ == "__main__":
    main()
