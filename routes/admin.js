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
import { applyDelta, featureKey, danglingLinks } from "../services/networkDelta.js";

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
  // A sheet counts as traced when there is something on it. Opening a floor
  // writes an empty file, so counting files said "6 floors traced" when four
  // of them held nothing at all -- and put a tick beside each of them in the
  // picker.
  const traced = new Set(
    (fs.existsSync(FLOOR_DIR) ? fs.readdirSync(FLOOR_DIR) : [])
      .filter((f) => f.endsWith(".geojson"))
      .filter((f) => {
        const fc = readJson(path.join(FLOOR_DIR, f), { features: [] });
        return (fc.features || []).length > 0;
      })
      .map((f) => f.replace(/\.geojson$/, ""))
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

// ---------------------------------------------------------------------------
// The walking network
//
// One file for the whole campus, kept apart from the floor sheets. A path
// across the lawn belongs to no floor, and a node at the door of SW7 belongs
// to SW7 -- neither is a fact about whichever sheet was open when it was
// drawn, which is what storing the network inside a sheet made them.
// ---------------------------------------------------------------------------
const NETWORK_FILE = path.join(DATA, "walking-network.geojson");

/**
 * The network as it stands, and which version of it that is.
 *
 * The version is what makes saving a change rather than the whole document
 * safe. A change only means anything applied to the version it was worked out
 * against: a client that has drifted -- a second tab, a save that failed
 * halfway, a page left open overnight -- is told to catch up rather than
 * allowed to apply its idea of "what changed" to a file that moved underneath
 * it.
 */
function readNetwork() {
  const fc = readJson(NETWORK_FILE, { type: "FeatureCollection", features: [] });
  return {
    version: Number(fc.version) || 0,
    features: Array.isArray(fc.features) ? fc.features : [],
  };
}

/**
 * Check a set of features the way a whole-document save is checked.
 *
 * Returns a message when something is wrong, or null when it is fine. A delta
 * gets the same treatment as a full write: the rules are about what the
 * network may contain, not about how it arrived.
 */
function checkFeatures(features, { nodeIds = null } = {}) {
  const ids = nodeIds || new Set();
  for (const f of features) {
    const g = f?.geometry;
    const props = f?.properties || {};
    if (props.type === "node") {
      if (g?.type !== "Point" || !Array.isArray(g.coordinates) || g.coordinates.length !== 2) {
        return "A node needs a position";
      }
      if (!props.nid || typeof props.nid !== "string") {
        return "A node needs an id, or nothing can link to it";
      }
      ids.add(props.nid);
    } else if (props.type === "path") {
      const n = props.nodes;
      if (!Array.isArray(n) || n.length !== 2 || n.some((v) => typeof v !== "string")) {
        return "A link must name the two nodes it joins";
      }
    } else {
      return "The network holds nodes and links only";
    }
  }
  return null;
}

/** A link naming a node that is not there is a hole the graph builder drops. */
function checkLinksResolve(features) {
  const missing = danglingLinks(features);
  return missing.length
    ? `A link names ${missing[0]}, which is not a node here`
    : null;
}

/**
 * Write the network out, one feature per line.
 *
 * Indenting a few hundred nodes and links roughly doubled the file for no
 * gain: nobody reads it, and the reason to avoid one long line is that it
 * makes an unreadable diff. A line per feature keeps the diff honest -- moving
 * one node changes one line -- and halves what is written and read.
 */
/**
 * A short fingerprint of the network's contents.
 *
 * A version number says "something changed"; this says "changed to exactly
 * this". After applying a change the client compares its own idea of the
 * result against this, and reloads if the two ever disagree rather than
 * carrying on from a picture that is subtly wrong. Cheap on purpose: it runs
 * over a string that has just been built anyway.
 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function networkBody(features, version) {
  const lines = features.map((f) => JSON.stringify(f)).join(",\n");
  const head = `{"type":"FeatureCollection","version":${version},"features":[`;
  return `${head}\n${lines}\n]}\n`;
}

function writeNetwork(features, version) {
  if (fs.existsSync(NETWORK_FILE)) {
    // The network is hand work that takes hours. One bad write should cost a
    // file copy to undo, not an evening.
    fs.copyFileSync(NETWORK_FILE, `${NETWORK_FILE}.prev`);
  }
  const body = networkBody(features, version);
  fs.writeFileSync(NETWORK_FILE, body);
  return fingerprint(body);
}

/** Nodes, and links, counted. */
function tally(features) {
  const nodes = features.filter((f) => f.properties?.type === "node").length;
  return { nodes, links: features.length - nodes };
}

router.get("/api/network", guard, (req, res) => {
  const { version, features } = readNetwork();
  res.json({
    featureCollection: { type: "FeatureCollection", version, features },
    version,
    checksum: fingerprint(networkBody(features, version)),
  });
});

/**
 * Replace the whole network.
 *
 * Still here, and still what a first save uses: a delta needs something to be
 * a change to. It is also the way back when a client and the file have got
 * out of step badly enough that no delta can express the difference.
 */
router.put("/api/network", guard, (req, res) => {
  const fc = req.body?.featureCollection;
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    return res.status(400).json({ error: "Expected a GeoJSON FeatureCollection" });
  }

  const ids = new Set();
  const bad = checkFeatures(fc.features, { nodeIds: ids });
  if (bad) return res.status(400).json({ error: bad });

  const dupes = fc.features.filter((f) => f.properties?.type === "node").length !== ids.size;
  if (dupes) return res.status(400).json({ error: "Two nodes share an id" });

  const unresolved = checkLinksResolve(fc.features);
  if (unresolved) return res.status(400).json({ error: unresolved });

  // A save that arrives nearly empty would delete most of the campus in one
  // request. That is almost never what somebody means: it is what happens
  // when the page failed to load the network and then saved anyway.
  const current = readNetwork();
  const had = tally(current.features).nodes;
  const forced = req.query.force === "1" || req.body?.force === true;
  if (had > 10 && ids.size < had / 2 && !forced) {
    return res.status(409).json({
      error: `This would cut the network from ${had} nodes to ${ids.size}. `
        + "If that is deliberate, save again with force set; otherwise reload "
        + "the tracer, because it is probably working from an empty copy.",
      had,
      now: ids.size,
    });
  }

  const version = current.version + 1;
  let checksum;
  try {
    checksum = writeNetwork(fc.features, version);
  } catch (err) {
    return res.status(500).json({ error: `Could not save the network: ${err.message}` });
  }
  res.json({ saved: true, version, checksum, ...tally(fc.features) });
});

