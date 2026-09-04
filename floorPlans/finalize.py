"""
Promote generated floor data to live and re-validate.

  1. copy public/data/floor-coordinates-auto/*.geojson -> floor-coordinates/
     (the previous live files are moved aside to floorPlans/_prev_live/)
  2. rebuild public/data/room-search-index.json
  3. report overlap + cross-floor stair consistency

Usage: py -3 floorPlans/finalize.py [--dry-run]
"""
import os, sys, json, glob, shutil, subprocess

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
AUTO = os.path.join(REPO, "public", "data", "floor-coordinates-auto")
LIVE = os.path.join(REPO, "public", "data", "floor-coordinates")
PREV = os.path.join(REPO, "floorPlans", "_prev_live")


def main():
    dry = "--dry-run" in sys.argv
    os.chdir(REPO)

    generated = sorted(glob.glob(os.path.join(AUTO, "*.geojson")))
    if not generated:
        print("nothing in floor-coordinates-auto; run auto_extract_rooms.py first")
        return 1
    live_count = len(glob.glob(os.path.join(LIVE, "*.geojson")))
    print(f"{len(generated)} generated floors ({live_count} currently live)")

    # A batch takes the better part of an hour, and the generated directory
    # fills up as it goes. Promoting midway would replace the whole campus
    # with however many floors happened to be done -- so a set that has
    # shrunk has to be asked for explicitly.
    if live_count and len(generated) < live_count * 0.9 and "--force" not in sys.argv:
        print(f"REFUSING: {len(generated)} generated floors is fewer than the "
              f"{live_count} already live. If the batch is still running, wait "
              f"for it; if floors were genuinely dropped, re-run with --force.")
        return 1

    if dry:
        return 0

    os.makedirs(PREV, exist_ok=True)
    # os.replace, not shutil.move: _prev_live already holds the set from the
    # last promotion, and on Windows shutil.move refuses an existing
    # destination. That would abort partway through, having already moved
    # some live floors out -- leaving the app serving half a campus.
    for old in glob.glob(os.path.join(LIVE, "*.geojson")):
        os.replace(old, os.path.join(PREV, os.path.basename(old)))
    for g in generated:
        shutil.copy(g, os.path.join(LIVE, os.path.basename(g)))
    print(f"promoted {len(generated)} floors to {LIVE} (previous set -> {PREV})")

    subprocess.run([sys.executable, "floorPlans/build_room_search_index.py",
                    "public/data/floor-coordinates",
                    "public/data/room-search-index.json"], check=True)

    # the routing graph is derived from the geometry, so it has to be rebuilt
    # whenever the geometry changes or routes would follow the old floors
    print("\n=== navigation graph ===")
    subprocess.run([sys.executable, "floorPlans/build_nav_graph.py",
                    "public/data/floor-coordinates",
                    "public/data/nav-graph.json"], check=True)

    print("\n=== alignment (room area inside the real footprint) ===")
    subprocess.run([sys.executable, "floorPlans/validate_alignment.py"], check=False)
    print("\n=== overlap ===")
    subprocess.run([sys.executable, "floorPlans/validate_rooms.py"], check=False)
    print("\n=== cross-floor stair consistency ===")
    subprocess.run([sys.executable, "floorPlans/validate_stairs.py"], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
