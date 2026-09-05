import { findIndoorPath } from "../services/indoorGraph.js";

// Room-to-room routing over the campus walking network. Historically this
// shelled out to a Python A* script over a wall-raster grid that only existed
// for two buildings (SW3, SW5); it now runs entirely in-process against
// public/data/nav-graph.json, which covers the whole campus -- indoors and
// out, buildings and car parks in one graph.

/**
 * One end of a route, as the router wants it.
 *
 * A string is a name -- a room, a building, a car park. An object with a
 * longitude and a latitude is a spot on the map: where the phone says you
 * are, or where somebody pressed "Start Here" on a place with no room
 * number. Both are ordinary ends of a route, so both are accepted here
 * rather than making the browser find a room name to stand in for a point.
 */
function readEnd(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const lng = Number(value.lng);
    const lat = Number(value.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    // Anything outside these is not a place on Earth, let alone on campus.
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    const label = typeof value.label === "string"
      ? value.label.trim().slice(0, 80) : "";
    return { lng, lat, label: label || null };
  }
  const text = String(value ?? "").trim();
  return text ? text : null;
}

export const handlePathRequest = (req, res) => {
    const { startBuildingCode, goalBuildingCode, building } = req.body;

    const buildingCode = (building || goalBuildingCode || startBuildingCode || "").toUpperCase();

    const startRoom = readEnd(req.body.startRoom);
    const goalRoom = readEnd(req.body.goalRoom);

    if (!buildingCode || !startRoom || !goalRoom) {
        return res.status(400).json({ success: false, message: "building, startRoom and goalRoom are required." });
    }

    // Cross-building routing used to be refused here. There is one graph for
    // the whole campus now -- a link out of a door and across the lawn is an
    // ordinary link -- so a start in one building and a goal in another is
    // just a longer walk, and refusing it was the only thing stopping it.
    const result = findIndoorPath(buildingCode, startRoom, goalRoom);
    res.json(result);
};