/**
 * Apply a change to the network.
 *
 * The document is one file for the whole campus and it grows with every node
 * traced; sending all of it back to change three of them is most of the cost
 * of saving. This takes what changed instead:
 *
 *   { baseVersion, add: [feature...], update: [feature...], remove: [key...] }
 *
 * `baseVersion` is what the sender last read. If the file has moved on since,
 * the change is refused rather than applied to the wrong thing -- the sender
 * has an idea of "before" that is no longer true, and only it knows whether
 * its work or the other change matters more.
 */
router.patch("/api/network", guard, (req, res) => {
  const { baseVersion, add = [], update = [], remove = [] } = req.body || {};

  if (!Number.isInteger(baseVersion)) {
    return res.status(400).json({ error: "A change has to say which version it is a change to" });
  }
  if (![add, update, remove].every(Array.isArray)) {
    return res.status(400).json({ error: "add, update and remove are lists" });
  }

  const current = readNetwork();
  if (baseVersion !== current.version) {
    return res.status(409).json({
      error: "The network has changed since you loaded it. Reload before saving.",
      yours: baseVersion,
      current: current.version,
      conflict: true,
    });
  }

  const incoming = [...add, ...update];
  const bad = checkFeatures(incoming);
  if (bad) return res.status(400).json({ error: bad });
  if (incoming.some((f) => !featureKey(f))) {
    return res.status(400).json({ error: "Every feature in a change needs an id" });
  }
  if (remove.some((k) => typeof k !== "string")) {
    return res.status(400).json({ error: "remove is a list of feature ids" });
  }

  const merged = applyDelta(current.features, { add, update, remove });
  const features = merged.features;

  const unresolved = checkLinksResolve(features);
  if (unresolved) return res.status(400).json({ error: unresolved });

  const ids = new Set(
    features.filter((f) => f.properties?.type === "node").map((f) => f.properties.nid)
  );

  const had = tally(current.features).nodes;
  const forced = req.query.force === "1" || req.body?.force === true;
  if (had > 10 && ids.size < had / 2 && !forced) {
    return res.status(409).json({
      error: `This would cut the network from ${had} nodes to ${ids.size}.`,
      had,
      now: ids.size,
    });
  }

  const version = current.version + 1;
  let checksum;
  try {
    checksum = writeNetwork(features, version);
  } catch (err) {
    return res.status(500).json({ error: `Could not save the network: ${err.message}` });
  }

  res.json({
    saved: true,
    version,
    checksum,
    // what actually happened, which is not always what was asked for
    applied: { added: merged.added, updated: merged.updated, removed: merged.removed },
    ...tally(features),
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
  // "(outdoors)" is where the paths between buildings live, not a building
  const places = Object.keys(nav.buildings || {}).filter((b) => !b.startsWith("("));
  res.json({
    ok: true,
    rooms: index.rooms?.length || 0,
    buildings: places.length,
    nodes: (nav.nodes || []).length,
    links: (nav.edges || []).length,
  });
});

export default router;
