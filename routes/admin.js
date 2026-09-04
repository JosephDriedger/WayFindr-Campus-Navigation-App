// routes/admin.js
//
// The floor-plan tracer: a page for drawing rooms by hand over the scanned
// plan, and the small API behind it.
//
// The automated extractor read the PDFs and guessed -- segmenting rooms out of
// the ink and OCRing their numbers -- and the guesses were not good enough to
// trust: BCIT's sheets carry detail blocks, key plans and stencil lettering
// that a reader has no trouble with and a program does. Tracing by hand is
// slower and correct, so this exists to make the hand version quick: the sheet
// is laid over the campus map, positioned once per floor, and the rooms are
// drawn straight onto it.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { checkSession } from "../middleware/authMiddleware.js";
import { invalidateCache } from "../services/indoorGraph.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "public", "data");
const FLOOR_DIR = path.join(DATA, "floor-coordinates");
const IMAGE_DIR = path.join(DATA, "floorplan-images");
const PLACEMENTS = path.join(IMAGE_DIR, "_placements.json");

// Building codes and floor numbers only -- these become file paths, so
// anything else is rejected rather than sanitised into something surprising.
const CODE = /^[A-Za-z][A-Za-z0-9]{0,7}$/;
const FLOOR = /^[0-9]{1,3}$/;

/**
 * Whether the tracer needs a login.
 *
 * Off by default while the campus is being traced: requiring a session made
 * every /admin/api call answer with the login PAGE, and the tracer tried to
 * read that HTML as JSON -- which surfaced as "Unexpected token '<'" and a
 * floor list that never loaded.
 *
 * Worth turning back on before this is reachable by anyone else: these routes
 * overwrite floor data and start the rebuild scripts, so with it off anyone
 * who can reach the server can do both. Set ADMIN_REQUIRE_LOGIN=true.
 */
const requireLogin = process.env.ADMIN_REQUIRE_LOGIN === "true";
const guard = requireLogin ? checkSession : (req, res, next) => next();

function floorFile(building, floor) {
  if (!CODE.test(building) || !FLOOR.test(floor)) return null;
  return path.join(FLOOR_DIR, `${building.toUpperCase()}-Floor${floor}.geojson`);
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
};

router.get("/", guard, (req, res) => {
  res.render("admin-trace", {
    page: "admin",
    title: "Wayfindr - Floor Plan Tracer",
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    user: req.session?.user,
  });
});

/** Which floors have a rendered plan image, and which are already traced. */
router.get("/api/plans", guard, (req, res) => {
  const index = readJson(path.join(IMAGE_DIR, "_index.json"), {});
  const traced = new Set(
    fs.existsSync(FLOOR_DIR)
      ? fs.readdirSync(FLOOR_DIR).filter((f) => f.endsWith(".geojson"))
          .map((f) => f.replace(/\.geojson$/, ""))
      : []
  );
  const plans = Object.entries(index).map(([stem, v]) => ({
    stem,
    building: v.building,
    floor: v.floor,
    image: v.image,
    width: v.width,
    height: v.height,
    traced: traced.has(stem),
  }));
  plans.sort((a, b) =>
    a.building.localeCompare(b.building, undefined, { numeric: true }) ||
    Number(a.floor) - Number(b.floor));
  res.json({ plans });
});

/** Existing rooms and saved image placement for one floor. */
router.get("/api/floor/:building/:floor", guard, (req, res) => {
  const file = floorFile(req.params.building, req.params.floor);
  if (!file) return res.status(400).json({ error: "Bad Building or Floor" });
  const stem = path.basename(file, ".geojson");
  const placements = readJson(PLACEMENTS, {});
  res.json({
    featureCollection: readJson(file, { type: "FeatureCollection", features: [] }),
    placement: placements[stem] || null,
  });
});

/**
 * Replace one floor's rooms.
 *
 * The whole floor is written at once rather than patched room by room: the
 * page holds the authoritative copy while you are working on it, and a
 * partial write is how you end up with a floor that is half one session and
 * half another.
 */
