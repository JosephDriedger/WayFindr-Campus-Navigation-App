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
import { requireAdmin } from "../middleware/authMiddleware.js";
import { invalidateCache } from "../services/indoorGraph.js";
import { applyDelta, featureKey, danglingLinks } from "../services/networkDelta.js";
import { placeAt } from "../services/places.js";
import {
  listPlans,
  uploadHistory,
  versionsOf,
  replacePlan,
  restoreVersion,
  runPython,
  stemFor,
  parsePlanName,
  PlanError,
  MAX_BYTES,
} from "../services/planLibrary.js";
import { listUsers, setAdmin, UserAdminError } from "../services/userAdmin.js";

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
 * Everything under /admin is for the people who maintain the map.
 *
 * These routes overwrite floor data, replace BCIT's drawings and start the
 * rebuild scripts, so they are not gated on being signed in -- a student with
 * an account is still a student -- but on being an administrator. Who counts
 * as one is in middleware/authMiddleware.js: the `admin` claim on their
 * Firebase account, and nothing else.
 *
 * The guard answers an /admin/api call with JSON rather than the login page,
 * which is what makes it usable from the tracer: sent HTML where it expected
 * data, the page failed with "Unexpected token '<'" and a floor list that
 * never loaded.
 */
const guard = requireAdmin;

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

/**
 * What the campus map currently consists of, for the landing page.
 *
 * Counted from the files the app actually serves rather than kept as a tally
 * somewhere, because every one of these numbers moves whenever somebody
 * traces a floor, and a number that can go stale is worse than no number: it
 * is read as a fact.
 */
function dashboardSummary() {
  const index = readJson(path.join(DATA, "room-search-index.json"), { rooms: [] });
  const rooms = Array.isArray(index.rooms) ? index.rooms : [];
  const buildings = new Set();
  const floors = new Set();
  for (const r of rooms) {
    if (!r.building) continue;
    buildings.add(r.building);
    if (r.floor) floors.add(`${r.building}|${r.floor}`);
  }

  const network = tally(readNetwork().features);
  const plans = listPlans();
  const traced = plans.filter((p) => p.traced > 0).length;

  return {
    rooms: rooms.length,
    buildings: buildings.size,
    floors: floors.size,
    nodes: network.nodes,
    links: network.links,
    sheets: plans.length,
    traced,
    untraced: plans.length - traced,
    unplaced: plans.filter((p) => !p.placed).length,
    recent: uploadHistory(5),
  };
}

/**
 * The admin landing page: what the map is made of, and the way into each tool.
 *
 * /admin used to BE the tracer. It is now the front door, because there is
 * more than one tool behind it and a person arriving needs to choose. An old
 * link carrying a floor still means "open this in the tracer", so it is sent
 * there rather than dropped on a page that does not draw anything.
 */
router.get("/", guard, (req, res) => {
  if (req.query.plan) {
    return res.redirect(`/admin/tracer?plan=${encodeURIComponent(req.query.plan)}`);
  }
  res.render("admin-dashboard", {
    page: "admin",
    title: "Wayfindr - Admin",
    user: req.session?.user,
    summary: dashboardSummary(),
  });
});

router.get("/tracer", guard, (req, res) => {
  res.render("admin-trace", {
    page: "tracer",
    title: "Wayfindr - Floor Plan Tracer",
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    user: req.session?.user,
  });
});

