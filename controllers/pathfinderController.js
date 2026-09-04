import { findIndoorPath } from "../services/indoorGraph.js";

// Indoor room-to-room routing. Historically this shelled out to a Python
// A* script over a wall-raster grid that only existed for two buildings
// (SW3, SW5); it now runs entirely in-process against the room/corridor/door
// GeoJSON in public/data/floor-coordinates/, which covers the whole campus.
export const handlePathRequest = (req, res) => {
    const { startBuildingCode, startRoom, goalBuildingCode, goalRoom, building } = req.body;

    const buildingCode = (building || goalBuildingCode || startBuildingCode || "").toUpperCase();

    if (startBuildingCode && goalBuildingCode &&
        startBuildingCode.toUpperCase() !== goalBuildingCode.toUpperCase()) {
        return res.json({
            success: false,
            message: "Cross-building indoor routing isn't supported yet -- start and goal must be in the same building.",
        });
    }

    if (!buildingCode || !startRoom || !goalRoom) {
        return res.status(400).json({ success: false, message: "building, startRoom and goalRoom are required." });
    }

    const result = findIndoorPath(buildingCode, startRoom, goalRoom);
    res.json(result);
};