router.put("/api/floor/:building/:floor", guard, (req, res) => {
  const file = floorFile(req.params.building, req.params.floor);
  if (!file) return res.status(400).json({ error: "Bad Building or Floor" });

  const fc = req.body?.featureCollection;
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    return res.status(400).json({ error: "Expected a GeoJSON FeatureCollection" });
  }
  // Outlines are polygons; doors and entrances are single points. Both are
  // real traced features, so both are accepted -- the rest is not.
  for (const f of fc.features) {
    const g = f?.geometry;
    if (g?.type === "Polygon") {
      if (!Array.isArray(g.coordinates?.[0]) || g.coordinates[0].length < 4) {
        return res.status(400).json({ error: "An outline needs at least three corners" });
      }
    } else if (g?.type === "Point") {
      if (!Array.isArray(g.coordinates) || g.coordinates.length !== 2) {
        return res.status(400).json({ error: "A marker needs a position" });
      }
      // What a marker joins is a pair of names the router looks up, so it has
      // to be a short list of strings and nothing else.
      const c = f.properties?.connects;
      if (c !== undefined) {
        if (!Array.isArray(c) || c.length > 2 || c.some((v) => typeof v !== "string")) {
          return res.status(400).json({ error: "A marker connects at most two named spaces" });
        }
      }
    } else if (g?.type === "LineString") {
      // a walking path: two ends, and the pair of node ids it joins
      const n = f.properties?.nodes;
      if (!Array.isArray(g.coordinates) || g.coordinates.length !== 2) {
        return res.status(400).json({ error: "A path runs between two points" });
      }
      if (!Array.isArray(n) || n.length !== 2 || n.some((v) => typeof v !== "string")) {
        return res.status(400).json({ error: "A path must name the two nodes it joins" });
      }
    } else {
      return res.status(400).json({ error: "Features must be outlines, markers or paths" });
    }
  }

  try {
    fs.mkdirSync(FLOOR_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fc, null, 2), "utf-8");
    res.json({ ok: true, saved: path.basename(file), features: fc.features.length });
  } catch (err) {
    console.error("save floor failed:", err);
    res.status(500).json({ error: "Could not write the floor file" });
  }
});

/** Where the plan image sits on the map, so it is positioned once per floor. */
router.put("/api/placement/:building/:floor", guard, (req, res) => {
  const file = floorFile(req.params.building, req.params.floor);
  if (!file) return res.status(400).json({ error: "Bad Building or Floor" });
  const stem = path.basename(file, ".geojson");

  const p = req.body?.placement;
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (!p || !num(p.lng) || !num(p.lat) || !num(p.widthM) || !num(p.rotation)) {
    return res.status(400).json({ error: "Bad Placement" });
  }

  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const all = readJson(PLACEMENTS, {});
    all[stem] = {
      lng: p.lng, lat: p.lat, widthM: p.widthM, rotation: p.rotation,
      updated: new Date().toISOString(),
    };
    fs.writeFileSync(PLACEMENTS, JSON.stringify(all, null, 2), "utf-8");
    res.json({ ok: true });
  } catch (err) {
    console.error("save placement failed:", err);
    res.status(500).json({ error: "Could not write the placement file" });
  }
});

/**
 * Rebuild the search index and the routing graph from what has been traced.
 *
 * Tracing a floor is only half the job -- the room search and the router both
 * read derived files, so until those are rebuilt a room you just drew is
 * invisible to both. Doing it from the tracer means the loop closes here:
 * trace, save, rebuild, route.
 */
router.post("/api/rebuild", guard, async (req, res) => {
  const repo = path.join(__dirname, "..");
  const steps = [
    ["floorPlans/build_room_search_index.py",
      ["public/data/floor-coordinates", "public/data/room-search-index.json"]],
    ["floorPlans/build_nav_graph.py",
      ["public/data/floor-coordinates", "public/data/nav-graph.json"]],
  ];

  const run = (script, args) => new Promise((resolve) => {
    // "py" is the Windows launcher this project's other tooling uses; fall
    // back to python3 so the same route works on a Linux host.
    const exe = process.platform === "win32" ? "py" : "python3";
    const argv = process.platform === "win32" ? ["-3", script, ...args] : [script, ...args];
    execFile(exe, argv, { cwd: repo, timeout: 600000 }, (err, stdout, stderr) =>
      resolve({ script, ok: !err, output: (stdout || "") + (stderr || "") }));
  });

  const results = [];
  for (const [script, args] of steps) {
    const r = await run(script, args);
    results.push(r);
    if (!r.ok) break;
  }

  const failed = results.find((r) => !r.ok);
  if (failed) {
    console.error("rebuild failed:", failed.script, failed.output.slice(-800));
    return res.status(500).json({
      error: `${failed.script} failed`,
      detail: failed.output.slice(-800),
    });
  }

  // the router caches each building's graph, so it has to be told the ground
  // moved or it will keep answering from the old one
  invalidateCache();

  const index = readJson(path.join(DATA, "room-search-index.json"), { rooms: [] });
  const nav = readJson(path.join(DATA, "nav-graph.json"), { buildings: {} });
  res.json({
    ok: true,
    rooms: index.rooms?.length || 0,
    buildings: Object.keys(nav.buildings || {}).length,
  });
});

export default router;
