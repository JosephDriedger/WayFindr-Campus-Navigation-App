"""
Renders a generated floor GeoJSON on top of that building's real footprint
so the alignment can be eyeballed against the source PDF. Black = real
building footprint from bcit-coordinates.geojson, red = generated rooms.

Usage: py -3 floorPlans/render_check.py SE6 1 [src_dir] [out.png]
"""
import sys, os, json, math
import numpy as np
import cv2

R_EARTH = 6378137.0


def lonlat_to_local(lon, lat, lon0, lat0):
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * R_EARTH
    y = math.radians(lat - lat0) * R_EARTH
    return x, y


def main():
    building = sys.argv[1]
    floor = sys.argv[2]
    src_dir = sys.argv[3] if len(sys.argv) > 3 else "public/data/floor-coordinates"
    out = sys.argv[4] if len(sys.argv) > 4 else f"floorPlans/_check_{building}-F{floor}.png"

    fc = json.load(open(os.path.join(src_dir, f"{building}-Floor{floor}.geojson"), encoding="utf-8"))
    coords = json.load(open("public/data/bcit-coordinates.geojson", encoding="utf-8"))

    # ten buildings are stored as MultiPolygon (a main mass plus an annex),
    # so reading Polygon only would draw no footprint at all for exactly the
    # buildings whose alignment is hardest to judge
    foot = []
    for f in coords["features"]:
        if (f["properties"].get("BuildingName") or "").strip() != building.upper():
            continue
        g = f["geometry"]
        if g["type"] == "Polygon":
            foot.append(g["coordinates"][0])
        elif g["type"] == "MultiPolygon":
            foot.extend(part[0] for part in g["coordinates"])

    ref = foot[0] if foot else fc["features"][0]["geometry"]["coordinates"][0]
    lon0 = sum(p[0] for p in ref) / len(ref)
    lat0 = sum(p[1] for p in ref) / len(ref)

    foot_local = [np.array([lonlat_to_local(x, y, lon0, lat0) for x, y in ring]) for ring in foot]
    room_local, hole_local = [], []
    for f in fc["features"]:
        if f["geometry"]["type"] != "Polygon":
            continue
        rings = f["geometry"]["coordinates"]
        room_local.append(np.array([lonlat_to_local(x, y, lon0, lat0) for x, y in rings[0]]))
        for h in rings[1:]:
            hole_local.append(np.array([lonlat_to_local(x, y, lon0, lat0) for x, y in h]))

    allp = np.vstack(foot_local + room_local) if foot_local else np.vstack(room_local)
    minx, miny = allp.min(axis=0)
    maxx, maxy = allp.max(axis=0)
    scale = 1000 / max(maxx - minx, 1e-6)
    W = int((maxx - minx) * scale) + 40
    H = int((maxy - miny) * scale) + 40
    img = np.full((H, W, 3), 255, np.uint8)

    def to_px(p):
        x = (p[:, 0] - minx) * scale + 20
        y = H - ((p[:, 1] - miny) * scale + 20)
        return np.stack([x, y], axis=1).astype(np.int32)

    for ring in foot_local:
        cv2.polylines(img, [to_px(ring)], True, (0, 0, 0), 3)
    for ring in room_local:
        cv2.polylines(img, [to_px(ring)], True, (0, 0, 255), 1)
    for ring in hole_local:
        cv2.polylines(img, [to_px(ring)], True, (255, 128, 0), 1)

    cv2.imwrite(out, img)
    print("wrote", out, f"({len(room_local)} rooms, {len(foot_local)} footprint ring(s))")


if __name__ == "__main__":
    main()