/** The old address of the tracer, kept working for anything that saved it. */
router.get("/trace", guard, (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(qs ? `/admin/tracer?${qs}` : "/admin/tracer");
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
        return "A Node Needs a Position";
      }
      if (!props.nid || typeof props.nid !== "string") {
        return "A Node Needs an Id, or Nothing Can Link to It";
      }
      ids.add(props.nid);
    } else if (props.type === "path") {
      const n = props.nodes;
      if (!Array.isArray(n) || n.length !== 2 || n.some((v) => typeof v !== "string")) {
        return "A Link Must Name the Two Nodes It Joins";
      }
    } else {
      return "The Network Holds Nodes and Links Only";
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

/**
 * Give every unlabelled node the place it is standing in.
 *
 * Which building or car park a node belongs to is a fact about where it is,
 * not something anybody should have to type -- and it is what makes the place
 * routable, since "take me to Lot L" means "take me to a node that says Lot
 * L". The tracer works this out as each node is dropped, but only once the
 * campus outlines have arrived, and a node placed in the second before that
 * kept a null forever. Deciding it again here, where the file is written,
 * means a node inside a lot is mapped to that lot however it got there.
 *
 * Only blanks are filled. A node that says which place it is in is taken at
 * its word: a node at the door of SW7 stands a metre outside SW7's footprint
 * on purpose, and overwriting that with "outdoors" would unreach the door.
 *
 * Returns what it decided, as [{ nid, building }], so the tracer can take the
 * answer back rather than carrying on from a copy the file disagrees with.
 */
function placeNodes(features) {
  const filled = [];
  for (const f of features) {
    const props = f?.properties;
    if (!props || props.type !== "node" || props.building) continue;
    const [lng, lat] = f.geometry?.coordinates || [];
    const place = placeAt(lng, lat);
    if (!place) continue;
    props.building = place;
    filled.push({ nid: props.nid, building: place });
  }
  return filled;
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
  if (dupes) return res.status(400).json({ error: "Two Nodes Share an Id" });

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
        + "If That Is Deliberate, Save Again with Force Set; Otherwise Reload "
        + "The Tracer, Because It Is Probably Working from an Empty Copy.",
      had,
      now: ids.size,
    });
  }

  const placed = placeNodes(fc.features);

  const version = current.version + 1;
  let checksum;
  try {
    checksum = writeNetwork(fc.features, version);
  } catch (err) {
    return res.status(500).json({ error: `Could not save the network: ${err.message}` });
  }
  res.json({ saved: true, version, checksum, placed, ...tally(fc.features) });
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
    return res.status(400).json({ error: "A Change Has to Say Which Version It Is a Change To" });
  }
  if (![add, update, remove].every(Array.isArray)) {
    return res.status(400).json({ error: "Add, Update and Remove Are Lists" });
  }

  const current = readNetwork();
  if (baseVersion !== current.version) {
    return res.status(409).json({
      error: "The Network Has Changed Since You Loaded It. Reload Before Saving.",
      yours: baseVersion,
      current: current.version,
      conflict: true,
    });
  }

  const incoming = [...add, ...update];
  const bad = checkFeatures(incoming);
  if (bad) return res.status(400).json({ error: bad });
  if (incoming.some((f) => !featureKey(f))) {
    return res.status(400).json({ error: "Every Feature in a Change Needs an Id" });
  }
  if (remove.some((k) => typeof k !== "string")) {
    return res.status(400).json({ error: "Remove Is a List of Feature Ids" });
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

  const placed = placeNodes(features);

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
    // nodes that were standing in a building or a car park and had not said so
    placed,
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
        return res.status(400).json({ error: "An Outline Needs at Least Three Corners" });
      }
    } else if (g?.type === "Point") {
      if (!Array.isArray(g.coordinates) || g.coordinates.length !== 2) {
        return res.status(400).json({ error: "A Marker Needs a Position" });
      }
      // What a marker joins is a pair of names the router looks up, so it has
      // to be a short list of strings and nothing else.
      const c = f.properties?.connects;
      if (c !== undefined) {
        if (!Array.isArray(c) || c.length > 2 || c.some((v) => typeof v !== "string")) {
          return res.status(400).json({ error: "A Marker Connects at Most Two Named Spaces" });
        }
      }
    } else if (g?.type === "LineString") {
      // a walking path: two ends, and the pair of node ids it joins
      const n = f.properties?.nodes;
      if (!Array.isArray(g.coordinates) || g.coordinates.length !== 2) {
        return res.status(400).json({ error: "A Path Runs Between Two Points" });
      }
      if (!Array.isArray(n) || n.length !== 2 || n.some((v) => typeof v !== "string")) {
        return res.status(400).json({ error: "A Path Must Name the Two Nodes It Joins" });
      }
    } else {
      return res.status(400).json({ error: "Features Must Be Outlines, Markers or Paths" });
    }
  }

  try {
    fs.mkdirSync(FLOOR_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fc, null, 2), "utf-8");
    res.json({ ok: true, saved: path.basename(file), features: fc.features.length });
  } catch (err) {
    console.error("save floor failed:", err);
    res.status(500).json({ error: "Could Not Write the Floor File" });
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
    res.status(500).json({ error: "Could Not Write the Placement File" });
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
  const steps = [
    ["floorPlans/build_room_search_index.py",
      ["public/data/floor-coordinates", "public/data/room-search-index.json"]],
    ["floorPlans/build_nav_graph.py",
      ["public/data/floor-coordinates", "public/data/nav-graph.json"]],
  ];

  const results = [];
  for (const [script, args] of steps) {
    const r = await runPython(script, args);
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

// ---------------------------------------------------------------------------
// The floor-plan library
//
// The sheets are BCIT's and BCIT keeps redrawing them, so getting a new one
// into the app has to be something Facilities can do: drop the file in, and
// the picture the tracer draws under the map is rebuilt from it.
//
// The work is in services/planLibrary.js. These are the doors to it.
// ---------------------------------------------------------------------------

/**
 * The upload body is the file itself.
 *
 * A drawing is one file with two fields beside it, and those two fields are
 * already in the URL -- so multipart would mean a parsing dependency for
 * nothing. The body is the bytes; express.raw hands them over as a Buffer.
 * application/octet-stream is accepted because that is what a browser calls
 * a file it has no opinion about, and the bytes are sniffed anyway.
 */
const planUpload = express.raw({
  type: ["application/pdf", "image/png", "application/octet-stream"],
  limit: MAX_BYTES,
});

const who = (req) => req.session?.user?.email || req.session?.user?.uid || null;

/** Answer a PlanError with the status it already knows it wants. */
function planFailure(res, err) {
  if (err instanceof PlanError) {
    return res.status(err.status).json({ error: err.message, detail: err.detail });
  }
  console.error("plan library:", err);
  return res.status(500).json({ error: "Something Went Wrong Handling That Sheet." });
}

router.get("/plans", guard, (req, res) => {
  res.render("admin-plans", {
    page: "plans",
    title: "Wayfindr - Floor Plans",
    user: req.session?.user,
  });
});

/** Every sheet, and the recent replacements. */
router.get("/api/library", guard, (req, res) => {
  try {
    res.json({
      plans: listPlans(),
      history: uploadHistory(),
      maxBytes: MAX_BYTES,
    });
  } catch (err) {
    planFailure(res, err);
  }
});

/** The kept copies of one sheet, newest first. */
router.get("/api/plan/:building/:floor/versions", guard, (req, res) => {
  const stem = stemFor(req.params.building, req.params.floor);
  if (!stem) return res.status(400).json({ error: "Bad Building or Floor" });
  res.json({ stem, versions: versionsOf(stem) });
});

/**
 * Which sheet each of these files is, going by its name.
 *
 * Asked of the server rather than worked out in the page, so that what counts
 * as a sheet name is written down once. Thirty files dropped at once come
 * back as thirty building-and-floor pairs, and whatever could not be read
 * comes back as null for a person to fill in.
 */
router.post("/api/plan-names", guard, (req, res) => {
  const names = req.body?.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: "Expected a List of File Names" });
  res.json({
    parsed: names.slice(0, 200).map((name) => ({
      name: String(name),
      match: parsePlanName(name),
    })),
  });
});

/**
 * Replace one sheet.
 *
 * The old one is kept, the picture is re-rendered, and the position the plan
 * had on the map is carried over when the two drawings agree about the page
 * they came from. What is NOT touched is the tracing: the rooms drawn from
 * the old sheet stay exactly where they were, because only a person can say
 * which of them the new drawing has moved.
 */
router.post("/api/plan/:building/:floor", guard, planUpload, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(415).json({
      error: "Send the File Itself as the Body, with a PDF or PNG Content Type.",
    });
  }
  try {
    const report = await replacePlan({
      building: req.params.building,
      floor: req.params.floor,
      bytes: req.body,
      filename: String(req.query.name || ""),
      by: who(req),
    });
    res.json(report);
  } catch (err) {
    planFailure(res, err);
  }
});

// ---------------------------------------------------------------------------
// Who maintains the map
//
// The list of administrators has to be changeable by the administrators
// themselves, or the only way to appoint the next one is a developer with a
// deployment -- which is fine on the day the app is built and hopeless a year
// later when the person who set it up has left.
//
// The work is in services/userAdmin.js.
// ---------------------------------------------------------------------------

router.get("/users", guard, (req, res) => {
  res.render("admin-users", {
    page: "users",
    title: "Wayfindr - People",
    user: req.session?.user,
  });
});

function userFailure(res, err) {
  if (err instanceof UserAdminError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("user admin:", err);
  return res.status(500).json({ error: "Something Went Wrong Reading the Accounts." });
}

/** Everybody with an account, and which of them maintain the map. */
router.get("/api/users", guard, async (req, res) => {
  try {
    const data = await listUsers();
    // so the page can mark the row that is you, and refuse to offer you a
    // button that would lock you out
    res.json({ ...data, you: req.session?.user?.uid || null });
  } catch (err) {
    userFailure(res, err);
  }
});

/**
 * Make somebody an administrator, or stop them being one.
 *
 * Only an administrator can reach this -- the whole router is behind that --
 * so the check that matters here is the one about not being able to do it to
 * yourself.
 */
router.post("/api/users/:uid/admin", guard, async (req, res) => {
  try {
    const result = await setAdmin(req.params.uid, req.body?.admin === true, {
      by: req.session?.user?.uid || null,
    });
    res.json(result);
  } catch (err) {
    userFailure(res, err);
  }
});

/** Put a kept copy back in place of the current one. */
router.post("/api/plan/:building/:floor/restore", guard, async (req, res) => {
  try {
    const report = await restoreVersion({
      building: req.params.building,
      floor: req.params.floor,
      file: req.body?.file,
      by: who(req),
    });
    res.json(report);
  } catch (err) {
    planFailure(res, err);
  }
});

export default router;
