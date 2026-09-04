// public/js/admin-trace.js
//
// Trace rooms by hand from the scanned floor plan.
//
// Rooms are stored in the PLAN's own coordinates -- a fraction across and down
// the drawing -- not as latitude and longitude. That is what lets you trace a
// whole floor first and line it up with the campus afterwards: moving, turning
// or resizing the plan carries every room you have drawn with it, because the
// rooms are attached to the drawing rather than to the ground. They are only
// converted to real coordinates on save.

const BCIT = { lng: -123.0011, lat: 49.2505, zoom: 15.6 };
const R_EARTH = 6378137;
const SNAP_PX = 12; // click within this of an existing corner and it reuses it

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/**
 * Fetch that insists on JSON.
 *
 * When these routes are behind a login and the session has gone, the server
 * answers with the login PAGE rather than an error, and JSON.parse chokes on
 * the doctype -- which reaches the user as "Unexpected token \'<\'" and tells
 * them nothing. Say what actually happened instead.
 */
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.text();
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    if (/^\s*</.test(body)) {
      throw new Error(res.redirected || res.status === 401
        ? "Signed out — log in again to keep tracing."
        : `The server returned a page, not data (${res.status}).`);
    }
    throw new Error(`Unreadable response from the server (${res.status}).`);
  }
  if (!res.ok) {
    // Two error shapes reach here: this app's own `{error: "what went
    // wrong"}`, and the generic handler's `{error: true, message: "..."}`.
    // Reading `error` blindly turned the second kind into the word "true",
    // which is what the tracer showed instead of telling you the save had
    // been refused.
    const said = [data.detail, data.message, typeof data.error === "string" && data.error]
      .find((v) => typeof v === "string" && v.trim());
    throw new Error(said || `Request failed (${res.status})`);
  }
  return data;
}

const token = document.querySelector('meta[name="mapbox-token"]')?.content;
if (!token) throw new Error("Missing Mapbox token");
mapboxgl.accessToken = token;

const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/streets-v12",
  center: [BCIT.lng, BCIT.lat],
  zoom: BCIT.zoom,
});
map.addControl(new mapboxgl.NavigationControl(), "top-right");

// exposed so the map can be inspected from the console while tracing
window.BCITTracer = {
  map,
  state: () => ({ current, placement, rooms, draft }),
  handles: () => ({ move: moveMarker, size: sizeMarker, rotate: rotateMarker }),
  overview: () => overviewFeatures,
  refresh: () => loadOverview(),
  // the actual redraw, so its cost can be measured rather than guessed at
  redraw: () => redrawRooms(),
  time: () => { profile = {}; redrawRooms(); const p = profile; profile = null; return p; },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let plans = [];
let current = null;      // the plan being traced
let placement = null;    // { lng, lat, widthM, rotation } -- where the plan sits
let rooms = [];          // [{ kind, uv, room, type, name }] -- outlines and markers
// A door or an entrance is a position, not an area, so it is placed with a
// single click and stored as one point. Everything else is an outline.
const POINT_TYPES = new Set(["door", "entrance", "node"]);
const isPointType = (t) => POINT_TYPES.has(t);
// "path" is drawn as a chain: each click drops (or reuses) a walking node and
// joins it to the one before, which is the quickest way to lay a network of
// straight runs down a corridor.
// Linking is its own deliberate act: click one node, then the other. Placing
// a node used to also draw a path back to the previous one, which meant you
// could not simply drop nodes where you wanted them without also committing
// to the order you happened to place them in.
const isLinkType = (t) => t === "link";

/** The type currently being drawn, from whichever mode is active. */
const activeType = () =>
  (mode === "network" ? el("netType") : el("drawType")).value;

/** Does this item belong to the mode being worked on? */
const inNetwork = (r) => r.kind === "path" || r.type === "node";
const itemInMode = (r) => (mode === "network" ? inNetwork(r) : !inNetwork(r));

let nodeSeq = 0;
const newNodeId = () => `n${Date.now().toString(36)}${(nodeSeq++).toString(36)}`;
let draft = null;        // uv points of the room being drawn
let editingIndex = -1;
let dirty = false;
let adjusting = false;   // placement handles shown
let mode = "plan";       // "plan" = what the floor is, "network" = how you walk it
let selected = -1;       // index of the thing being worked on, -1 for none
let moveMarker = null;
let sizeMarker = null;
let rotateMarker = null;
let planHidden = false;

const IMG_SRC = "plan-image";
const ROOMS_SRC = "traced-rooms";
const MARKS_SRC = "traced-marks";
const PATHS_SRC = "traced-paths";
const CAMPUS_SRC = "campus-buildings";
const PARKING_SRC = "campus-parking";
const OVERVIEW_SRC = "traced-overview";
const DRAFT_SRC = "draft-room";

// ---------------------------------------------------------------------------
// Plan space <-> world
//
// The plan sits on the map as a rigid rectangle: a drawing does not stretch,
// so where it is is fully described by a centre, a width and an angle.
// ---------------------------------------------------------------------------
const mPerDegLat = () => (Math.PI / 180) * R_EARTH;
const mPerDegLng = (lat) => mPerDegLat() * Math.cos((lat * Math.PI) / 180);

const planSize = () => ({
  widthM: placement.widthM,
  heightM: placement.widthM / (current.width / current.height),
});

/** (u, v), a fraction across and down the drawing, -> [lng, lat] */
function uvToLngLat([u, v]) {
  const { widthM, heightM } = planSize();
  const x = (u - 0.5) * widthM;
  const y = (0.5 - v) * heightM;
  const th = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  return [
    placement.lng + (x * cos - y * sin) / mPerDegLng(placement.lat),
    placement.lat + (x * sin + y * cos) / mPerDegLat(),
  ];
}

/** [lng, lat] -> (u, v); the inverse, used when you click on the map */
function lngLatToUv([lng, lat]) {
  // No sheet open means no plan space to be in. The network does not need
  // one -- it is held in world coordinates -- so this answers "nowhere on a
  // drawing" rather than throwing, which is what placing a node with no
  // floor open used to do.
  if (!placement || !current) return null;
  const { widthM, heightM } = planSize();
  const dx = (lng - placement.lng) * mPerDegLng(placement.lat);
  const dy = (lat - placement.lat) * mPerDegLat();
  const th = (-placement.rotation * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  return [
    (dx * cos - dy * sin) / widthM + 0.5,
    0.5 - (dx * sin + dy * cos) / heightM,
  ];
}

const imageCorners = () => [[0, 0], [1, 0], [1, 1], [0, 1]].map(uvToLngLat);

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
const emptyFC = () => ({ type: "FeatureCollection", features: [] });

/**
 * Run something once the map style can take layers.
 *
 * Deliberately a poll rather than an event. This module is deferred, so
 * "load" has usually already fired by the time it runs, and "styledata" turns
 * out to fire only while the style is still incomplete -- so a listener added
 * afterwards is never called and the layers are never created. Checking the
 * state directly cannot miss, whichever order things happen in.
 */
function whenStyleReady(fn) {
  // isStyleLoaded() is false until every source in the style has loaded too,
  // which in a background or throttled tab may be never -- and then nothing
  // gets drawn at all. What actually has to be true before addSource and
  // addLayer is that the style itself is parsed, which is what style._loaded
  // says and what the 'style.load' event announces.
  const ready = () => map.isStyleLoaded() || map.style?._loaded === true;
  if (ready()) return fn();
  // the poll and the event can both come good; whichever is first wins, and
  // the other must not run the callback a second time
  let done = false;
  const run = () => {
    if (done || !ready()) return;
    done = true;
    clearInterval(timer);
    fn();
  };
  const timer = setInterval(run, 60);
  map.once("style.load", run);
  return undefined;
}

function ensureLayers() {
  if (!map.getSource(ROOMS_SRC)) {
    map.addSource(ROOMS_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "traced-fill", type: "fill", source: ROOMS_SRC,
      paint: { "fill-color": "#1a73e8", "fill-opacity": 0.22 },
    });
    map.addLayer({
      id: "traced-line", type: "line", source: ROOMS_SRC,
      paint: { "line-color": "#1a73e8", "line-width": 2 },
    });
    map.addLayer({
      id: "traced-label", type: "symbol", source: ROOMS_SRC,
      layout: { "text-field": ["get", "room"], "text-size": 12 },
      paint: { "text-color": "#0b3d91", "text-halo-color": "#fff", "text-halo-width": 1.5 },
    });
  }
  if (!map.getSource(MARKS_SRC)) {
    map.addSource(MARKS_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "marks-dot", type: "circle", source: MARKS_SRC,
      paint: {
        // the selected one grows and turns blue, so it is obvious which of
        // sixty-odd identical dots you are about to change
        "circle-radius": ["case", ["get", "selected"], 9, 6],
        "circle-color": ["case", ["get", "selected"], "#1a73e8",
          ["match", ["get", "type"], "entrance", "#16a34a", "#f59e0b"]],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": ["case", ["get", "selected"], 3, 2],
      },
    });
    map.addLayer({
      id: "marks-label", type: "symbol", source: MARKS_SRC,
      layout: {
        "text-field": ["get", "mapLabel"],
        "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top",
      },
      paint: { "text-color": "#7c2d12", "text-halo-color": "#fff", "text-halo-width": 1.5 },
    });
  }
  if (!map.getSource(PATHS_SRC)) {
    map.addSource(PATHS_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "paths-line", type: "line", source: PATHS_SRC,
      paint: {
        // the selected link is what Delete will take, so it should look it
        "line-color": ["case", ["boolean", ["get", "selected"], false], "#dc2626", "#7c3aed"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 6, 3],
        "line-opacity": 0.9,
      },
    });
  }
  if (!map.getSource(CAMPUS_SRC)) {
    // Every building on campus, faintly, underneath everything. The network
    // is campus-wide now, so tracing a path to SW7 means being able to see
    // where SW7 is -- without this you are placing nodes on blank ground and
    // hoping.
    map.addSource(CAMPUS_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "campus-fill", type: "fill", source: CAMPUS_SRC,
      paint: { "fill-color": "#60a5fa", "fill-opacity": 0.08 },
    });
    map.addLayer({
      id: "campus-line", type: "line", source: CAMPUS_SRC,
      paint: { "line-color": "#2563eb", "line-width": 1, "line-opacity": 0.35 },
    });
    map.addLayer({
      id: "campus-label", type: "symbol", source: CAMPUS_SRC,
      layout: { "text-field": ["get", "BuildingName"], "text-size": 11 },
      paint: {
        "text-color": "#1d4ed8", "text-opacity": 0.55,
        "text-halo-color": "#fff", "text-halo-width": 1.2,
      },
    });
  }
  if (!map.getSource(PARKING_SRC)) {
    map.addSource(PARKING_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "parking-fill", type: "fill", source: PARKING_SRC,
      paint: { "fill-color": "#8b5cf6", "fill-opacity": 0.1 },
    });
    map.addLayer({
      id: "parking-line", type: "line", source: PARKING_SRC,
      paint: { "line-color": "#6d28d9", "line-width": 1, "line-opacity": 0.4 },
    });
    map.addLayer({
      id: "parking-label", type: "symbol", source: PARKING_SRC,
      filter: ["==", ["get", "label"], true],
      layout: { "text-field": ["get", "name"], "text-size": 10 },
      paint: {
        "text-color": "#5b21b6", "text-opacity": 0.6,
        "text-halo-color": "#fff", "text-halo-width": 1.2,
      },
    });
  }
  if (!map.getSource(OVERVIEW_SRC)) {
    // Everything already traced, campus-wide, sitting under the working
    // layers. Without it the tracer opens on a blank map and there is no way
    // to see -- or get back to -- what you have already done.
    map.addSource(OVERVIEW_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "overview-fill", type: "fill", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#64748b", "fill-opacity": 0.18 },
    });
    map.addLayer({
      id: "overview-line", type: "line", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "line-color": "#475569", "line-width": 1 },
    });
    map.addLayer({
      id: "overview-dot", type: "circle", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 3, "circle-color": "#94a3b8" },
    });
    map.addLayer({
      id: "overview-label", type: "symbol", source: OVERVIEW_SRC,
      // One label per floor, on the marker made for it -- writing the sheet
      // name across every room on the sheet said the same thing forty times
      // and told you nothing about any of them.
      filter: ["==", ["get", "kind"], "sheet-label"],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#334155", "text-halo-color": "#fff", "text-halo-width": 1.5,
      },
    });
  }
  if (!map.getSource(DRAFT_SRC)) {
    map.addSource(DRAFT_SRC, { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "draft-fill", type: "fill", source: DRAFT_SRC,
      paint: { "fill-color": "#ef4444", "fill-opacity": 0.2 },
    });
    map.addLayer({
      id: "draft-line", type: "line", source: DRAFT_SRC,
      paint: { "line-color": "#ef4444", "line-width": 2, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "draft-pts", type: "circle", source: DRAFT_SRC,
      filter: ["==", "$type", "Point"],
      paint: { "circle-radius": 4, "circle-color": "#ef4444" },
    });
  }
}

const round6 = ([u, v]) => [Number(u.toFixed(6)), Number(v.toFixed(6))];

// Every link has to find the two nodes it joins, and it used to do that by
// scanning the whole list -- so drawing the network cost links x items. At a
// few hundred that is imperceptible; at eight thousand it was most of a
// second per redraw, and a redraw happens on every click. An index turns each
// lookup into one step, and is thrown away whenever the list changes so it
// cannot go stale.
let nidIndex = null;

function forgetNodeIndex() {
  nidIndex = null;
}

const nodeById = (nid) => {
  if (!nidIndex) {
    nidIndex = new Map();
    for (const r of rooms) {
      if (r.nid) nidIndex.set(r.nid, r);
    }
  }
  return nidIndex.get(nid);
};

/**
 * Where an item is, in the world.
 *
 * Plan items are held in plan space so they move with the drawing they were
 * traced on. Network items are held in world coordinates, because a path
 * across the campus belongs to no drawing and must not move when one is
 * nudged into place.
 */
function itemLngLat(r) {
  return r.ll ? r.ll : uvToLngLat(r.uv);
}

/** The same position in plan space, which is what the drawing code works in. */
function itemUv(r) {
  return r.ll ? lngLatToUv(r.ll) : r.uv;   // null when no plan is open
}

function pathFeature(r) {
  const a = nodeById(r.nodes[0]);
  const b = nodeById(r.nodes[1]);
  if (!a || !b) return null; // an endpoint was deleted
  return {
    type: "Feature",
    properties: { type: "path", nodes: [...r.nodes] },
    geometry: { type: "LineString", coordinates: [itemLngLat(a), itemLngLat(b)] },
  };
}

function roomFeature(r) {
  if (r.kind === "path") return pathFeature(r);
  if (r.type === "node") return nodeFeature(r);
  const props = {
    room: r.room || null, building: current.building, floor: current.floor,
    type: r.type || "room", source: "traced",
    // kept so the floor can be reopened and repositioned later without having
    // to work out again where each feature sat on the drawing
    uv: r.kind === "point" ? round6(r.uv) : r.uv.map(round6),
  };
  // a walking node carries its own id so the paths between them survive a
  // reload, and remembers which space it serves if it was tied to one
  if (r.nid) props.nid = r.nid;
  if (r.name) props.name = r.name;
  // what the room offers, which is not the same question as what the router
  // does with it -- a washroom is a room you can be sent to like any other
  if (r.amenity) props.amenity = r.amenity;
  // What a marker joins, named rather than guessed. The router reads this
  // directly, so a door you place between 1710 and the corridor connects
  // exactly those two, instead of whatever happened to be nearest.
  if (r.connects) props.connects = r.connects;

  if (r.kind === "point") {
    return {
      type: "Feature", properties: props,
      geometry: { type: "Point", coordinates: uvToLngLat(r.uv) },
    };
  }
  const ring = r.uv.map(uvToLngLat);
  ring.push(ring[0]);
  return {
    type: "Feature", properties: props,
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/**
 * The name a thing goes by, in the list and on the map alike.
 *
 * They used to disagree: the map labelled a node with the room it served (or
 * "node" when it served none) while the list called it "Node 7", so there was
 * no way to tell which row belonged to which dot.
 */
function displayNames() {
  const seen = {};
  // Nodes are numbered first so a link can be named after the two it joins:
  // "Link 4" told you nothing about which line on the map it was.
  const nodeNo = new Map();
  rooms.forEach((r) => {
    if (r.type === "node" && r.nid) nodeNo.set(r.nid, nodeNo.size + 1);
  });
  const endName = (nid) => {
    const n = nodeNo.get(nid);
    if (!n) return "?";
    const node = nodeById(nid);
    return node?.room ? `N${n} (${node.room})` : `N${n}`;
  };

  return rooms.map((r) => {
    if (r.kind === "path") {
      seen.path = (seen.path || 0) + 1;
      const [a, b] = r.nodes || [];
      return {
        title: `Link ${endName(a)} \u2194 ${endName(b)}`,
        sub: "path",
      };
    }
    if (r.type === "node") {
      seen.node = (seen.node || 0) + 1;
      return {
        title: `Node ${seen.node}`,
        sub: r.room ? `serves ${r.room}` : "unassigned",
        short: `N${seen.node}${r.room ? ` · ${r.room}` : ""}`,
      };
    }
    if (isPointType(r.type)) {
      seen[r.type] = (seen[r.type] || 0) + 1;
      const what = r.type === "entrance" ? "Entrance" : "Door";
      return {
        title: `${what} ${seen[r.type]}`,
        sub: (r.connects || []).join(" ↔ ") || "unlinked",
        short: `${what[0]}${seen[r.type]}`,
      };
    }
    return { title: r.room || "(unnumbered)", sub: r.type, short: r.room || "" };
  });
}

let names = [];

// The campus footprints, so a node can say which building it stands in rather
// than inheriting one from whichever sheet was open. Loaded once; until it
// arrives a node simply has no building, which is corrected the moment it is
// dragged or the page is opened again.
let campus = [];

// Whether the campus network was actually read from the server. Until it has
// been, there is nothing safe to write back.
let networkLoaded = false;

// What the server had when we last agreed with it: which version, and a
// signature per feature so a save can send what changed instead of the whole
// campus. Correctness first -- if any of this is missing or in doubt, the
// whole document goes, which always works.
let netVersion = null;
let netBaseline = new Map();   // feature key -> signature of its contents

async function loadCampus() {
  const shapes = (fc, nameOf) => (fc.features || [])
    .map((f) => ({
      name: nameOf(f.properties || {}),
      rings: f.geometry?.type === "Polygon"
        ? [f.geometry.coordinates[0]]
        : (f.geometry?.coordinates || []).map((poly) => poly[0]),
    }))
    .filter((b) => b.name && b.rings.length);

  try {
    const fc = await fetchJson("/data/bcit-coordinates.geojson");
    // Car parks are places too: a node standing in Lot L belongs to Lot L,
    // the same way one in SW3 belongs to SW3, and that is what makes a lot
    // somewhere you can be routed to.
    let lots = { features: [] };
    try {
      lots = await fetchJson("/data/parking-lots.geojson");
    } catch { /* the campus is still usable without them */ }

    whenStyleReady(() => {
      ensureLayers();
      map.getSource(CAMPUS_SRC)?.setData({
        type: "FeatureCollection",
        features: (fc.features || []).filter((f) => (f.properties || {}).BuildingName),
      });
      map.getSource(PARKING_SRC)?.setData(lots);
    });

    // Buildings first: where a lot outline overlaps a building, the building
    // is the more specific answer.
    campus = shapes(fc, (p) => p.BuildingName)
      .concat(shapes(lots, (p) => p.name));
  } catch {
    campus = []; // the tracer works without it; nodes just carry no building
  }
}

/** The bounding box of a ring, computed once and kept. */
function ringBox(ring) {
  if (ring.__box) return ring.__box;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const box = [x0, y0, x1, y1];
  Object.defineProperty(ring, "__box", { value: box, enumerable: false });
  return box;
}

function inRing(ring, [x, y]) {
  // A box test first: a point is outside almost every outline on campus, and
  // rejecting those in four comparisons beats walking their vertices.
  const [x0, y0, x1, y1] = ringBox(ring);
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  let inside = false;
  for (let i = 0; i < ring.length; i += 1) {
    const j = (i - 1 + ring.length) % ring.length;
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The building a world position falls in, or null for outdoors. */
function buildingAt(lngLat) {
  for (const b of campus) {
    if (b.rings.some((r) => inRing(r, lngLat))) return b.name;
  }
  return null;
}

/**
 * A walking node, as it is stored: a position in the world, the building it
 * stands in and the space it serves. No plan-space coordinates and no source
 * sheet -- the node is not part of a drawing.
 */
function nodeFeature(r) {
  return {
    type: "Feature",
    properties: {
      type: "node",
      nid: r.nid,
      // Which building it is in is a fact about where it stands, worked out
      // when the node is placed or moved -- not here. Drawing is not the
      // moment to ask a geometric question: this ran a point-in-polygon test
      // against every outline on campus for every node without a building,
      // which is most of them, on every redraw. Outdoors is a real answer and
      // is kept as null rather than recomputed for ever.
      building: r.building ?? null,
      floor: r.floor ?? null,
      room: r.room || null,
    },
    geometry: { type: "Point", coordinates: itemLngLat(r) },
  };
}

/** The map copy of an item, tagged with where it lives in the list. */
function renderFeature(r, i) {
  const f = roomFeature(r);
  if (!f) return null;
  // only for hit-testing and labelling on the map; the saved file never sees it
  f.properties = {
    ...f.properties, idx: i, selected: i === selected,
    mapLabel: names[i]?.short || "",
  };
  return f;
}

// Timings for the redraw, filled in when someone is measuring. Free when
// nobody is: one comparison per redraw.
let profile = null;
function mark(label, t0) {
  if (profile) profile[label] = Math.round((performance.now() - t0) * 10) / 10;
}

function redrawRooms() {
  // Rebuilt here rather than lazily, so a redraw always works from a current
  // index even if some mutation forgot to say it had changed things.
  forgetNodeIndex();
  let t0 = performance.now();
  names = displayNames();
  mark("names", t0);

  t0 = performance.now();
  const built = rooms.map(renderFeature).filter(Boolean);
  mark("features", t0);
  map.getSource(PATHS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "LineString"),
  });
  applyModeStyling();
  map.getSource(ROOMS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "Polygon"),
  });
  t0 = performance.now();
  map.getSource(MARKS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "Point"),
  });
  mark("sources", t0);
  scheduleListRender();
}

// Every node placed redraws the map and the list. The map is a source
// update; the list is several hundred rows of DOM, rebuilt from scratch. At a
// few hundred items that is a stutter and at a few thousand it is a wall --
// which is a limit on how much network you can draw, so the list waits for a
// frame and a run of quick clicks costs one rebuild rather than twenty.
let listPending = null;
function scheduleListRender() {
  if (listPending) return;
  // A timer rather than requestAnimationFrame: a browser stops handing out
  // frames to a tab that is not on screen, and the list would then quietly
  // stop matching what has been placed.
  listPending = setTimeout(() => {
    listPending = null;
    const t0 = performance.now();
    renderRoomList();
    if (profile) profile.list = Math.round((performance.now() - t0) * 10) / 10;
  }, 16);
}

/**
 * Fade whichever layer is not being worked on.
 *
 * Both live on the same map, and a network drawn over a full floor plan is
 * unreadable if they compete -- so the one you are not editing drops back to
 * being context.
 */
function applyModeStyling() {
  const net = mode === "network";
  const set = (layer, prop, value) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };
  const show = (layer, on) => {
    if (map.getLayer(layer)) {
      map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
    }
  };
  const filter = (layer, f) => {
    if (map.getLayer(layer)) map.setFilter(layer, f);
  };

  set("traced-fill", "fill-opacity", net ? 0.07 : 0.22);
  set("traced-line", "line-opacity", net ? 0.35 : 1);
  set("traced-label", "text-opacity", net ? 0.35 : 1);

  // The network is shown when you are working on it and gone when you are
  // not. Fading it to 30% still left a web of lines over every room while
  // tracing a floor; it is a different job, so it is a different picture.
  show("paths-line", net);
  // Nodes and markers share a layer. In network mode the nodes are the point
  // and the doorways are not; on the floor plan it is the other way round.
  filter("marks-dot", net
    ? ["==", ["get", "type"], "node"]
    : ["!=", ["get", "type"], "node"]);
  filter("marks-label", net
    ? ["==", ["get", "type"], "node"]
    : ["!=", ["get", "type"], "node"]);
  set("marks-dot", "circle-opacity", 1);
}

function setMode(next) {
  mode = next;
  selected = -1;
  cancelDraft();
  setAdjusting(false);   // positioning the drawing is a floor-plan job
  el("modePlan").classList.toggle("is-active", next === "plan");
  el("modeNetwork").classList.toggle("is-active", next === "network");
  // one task on screen at a time: the whole block for the other one goes
  el("planMode").hidden = next !== "plan";
  el("networkMode").hidden = next !== "network";
  el("listBlock").hidden = next !== "plan";
  el("netListBlock").hidden = next !== "network";
  el("netToolsResult").hidden = true;
  el("startNetDraw").textContent = networkButtonLabel();
  setDrawHint(next === "network"
    ? "Click where someone can stand. A node inside a building belongs to it."
    : "Click each corner, then Finish. Double-click also closes it.");
  applyModeStyling();
  renderRoomList();
}

function redrawDraft() {
  const src = map.getSource(DRAFT_SRC);
  if (!src) return;
  // a path chain draws itself into the real layers as it goes, so there is
  // no separate draft outline to show
  const t = activeType();
  if (!draft || !draft.length || t === "node" || isLinkType(t)) {
    return src.setData(emptyFC());
  }
  const pts = draft.map(uvToLngLat);
  const fs = pts.map((c) => ({
    type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c },
  }));
  if (pts.length >= 3) {
    fs.push({
      type: "Feature", properties: {},
      geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] },
    });
  } else if (pts.length === 2) {
    fs.push({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: pts },
    });
  }
  src.setData({ type: "FeatureCollection", features: fs });
}

// ---------------------------------------------------------------------------
// The plan image
// ---------------------------------------------------------------------------
function applyPlacement() {
  if (!current || !placement) return;
  const coords = imageCorners();
  const src = map.getSource(IMG_SRC);
  if (src && src.updateImage) {
    src.updateImage({ url: current.image, coordinates: coords });
  } else {
    if (map.getLayer("plan-image-layer")) map.removeLayer("plan-image-layer");
    if (map.getSource(IMG_SRC)) map.removeSource(IMG_SRC);
    map.addSource(IMG_SRC, { type: "image", url: current.image, coordinates: coords });
    map.addLayer({
      id: "plan-image-layer", type: "raster", source: IMG_SRC,
      paint: { "raster-opacity": planHidden ? 0 : Number(el("opacity").value) / 100 },
    }, map.getLayer("traced-fill") ? "traced-fill" : undefined);
  }
  // the rooms are anchored to the drawing, so they move with it
  redrawRooms();
  redrawDraft();
  positionHandles();
  syncAdjustFields();
}

// Where each handle sits, in plan space: the size grip on the bottom-right
// corner, and the rotate grip on a stalk above the top edge -- clear of the
// drawing so the two are never confused for one another.
const SIZE_UV = [1, 1];
const ROTATE_UV = [0.5, -0.06];

function positionHandles() {
  if (!placement || !current) return;
  if (moveMarker) moveMarker.setLngLat([placement.lng, placement.lat]);
  if (sizeMarker) sizeMarker.setLngLat(uvToLngLat(SIZE_UV));
  if (rotateMarker) rotateMarker.setLngLat(uvToLngLat(ROTATE_UV));
}

/** Pointer offset from the plan's centre, in metres. */
function offsetFromCentre(lngLat) {
  return [
    (lngLat.lng - placement.lng) * mPerDegLng(placement.lat),
    (lngLat.lat - placement.lat) * mPerDegLat(),
  ];
}

function makeHandles() {
  clearHandles();
  const mk = (cls, title) => {
    const d = document.createElement("div");
    d.className = `tracer-handle ${cls}`;
    d.title = title;
    return d;
  };

  // Move: drag the plan bodily. Size and angle are untouched.
  moveMarker = new mapboxgl.Marker({ element: mk("move", "Drag to move"), draggable: true })
    .setLngLat([placement.lng, placement.lat]).addTo(map);
  moveMarker.on("drag", () => {
    const p = moveMarker.getLngLat();
    placement.lng = p.lng;
    placement.lat = p.lat;
    applyPlacement();
    markDirty();
  });

  // Size: drag the corner in or out. The angle is deliberately held, because
  // a single handle doing both meant you could not resize without also
  // nudging the rotation you had just got right.
  const aspect = () => current.width / current.height;
  const halfDiagPerWidth = () => Math.hypot(1, 1 / aspect()) / 2;

  sizeMarker = new mapboxgl.Marker({ element: mk("size", "Drag to resize"), draggable: true })
    .setLngLat(uvToLngLat(SIZE_UV)).addTo(map);
  sizeMarker.on("drag", () => {
    const [dx, dy] = offsetFromCentre(sizeMarker.getLngLat());
    placement.widthM = Math.max(2, Math.hypot(dx, dy) / halfDiagPerWidth());
    applyPlacement();
    markDirty();
  });

  // Rotate: swing the stalk round the centre. The size is held.
  rotateMarker = new mapboxgl.Marker({ element: mk("rotate", "Drag to rotate"), draggable: true })
    .setLngLat(uvToLngLat(ROTATE_UV)).addTo(map);
  rotateMarker.on("drag", () => {
    const [dx, dy] = offsetFromCentre(rotateMarker.getLngLat());
    if (!dx && !dy) return;
    // the stalk points straight up out of the plan, so the plan's angle is
    // wherever the stalk is now, less that quarter turn
    placement.rotation = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
    applyPlacement();
    markDirty();
  });
}

function clearHandles() {
  for (const m of [moveMarker, sizeMarker, rotateMarker]) if (m) m.remove();
  moveMarker = sizeMarker = rotateMarker = null;
}

function setAdjusting(on) {
  adjusting = on;
  if (on) {
    cancelDraft();
    makeHandles();
  } else {
    clearHandles();
    savePlacement();
  }
  el("adjustToggle").textContent = on ? "Done Positioning" : "Move / Rotate Plan";
  el("adjustToggle").classList.toggle("tracer-primary", on);
  el("adjustHint").hidden = !on;
}

/** Drop the plan roughly over its own building, so there is less to drag. */
async function fitToBuilding() {
  if (!current) return false;
  try {
    const res = await fetch("/data/bcit-coordinates.geojson", { cache: "force-cache" });
    const fc = await res.json();
    const code = current.building.toUpperCase();
    const rings = [];
    for (const f of fc.features || []) {
      if ((f.properties?.BuildingName || "").trim().toUpperCase() !== code) continue;
      const g = f.geometry;
      if (g.type === "Polygon") rings.push(g.coordinates[0]);
      else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => rings.push(p[0]));
    }
    if (!rings.length) return false;
    const pts = rings.flat();
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    const lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const widthM = (Math.max(...lngs) - Math.min(...lngs)) * mPerDegLng(lat);
    placement = { lng, lat, widthM: Math.max(widthM, 20), rotation: placement?.rotation ?? 0 };
    applyPlacement();
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)]], { padding: 80, duration: 600 });
    markDirty();
    return true;
  } catch {
    return false;
  }
}

/** Frame the drawing itself, which is where you want to be while tracing. */
function zoomToPlan() {
  if (!placement) return;
  const c = imageCorners();
  const lngs = c.map((p) => p[0]), lats = c.map((p) => p[1]);
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)]], { padding: 40, duration: 500 });
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function snappedUv(lngLat) {
  // reuse a nearby corner so neighbouring rooms share a wall exactly instead
  // of leaving a sliver between them
  const here = map.project(lngLat);
  let best = null, bestD = SNAP_PX;
  const consider = (uv) => {
    const p = map.project(uvToLngLat(uv));
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    if (d < bestD) { bestD = d; best = uv; }
  };
  // Only an outline has corners to share. A marker is one position, not a
  // ring of them, and a link has no shape of its own -- reading either as a
  // list of corners threw on the first click of a new room, which is every
  // click once a floor has nodes on it.
  for (const r of rooms) {
    if (r.kind !== "polygon" || !Array.isArray(r.uv)) continue;
    r.uv.forEach(consider);
  }
  if (draft) draft.forEach(consider);
  return best ? [best[0], best[1]] : lngLatToUv([lngLat.lng, lngLat.lat]);
}

/**
 * Any marker under the pointer -- a node, a doorway, an entrance -- as an
 * index into the list. Only ones belonging to the mode being worked on, so
 * dragging a room's doorway while tracing the network is not possible.
 */
/**
 * How far SNAP_PX reaches, in degrees, at the current view.
 *
 * Projecting a point is not free, and the hit test ran it over every marker
 * on the campus for every mouse move. Almost all of them are nowhere near the
 * pointer, and a subtraction is enough to say so.
 */
function snapReach() {
  const c = map.getCenter();
  const p = map.project(c);
  const edge = map.unproject([p.x + SNAP_PX, p.y + SNAP_PX]);
  return {
    lng: Math.abs(edge.lng - c.lng) * 1.5,   // a margin for rotation
    lat: Math.abs(edge.lat - c.lat) * 1.5,
  };
}

function pointIndexNear(lngLat) {
  const here = map.project(lngLat);
  const reach = snapReach();
  let best = -1, bestD = SNAP_PX;
  for (let i = 0; i < rooms.length; i += 1) {
    const r = rooms[i];
    if (r.kind !== "point" || !itemInMode(r)) continue;
    const at = itemLngLat(r);
    if (!at) continue;
    // the cheap rejection, before the expensive projection
    if (Math.abs(at[0] - lngLat.lng) > reach.lng) continue;
    if (Math.abs(at[1] - lngLat.lat) > reach.lat) continue;
    const p = map.project(at);
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** The walking node under the pointer, if there is one. */
function nodeNear(lngLat) {
  const here = map.project(lngLat);
  const reach = snapReach();
  let best = null, bestD = SNAP_PX;
  for (const r of rooms) {
    if (r.kind !== "point" || r.type !== "node") continue;
    const at = itemLngLat(r);
    if (!at) continue;
    if (Math.abs(at[0] - lngLat.lng) > reach.lng) continue;
    if (Math.abs(at[1] - lngLat.lat) > reach.lat) continue;
    const p = map.project(at);
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    if (d <= bestD) { bestD = d; best = r; }
  }
  return best;
}

/** What was clicked on the map, as an index into the list. */
function hitIndex(point) {
  // Dots first, then links, then outlines: where a link ends at a node the
  // node is what you meant to click, and the link is what you meant when you
  // clicked the middle of it. Links were not in this list at all, so the only
  // way to remove one was to find it in the list -- which named them "Link 4".
  const layers = ["marks-dot", "paths-line", "traced-fill"].filter((l) => map.getLayer(l));
  if (!layers.length) return -1;
  // a small box rather than a bare point, because a 6px dot is hard to hit
  const box = [
    [point.x - 8, point.y - 8],
    [point.x + 8, point.y + 8],
  ];
  for (const layer of layers) {
    const hits = map.queryRenderedFeatures(box, { layers: [layer] });
    for (const h of hits) {
      const i = h.properties?.idx;
      if (typeof i === "number" && rooms[i] && itemInMode(rooms[i])) return i;
    }
  }
  return -1;
}

function selectItem(i) {
  selected = i;
  redrawRooms();
  // With a hundred rows the matching one is almost always off-screen, so
  // clicking a dot on the map looked like it did nothing to the list.
  const row = el("roomList").querySelector(`.tracer-room[data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  if (i < 0) return;
  // A link has nothing to fill in -- it is two nodes and the fact that they
  // join -- so opening the room dialog on one asked for a room number and a
  // name that mean nothing. Selecting it and saying how to remove it is the
  // whole of what you can do with one.
  if (rooms[i]?.kind === "path") {
    setDrawHint(`${names[i]?.title || "Link"} selected — press Delete to remove it.`);
    return;
  }
  openDialog(i);
}

function onMapClick(e) {
  // A drag finishes with a click. Without this, letting go of a node you had
  // just moved counted as a click on the map -- which in the link tool
  // started a link, and with the node tool tried to drop another node.
  if (dragMoved) { dragMoved = false; return; }
  // not drawing: a click picks up whatever is under it, which is how you edit
  // or delete one of many identical nodes without hunting through the list
  if (adjusting) return;
  if (!draft) {
    const i = hitIndex(e.point);
    if (i >= 0) return selectItem(i);

    // nothing of this floor's under the pointer: if another traced floor is,
    // open it -- clicking your own work is the obvious way back into it
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    for (const layer of ["overview-fill", "overview-dot"]) {
      if (!map.getLayer(layer)) continue;
      const hit = map.queryRenderedFeatures(box, { layers: [layer] })[0];
      const stem = hit?.properties?.stem;
      if (stem && stem !== current?.stem) {
        el("planPicker").value = stem;
        loadPlan(stem);
        return;
      }
    }
    return;
  }
  const type = activeType();

  if (isLinkType(type)) {
    // both ends must be nodes that already exist -- a link joins things you
    // put there on purpose, it does not invent them
    const node = nodeNear(e.lngLat);
    if (!node) {
      setDrawHint("Click directly on a node. Nothing to link to there.");
      return;
    }
    const first = draft.length ? draft[0] : null;
    if (!first) {
      draft.push(node.nid);
      setDrawHint("Now click the node to link it to.");
      return;
    }
    if (first === node.nid) {
      setDrawHint("Pick a different node for the other end.");
      return;
    }
    // Clicking a pair that is already joined removes the link. Refusing was
    // the unhelpful answer: the tool for making links is where you look when
    // you want to unmake one, and picking the two ends is how you say which.
    const existing = rooms.findIndex((r) => r.kind === "path"
      && r.nodes.includes(first) && r.nodes.includes(node.nid));
    if (existing >= 0) rooms.splice(existing, 1);
    else rooms.push({ kind: "path", nodes: [first, node.nid] });
    forgetNodeIndex();
    draft = [];
    selected = -1;
    redrawRooms();
    markDirty();
    setDrawHint(existing >= 0
      ? "Unlinked. Click the same two nodes again to put it back."
      : "Linked. Click a node to start another link.");
    return;
  }

  if (type === "node") {
    // one node per click, and stay put so a run of them can be dropped
    // without going back to the button each time
    if (nodeNear(e.lngLat)) {
      setDrawHint("There is already a node there.");
      return;
    }
    // A node dropped inside a room is a node FOR that room -- which is what
    // makes it routable -- so it takes the name of whatever it lands on
    // rather than waiting to be told afterwards.
    const ll = [e.lngLat.lng, e.lngLat.lat];
    // which traced room it lands in, if a floor is open to land on
    const servedRoom = roomAtUv(lngLatToUv(ll));
    forgetNodeIndex();
    rooms.push({
      kind: "point", type: "node", nid: newNodeId(),
      // world coordinates: a node is part of the campus network, not of the
      // drawing that happened to be open when it was placed
      ll,
      room: servedRoom,
      building: buildingAt(ll),
      // the floor only means something if this is the building whose floor
      // is open; a node dropped anywhere else is on no particular floor
      floor: current && buildingAt(ll) === current.building ? current.floor : null,
    });
    redrawRooms();
    markDirty();
    const n = rooms.filter((r) => r.type === "node").length;
    setDrawHint(servedRoom
      ? `${n} nodes placed — this one serves ${servedRoom}.`
      : `${n} nodes placed — this one is not inside a numbered outline.`);
    return;
  }

  if (isPointType(type)) {
    rooms.push({ kind: "point", uv: snappedUv(e.lngLat), room: null, type });
    forgetNodeIndex();
    draft = null;
    redrawDraft();
    setDrafting(false);
    redrawRooms();
    markDirty();
    openDialog(rooms.length - 1);
    return;
  }
  draft.push(snappedUv(e.lngLat));
  redrawDraft();
}

function setDrawHint(text) {
  const target = mode === "network" ? el("netHint") : el("drawHint");
  if (target) target.textContent = text;
}

function setDrafting(on) {
  // a marker is one click, so it has nothing to finish or undo
  // nodes and links have nothing to "finish" -- each click completes itself
  const t = activeType();
  el("draftControls").hidden = !on || isPointType(t) || isLinkType(t);
  // ...but placing nodes and drawing links run until you stop them, and
  // until now the only way to stop was Esc or switching tool. A visible Done
  // is what tells you the mode is still on, as well as how to leave it.
  el("doneNetDraw").hidden = !(on && (t === "node" || isLinkType(t)));
  el("startDraw").disabled = on;
  el("startNetDraw").disabled = on;
  // double-click finishes a room, so it must not also zoom the map
  if (on) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = on ? "crosshair" : "";
}

function finishDraft() {
  if (!draft || draft.length < 3) return;
  rooms.push({ kind: "polygon", uv: draft, room: null, type: activeType() });
  forgetNodeIndex();
  draft = null;
  redrawDraft();
  setDrafting(false);
  redrawRooms();
  markDirty();
  openDialog(rooms.length - 1);
}

function cancelDraft() {
  draft = null;
  redrawDraft();
  setDrafting(false);
}

// ---------------------------------------------------------------------------
// Room list + details
// ---------------------------------------------------------------------------
/**
 * Fill one list element with rows.
 *
 * In the order they were traced, a list is the order you happened to work in
 * -- which is no order at all once there are two hundred rows. Sorted by what
 * each row is called, a room number is where you would look for it, and the
 * index stays the real one: only the order they are rendered changes.
 */
// How many rows are worth putting on screen at once. Past this, a list is
// not something you read -- it is something you search -- and building tens of
// thousands of rows costs more than a second and a great deal of memory.
const LIST_LIMIT = 300;

// One collator, reused. String.prototype.localeCompare builds a fresh one on
// every call, which over ten thousand rows is most of the cost of sorting
// them -- half a second of it.
const NAME_ORDER = new Intl.Collator(undefined, {
  numeric: true, sensitivity: "base",
});

function fillList(list, entries, emptyText, opts = {}) {
  if (!list) return;
  const { filter = "", moreEl = null } = opts;

  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? entries.filter(({ i }) => {
      const n = names[i];
      return `${n?.title ?? ""} ${n?.sub ?? ""}`.toLowerCase().includes(needle);
    })
    : entries;

  matching.sort((a, b) => NAME_ORDER.compare(
    String(names[a.i]?.title ?? ""), String(names[b.i]?.title ?? "")));

  if (!matching.length) {
    list.innerHTML = `<li class="tracer-empty">${
      esc(needle ? "Nothing matches that." : emptyText)}</li>`;
    if (moreEl) moreEl.hidden = true;
    return;
  }

  const shown = matching.slice(0, LIST_LIMIT);
  if (moreEl) {
    const hidden = matching.length - shown.length;
    moreEl.hidden = hidden <= 0;
    moreEl.textContent = hidden > 0
      ? `Showing ${shown.length} of ${matching.length} — type above to narrow it down.`
      : "";
  }

  list.innerHTML = shown.map(({ i }) => {
    const { title, sub } = names[i] || { title: "?", sub: "" };
    return `
    <li class="${i === selected ? "is-selected" : ""}">
      <button type="button" class="tracer-room" data-i="${i}">
        <span>${esc(title)}</span>
        <small>${esc(sub)}</small>
      </button>
      <button type="button" class="tracer-del" data-i="${i}" title="Delete ${esc(title)}"
              aria-label="Delete ${esc(title)}">✕</button>
    </li>`;
  }).join("");

  list.querySelectorAll(".tracer-room").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      zoomToItem(i);
      selectItem(i);
    });
  });
  list.querySelectorAll(".tracer-del").forEach((b) => {
    b.addEventListener("click", () => removeItem(Number(b.dataset.i)));
  });
}

function renderRoomList() {
  const shown = rooms.map((r, i) => ({ r, i })).filter(({ r }) => itemInMode(r));

  // Nodes and links are different things, and there are hundreds of each.
  // One list holding both meant scrolling past two hundred links to reach a
  // node, so in network mode they get a list each.
  if (mode === "network") {
    const nodes = shown.filter(({ r }) => r.type === "node");
    const links = shown.filter(({ r }) => r.kind === "path");
    el("netCount").textContent = shown.length;
    el("nodeCount").textContent = nodes.length;
    el("linkCount").textContent = links.length;
    fillList(el("nodeList"), nodes, "No nodes yet.",
      { filter: el("nodeFilter")?.value || "", moreEl: el("nodeMore") });
    fillList(el("linkList"), links, "No links yet.",
      { filter: el("linkFilter")?.value || "", moreEl: el("linkMore") });
    return;
  }

  el("roomCount").textContent = shown.length;
  fillList(el("roomList"), shown, "Nothing traced yet.");
}

const OUTSIDE = "outside";

/** Distance from a point to a traced outline, in plan units (0 if inside). */
function uvDistanceToRoom(uv, room) {
  const [px, py] = uv;
  const ring = room.uv;
  let inside = false;
  let best = Infinity;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
    // distance to this edge
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return inside ? 0 : best;
}

/** Area of a traced outline, in plan units. */
function uvArea(r) {
  const ring = r.uv;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a) / 2;
}

/**
 * The outline a point stands in, or null.
 *
 * Smallest wins, so a point inside a room within a wing belongs to the room.
 * The building outline is ignored -- everything is inside it, so naming
 * anything after it says nothing.
 */
function roomAtUv(uv) {
  if (!uv) return null;   // not on any drawing, so in no traced room
  const holding = rooms
    .filter((o) => o.kind === "polygon" && o.room && o.type !== "building")
    .filter((o) => uvDistanceToRoom(uv, o) === 0)
    .sort((a, b) => uvArea(a) - uvArea(b));
  return holding.length ? holding[0].room : null;
}

/**
 * Give every unnamed node the room it stands in.
 *
 * A node that does not name a space is invisible to the router -- it is just
 * a dot. Which room a node is in is already obvious from where it sits, so
 * reading it off the outlines beats typing it a hundred times. The smallest
 * containing outline wins, so a node inside a room within a wing is named for
 * the room, not the wing; the building outline is ignored entirely because
 * everything is inside it.
 */
function autoNameNodes() {
  let named = 0;
  let already = 0;
  let outside = 0;

  for (const r of rooms) {
    if (r.kind !== "point" || r.type !== "node") continue;
    if (r.room) { already += 1; continue; }
    const found = roomAtUv(itemUv(r));
    if (found) { r.room = found; named += 1; } else { outside += 1; }
  }
  if (named) { redrawRooms(); markDirty(); }
  return { named, already, outside };
}

/**
 * Drop links that cannot mean anything.
 *
 * The same pair joined twice, a node linked to itself, or a link to a node
 * that has since been deleted -- none of these add a way to walk, and they
 * make the network harder to read and to check.
 */
function tidyLinks() {
  const ids = new Set(rooms.filter((r) => r.nid).map((r) => r.nid));
  const seen = new Set();
  let duplicates = 0;
  let selfLinks = 0;
  let dangling = 0;

  forgetNodeIndex();
  rooms = rooms.filter((r) => {
    if (r.kind !== "path") return true;
    const [a, b] = r.nodes || [];
    if (!a || !b) { dangling += 1; return false; }
    if (a === b) { selfLinks += 1; return false; }
    if (!ids.has(a) || !ids.has(b)) { dangling += 1; return false; }
    const key = [a, b].sort().join("|");
    if (seen.has(key)) { duplicates += 1; return false; }
    seen.add(key);
    return true;
  });

  const removed = duplicates + selfLinks + dangling;
  if (removed) { selected = -1; redrawRooms(); markDirty(); }
  return { duplicates, selfLinks, dangling, removed };
}

const outlineLabel = (r) => (r.room ? `${r.room} (${r.type})` : `unnumbered ${r.type}`);

/**
 * Offer the things a marker could join, nearest first.
 *
 * Only outlines with a number can be named in the saved file, since that is
 * what the router looks up -- an unnumbered outline is listed but disabled, so
 * it is obvious why it cannot be picked rather than silently missing.
 */
function connectOptions(uv, selected, includeOutside) {
  const ranked = rooms
    // with no sheet open there is nothing to measure against, so the list is
    // simply unranked rather than absent
    .map((r, i) => ({ r, i, d: uv && r.kind === "polygon" ? uvDistanceToRoom(uv, r) : Infinity }))
    .filter((x) => x.r.kind === "polygon")
    .sort((a, b) => a.d - b.d);

  const opts = ['<option value="">— nothing —</option>'];
  if (includeOutside) {
    opts.push(`<option value="${OUTSIDE}"${selected === OUTSIDE ? " selected" : ""}>Outside the building</option>`);
  }
  for (const { r } of ranked) {
    if (!r.room) {
      opts.push(`<option disabled>${esc(outlineLabel(r))} — needs a number</option>`);
      continue;
    }
    opts.push(`<option value="${esc(r.room)}"${selected === r.room ? " selected" : ""}>${esc(outlineLabel(r))}</option>`);
  }
  return opts.join("");
}

// What a space is called goes in its name -- "Women's Washroom", "AV Room".
// The type is only what the app should DO with it, which is five things:
// send people to it, draw it, or connect floors through it.
const OUTLINE_TYPES = [
  ["building", "Building Outline"], ["room", "Room"], ["hallway", "Hallway"],
  ["stairs", "Stairs"], ["elevator", "Elevator"], ["service", "Service"],
];
const MARKER_TYPES = [
  ["door", "Door"], ["entrance", "Building Entrance"], ["node", "Path Node"],
];

/**
 * Show the fields that mean something for what was actually clicked.
 *
 * One dialog served everything, so placing a walking node asked for a room
 * number, a name like "Lecture theatre", and which two spaces it joined --
 * none of which a node has. Each kind now gets only its own questions.
 */
function configureDialog(item) {
  const t = item.type;
  const isNode = t === "node";
  const isDoor = t === "door";
  const isEntrance = t === "entrance";
  const isMarker = isPointType(t);

  // an outline cannot become a marker, and vice versa -- they are different
  // shapes on the map, so the type list is limited to its own kind
  const types = isMarker ? MARKER_TYPES : OUTLINE_TYPES;
  const sel = el("roomForm").type;
  sel.innerHTML = types
    .map(([v, label]) => `<option value="${v}"${v === t ? " selected" : ""}>${label}</option>`)
    .join("");

  // Only a room offers anything: a hallway, a stairwell and a cupboard have
  // nothing to advertise.
  el("amenityField").hidden = isMarker || t !== "room";

  // a doorway and a walking node are positions, not numbered spaces
  el("roomField").hidden = isDoor || isNode;
  el("roomFieldLabel").textContent = isEntrance ? "Name" : "Room Number";
  el("nameField").hidden = isMarker;

  const saveBtn = el("roomForm").querySelector('button[type="submit"]');
  if (saveBtn) saveBtn.textContent = isMarker ? "Save" : "Save Room";

  el("roomDialogTitle").textContent =
    isNode ? "Path Node"
      : isDoor ? "Doorway"
        : isEntrance ? "Building Entrance"
          : (item.room ? `Room ${item.room}` : "New Room");
}

function fillConnects(item) {
  const block = el("connectsFields");
  const isMarker = isPointType(item.type);
  block.hidden = !isMarker;
  if (!isMarker) return;

  // A node serves one space -- the room you reach from it. A doorway or an
  // entrance sits between two, so it gets both ends.
  const isNode = item.type === "node";
  el("connectALabel").textContent = isNode ? "Serves Room" : "Connects";
  el("connectBField").hidden = isNode;

  // where this marker sits, on the drawing -- null when no sheet is open,
  // in which case nothing can be ranked by distance to it
  const here = itemUv(item);
  const nearest = rooms
    .map((r) => ({ r, d: here && r.kind === "polygon" && r.room ? uvDistanceToRoom(here, r) : Infinity }))
    .sort((a, b) => a.d - b.d)
    .filter((x) => Number.isFinite(x.d))
    .map((x) => x.r.room);

  // a new marker is pre-filled with what it sits between, which is right far
  // more often than not, and can be corrected in the dropdown
  if (isNode) {
    el("connectA").innerHTML = connectOptions(itemUv(item), item.room || "", false);
    return;
  }
  const [a, b] = item.connects || [
    nearest[0] || "",
    item.type === "entrance" ? OUTSIDE : (nearest[1] || ""),
  ];
  el("connectA").innerHTML = connectOptions(itemUv(item), a, item.type === "entrance");
  el("connectB").innerHTML = connectOptions(itemUv(item), b, item.type === "entrance");
}

/** Bring an item into view without changing the zoom more than needed. */
function zoomToItem(i) {
  const r = rooms[i];
  if (!r) return;
  if (r.kind === "path") {
    const a = nodeById(r.nodes[0]);
    if (a) map.easeTo({ center: itemLngLat(a), duration: 400 });
    return;
  }
  const coords = r.kind === "point"
    ? [itemLngLat(r)]
    : r.uv.map((uv) => uvToLngLat(uv));
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  map.easeTo({
    center: [(Math.min(...lngs) + Math.max(...lngs)) / 2,
      (Math.min(...lats) + Math.max(...lats)) / 2],
    duration: 400,
  });
}

/**
 * Remove one item, and anything left dangling by it.
 *
 * Deleting a node has to take its links with it -- a path to a node that is
 * no longer there is not a path, and leaving them would quietly corrupt the
 * network.
 */
function removeItem(i) {
  const r = rooms[i];
  if (!r) return;
  const doomed = new Set([i]);
  if (r.kind === "point" && r.nid) {
    rooms.forEach((other, j) => {
      if (other.kind === "path" && other.nodes.includes(r.nid)) doomed.add(j);
    });
  }
  rooms = rooms.filter((_, j) => !doomed.has(j));
  forgetNodeIndex();
  selected = -1;
  closeDialog();
  redrawRooms();
  markDirty();
  const links = doomed.size - 1;
  if (links > 0) {
    setDrawHint(`Deleted, along with ${links} link${links === 1 ? "" : "s"} that used it.`);
  }
}

function openDialog(i) {
  editingIndex = i;
  const r = rooms[i];
  const form = el("roomForm");
  form.room.value = r.room || "";
  form.type.value = r.type || "room";
  form.name.value = r.name || "";
  form.amenity.value = r.amenity || "";
  configureDialog(r);
  fillConnects(r);
  el("roomDialog").hidden = false;
  if (!el("roomField").hidden) form.room.focus();
  else el("connectA").focus();
}

function closeDialog() {
  el("roomDialog").hidden = true;
  editingIndex = -1;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
function markDirty() {
  dirty = true;
  el("saveState").textContent = "unsaved changes";
}

async function saveFloor() {
  el("saveState").textContent = "saving…";
  try {
    // The network can be worked on with no sheet open -- it spans the campus
    // -- so with no floor there is simply nothing of a floor to write.
    if (!current) {
      const net = await saveNetwork();
      dirty = false;
      el("saveState").textContent =
        `saved ${net.nodes} nodes and ${net.links} links`;
      await rebuildDerived();
      return;
    }
    // Two documents, written separately: this floor's outlines and markers,
    // and the campus network. Writing the network into the sheet is what gave
    // every outdoor node a building and a floor it had nothing to do with.
    const planItems = rooms.filter((r) => !inNetwork(r));

    const data = await fetchJson(
      `/admin/api/floor/${current.building}/${current.floor}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          featureCollection: {
            type: "FeatureCollection",
            features: planItems.map(roomFeature).filter(Boolean),
          },
        }),
      });

    const net = await saveNetwork();

    await savePlacement();
    dirty = false;
    el("saveState").textContent =
      `saved ${data.features} on ${current.building} floor ${current.floor}, `
      + `${net.nodes} nodes and ${net.links} links campus-wide`;

    // Saving writes the files; the app reads a search index and a routing
    // graph built FROM those files. Leaving the rebuild as a separate button
    // meant tracing a node into SW7, saving, and still being told SW7 had no
    // node -- true of the graph, and nothing to do with what you had drawn.
    await rebuildDerived();
    const plan = plans.find((p) => p.stem === current.stem);
    if (plan) plan.traced = true;
    // what was just written is now part of the overview for other floors
    overviewFeatures = overviewFeatures.filter((f) => f.properties.stem !== current.stem)
      .concat(planItems.map(roomFeature).filter(Boolean).map((f) => ({
        ...f, properties: { ...f.properties, stem: current.stem },
      })));
    drawOverview();
  } catch (err) {
    el("saveState").textContent = err.message;
    // A conflict is the one failure with an obvious next move, and the point
    // of refusing the save is wasted if the way forward is not offered.
    if (/changed since you loaded/i.test(err.message)) {
      const state = el("saveState");
      const again = document.createElement("button");
      again.type = "button";
      again.textContent = "Reload";
      again.className = "tracer-danger";
      again.addEventListener("click", () => window.location.reload());
      state.appendChild(document.createTextNode(" "));
      state.appendChild(again);
    }
  }
}

/**
 * How a node or a link is identified, and what its contents amount to.
 *
 * The key has to match the server's idea of the same thing; the signature is
 * only ever compared with itself, so it just has to change whenever anything
 * that gets written changes.
 */
function netKey(feature) {
  const props = feature?.properties || {};
  if (props.type === "node" && props.nid) return `n:${props.nid}`;
  if (props.type === "path" && Array.isArray(props.nodes)) {
    return `p:${[...props.nodes].sort().join("|")}`;
  }
  return null;
}

/** Remember exactly what the server has, so a change can be worked out later. */
function markNetworkSynced(features, version) {
  netVersion = Number.isInteger(version) ? version : null;
  netBaseline = new Map();
  for (const f of features) {
    const key = netKey(f);
    if (key) netBaseline.set(key, JSON.stringify(f));
  }
}

/** What changed since the server and this page last agreed. */
function networkDelta(features) {
  const add = [];
  const update = [];
  const seen = new Set();

  for (const f of features) {
    const key = netKey(f);
    if (!key) continue;
    seen.add(key);
    const was = netBaseline.get(key);
    const now = JSON.stringify(f);
    if (was === undefined) add.push(f);
    else if (was !== now) update.push(f);
  }

  const remove = [];
  for (const key of netBaseline.keys()) {
    if (!seen.has(key)) remove.push(key);
  }
  return { add, update, remove };
}

/** Write the campus network. Returns what the server says it stored. */
async function saveNetwork() {
  if (!networkLoaded) {
    throw new Error(
      "The network did not load, so it will not be saved over. Reload the page."
    );
  }

  const features = rooms.filter(inNetwork).map(roomFeature).filter(Boolean);

  // The whole document, when there is no agreed starting point to describe a
  // change against -- the first save, or after anything went sideways. It
  // always works, whatever size the network has grown to.
  const writeEverything = async () => {
    const result = await fetchJson("/admin/api/network", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        featureCollection: { type: "FeatureCollection", features },
      }),
    });
    markNetworkSynced(features, result.version);
    return result;
  };

  if (netVersion === null) return writeEverything();

  const { add, update, remove } = networkDelta(features);
  if (!add.length && !update.length && !remove.length) {
    return { saved: true, version: netVersion, unchanged: true,
      nodes: features.filter((f) => f.properties.type === "node").length,
      links: features.filter((f) => f.properties.type === "path").length };
  }

  // A change bigger than the thing it changes is not worth describing.
  if (add.length + update.length > features.length * 0.6) return writeEverything();

  let result;
  try {
    result = await fetchJson("/admin/api/network", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion: netVersion, add, update, remove }),
    });
  } catch (err) {
    // Someone else -- another tab, most likely -- saved between this page
    // loading and this save. Refusing is the point: applying "what changed"
    // to something that has moved is how work disappears. Nothing has been
    // written, and the message says what to do.
    if (/changed since you loaded/i.test(err.message)) throw err;
    // anything else, fall back to the way that cannot be out of step
    return writeEverything();
  }

  markNetworkSynced(features, result.version);
  return result;
}

async function savePlacement() {
  if (!current || !placement) return;
  await fetch(`/admin/api/placement/${current.building}/${current.floor}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ placement }),
  }).catch(() => { /* a lost placement costs a re-drag, not the tracing */ });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/**
 * The campus walking network, as working items.
 *
 * Held in world coordinates, so repositioning a floor plan leaves it exactly
 * where it is -- which is the point of keeping it out of the sheets.
 */
async function loadNetwork() {
  let fc;
  try {
    const answer = await fetchJson("/admin/api/network");
    fc = answer.featureCollection;
    networkLoaded = true;
    // what the server has, as the starting point every later save describes
    // its change against
    markNetworkSynced(fc?.features || [], answer.version);
  } catch {
    // Tracing can carry on without it, but saving must not: writing an empty
    // network over a real one is how hours of work disappears.
    networkLoaded = false;
    return [];
  }
  const out = [];
  for (const f of fc?.features || []) {
    const p = f.properties || {};
    if (p.type === "node" && f.geometry?.type === "Point") {
      out.push({
        kind: "point", type: "node", nid: p.nid,
        ll: f.geometry.coordinates,
        room: p.room || null,
        building: p.building || null,
        floor: p.floor || null,
      });
    } else if (p.type === "path" && Array.isArray(p.nodes) && p.nodes.length === 2) {
      out.push({ kind: "path", nodes: p.nodes });
    }
  }
  return out;
}

async function loadPlan(stem) {
  if (dirty && !confirm("This floor has unsaved changes. Leave anyway?")) return;
  current = plans.find((p) => p.stem === stem);
  if (!current) return;

  let data;
  try {
    data = await fetchJson(`/admin/api/floor/${current.building}/${current.floor}`);
  } catch (err) {
    el("planStatus").textContent = err.message;
    return;
  }
  placement = data.placement || null;

  ensureLayers();
  let fitted = false;
  if (!placement) {
    placement = { lng: BCIT.lng, lat: BCIT.lat, widthM: 100, rotation: 0 };
    fitted = await fitToBuilding();
  }

  // Rooms saved by this tool carry their plan-space outline, so they come back
  // attached to the drawing. Anything else -- a floor drawn before this tool
  // existed -- has only world coordinates, so those are read back through the
  // current placement and become editable the same way.
  // The plan and the network are two different documents. The plan is this
  // floor; the network is the whole campus, and the same network is there
  // whichever sheet you open -- so you can trace a path from a door, out
  // across the grass, to the door of the next building.
  const [network] = await Promise.all([loadNetwork(), campus.length ? null : loadCampus()]);

  forgetNodeIndex();
  rooms = (data.featureCollection?.features || [])
    .filter((f) => ["Polygon", "Point"].includes(f.geometry?.type))
    .map((f) => {
      const p = f.properties || {};
      const common = {
        room: p.room || null, type: p.type || "room", name: p.name || undefined,
        amenity: p.amenity || undefined,
        connects: Array.isArray(p.connects) ? p.connects : undefined,
      };
      if (f.geometry.type === "Point") {
        const uv = Array.isArray(p.uv) && p.uv.length === 2 && !Array.isArray(p.uv[0])
          ? p.uv
          : lngLatToUv(f.geometry.coordinates);
        return { kind: "point", uv, nid: p.nid || undefined, ...common };
      }
      const ring = f.geometry.coordinates[0].slice(0, -1);
      return {
        kind: "polygon",
        uv: Array.isArray(p.uv) && p.uv.length === ring.length && Array.isArray(p.uv[0])
          ? p.uv
          : ring.map((c) => lngLatToUv(c)),
        ...common,
      };
    })
    .filter(Boolean)
    .concat(network);

  dirty = false;
  selected = -1;
  el("saveState").textContent = "";
  applyPlacement();
  redrawRooms();

  el("modeSwitch").hidden = false;
  el("saveBlock").hidden = false;
  setMode(mode);   // shows the block for whichever mode is current
  // count the two kinds separately: "147 rooms" was neither true nor useful
  // when 102 of them were walking nodes
  const outlines = rooms.filter((r) => r.kind === "polygon").length;
  const netCount = rooms.filter(inNetwork).length;
  el("planStatus").textContent =
    `${current.building} floor ${current.floor} — ${outlines} outline${outlines === 1 ? "" : "s"}`
    + (netCount ? `, ${netCount} in the walking network` : "");
  drawOverview();

  // Open framed on the drawing, which is where the tracing happens.
  // Positioning is a separate step, taken when you are ready for it.
  setAdjusting(false);
  if (fitted || !rooms.length) zoomToPlan();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// Registered defensively rather than on "load" alone: this module is deferred,
// so if it finishes executing after the map has already loaded, a plain
// map.on("load") handler is attached to an event that has been and gone and the
// floor list never appears.
// The floor list needs nothing from the map, so it is filled in as soon as
// the page is ready. Only the drawing layers wait for the style.
let overviewFeatures = [];

/** Draw every traced floor except the one open for editing. */
function drawOverview() {
  // the overview is fetched independently of the map style, so its layers may
  // not exist yet
  whenStyleReady(ensureLayers);
loadCampus();   // the campus is context for everything, so it loads up front

/**
 * The campus network, ready before any floor is opened.
 *
 * It belongs to no floor, so waiting for one made no sense: the panel said
 * "Network 0" until a sheet was picked, and there was no way to join two
 * buildings without opening one of them first for no reason.
 */
(async () => {
  const net = await loadNetwork();
  if (!net.length || rooms.length) return;   // a floor got there first
  rooms = net;
  forgetNodeIndex();
  el("modeSwitch").hidden = false;
  el("saveBlock").hidden = false;
  setMode(mode);
  redrawRooms();
})();
  const src = map.getSource(OVERVIEW_SRC);
  if (!src) return whenStyleReady(drawOverview);
  const skip = current?.stem;
  const shown = overviewFeatures.filter((f) => f.properties.stem !== skip);

  // A label per sheet, placed in the middle of what has been traced on it.
  const bounds = new Map();
  for (const f of shown) {
    if (f.geometry?.type !== "Polygon") continue;
    const stem = f.properties.stem;
    const b = bounds.get(stem) || { x0: 180, y0: 90, x1: -180, y1: -90 };
    for (const [x, y] of f.geometry.coordinates[0]) {
      b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
    }
    bounds.set(stem, b);
  }
  const labels = [...bounds.entries()].map(([stem, b]) => ({
    type: "Feature",
    properties: {
      stem,
      kind: "sheet-label",
      // "SW3-Floor1" is a file name; "SW3 · Floor 1" is what it is
      label: stem.replace(/-Floor/, " · Floor "),
    },
    geometry: { type: "Point", coordinates: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] },
  }));

  src.setData({ type: "FeatureCollection", features: [...shown, ...labels] });
}

/**
 * Fetch what has already been traced, so the tracer opens showing your work
 * rather than an empty campus. One label per floor, drawn from its largest
 * outline, so the map says which floor you are looking at.
 */
async function loadOverview() {
  const traced = plans.filter((p) => p.traced);
  if (!traced.length) return;
  const results = await Promise.all(traced.map(async (p) => {
    try {
      const data = await fetchJson(`/admin/api/floor/${p.building}/${p.floor}`);
      const feats = (data.featureCollection?.features || []);
      let biggest = -1;
      let labelAt = -1;
      feats.forEach((f, i) => {
        if (f.geometry?.type !== "Polygon") return;
        const ring = f.geometry.coordinates[0];
        const lngs = ring.map((c) => c[0]);
        const lats = ring.map((c) => c[1]);
        const area = (Math.max(...lngs) - Math.min(...lngs))
          * (Math.max(...lats) - Math.min(...lats));
        if (area > biggest) { biggest = area; labelAt = i; }
      });
      return feats.map((f, i) => ({
        ...f,
        properties: { ...f.properties, stem: p.stem, label: i === labelAt },
      }));
    } catch {
      return [];
    }
  }));
  overviewFeatures = results.flat();
  // The style may still be loading when the fetches land, so draw now AND
  // once it is ready -- whichever happens second is the one that sticks.
  drawOverview();
  whenStyleReady(drawOverview);
}

const loadPlanList = async () => {
  let data;
  try {
    data = await fetchJson("/admin/api/plans");
  } catch (err) {
    el("planStatus").textContent = err.message;
    return;
  }
  plans = data.plans || [];

  const picker = el("planPicker");
  picker.innerHTML = '<option value="">Choose a Floor…</option>' +
    plans.map((p) => `<option value="${esc(p.stem)}">${esc(p.building)} — floor ${esc(p.floor)}${p.traced ? " ✓" : ""}</option>`).join("");
  picker.addEventListener("change", () => {
    if (!picker.value) return;
    loadPlan(picker.value).then(rememberSession);
  });

  if (!plans.length) {
    el("planStatus").textContent =
      "No plan images yet. Run: py -3 floorPlans/render_plan_images.py";
    return;
  }

  const done = plans.filter((p) => p.traced).length;
  if (done) {
    el("planStatus").textContent =
      `${done} floor${done === 1 ? "" : "s"} traced — click one on the map, or pick a floor.`;
  }
  loadOverview();

  // Back to whichever floor was open, looking at what was being looked at.
  restoreSession();
};

loadPlanList();

// Input handlers are registered straight away rather than from a "load"
// handler. This module is deferred, so the map may have finished loading
// before it runs, and anything hung off map.on("load") would then be waiting
// on an event that has already been and gone -- which is exactly how clicking
// on the plan silently did nothing.
// ---------------------------------------------------------------------------
// Moving a marker
//
// A node in slightly the wrong place used to mean deleting it and placing
// another -- which threw away its id, and with it every link that named it.
// Dragging keeps the id, so the links follow the node instead of breaking.
// ---------------------------------------------------------------------------
let dragIndex = -1;
let dragMoved = false;

map.on("mousedown", (e) => {
  // not while drawing, and not while the plan itself is being positioned
  if (draft || adjusting) return;
  const i = pointIndexNear(e.lngLat);
  if (i < 0) return;
  dragIndex = i;
  dragMoved = false;
  // the map must not pan out from under the marker being dragged
  map.dragPan.disable();
  map.getCanvas().style.cursor = "grabbing";
  e.preventDefault?.();
});

map.on("mousemove", (e) => {
  if (dragIndex < 0) {
    // only offer the grab cursor when there is something to grab
    if (!draft && !adjusting) {
      const over = pointIndexNear(e.lngLat) >= 0;
      map.getCanvas().style.cursor = over ? "grab" : "";
    }
    return;
  }
  dragMoved = true;
  const item = rooms[dragIndex];
  // a network node lives in the world; a marker lives on the drawing
  if (item.ll) item.ll = [e.lngLat.lng, e.lngLat.lat];
  else item.uv = lngLatToUv([e.lngLat.lng, e.lngLat.lat]);
  // redraw as it moves, so the links to it stretch with it and you can see
  // what the network will look like before letting go
  redrawRooms();
});

map.on("mouseup", () => {
  if (dragIndex < 0) return;
  const moved = dragMoved;
  const r = rooms[dragIndex];
  dragIndex = -1;
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  if (!moved) return;

  // A node that has been moved may now be standing in a different space, and
  // what it serves is what makes it routable, so it is re-read rather than
  // left saying it serves the room it used to be in.
  if (r.type === "node") {
    // and it may now stand in a different building, which is what makes it
    // reachable when someone asks for that building
    r.building = buildingAt(itemLngLat(r));
    const served = roomAtUv(itemUv(r));
    if (served !== r.room) {
      r.room = served;
      setDrawHint(served
        ? `Moved -- this node now serves ${served}.`
        : "Moved -- this node is no longer inside a numbered outline.");
    } else {
      setDrawHint("Moved.");
    }
  } else {
    setDrawHint("Moved.");
  }
  redrawRooms();
  markDirty();
});

map.on("click", onMapClick);
map.on("dblclick", (e) => {
  if (adjusting || !draft) return;
  e.preventDefault?.();
  finishDraft();
});

// Layers do need the style, so they wait for it -- but only through
// whenStyleReady, never map.on("load") directly.
whenStyleReady(ensureLayers);

// How faint the plan should be is a personal preference that does not change
// between floors, so it is remembered rather than reset to a default every
// time a drawing is opened.
const OPACITY_KEY = "wayfindr.tracer.planOpacity";

// ---------------------------------------------------------------------------
// Picking up where you left off
//
// Tracing a campus is not one sitting. Coming back to a blank picker, the
// default view and no idea which floor you were on costs a minute of hunting
// every time, so the floor, the mode and where you were looking are kept.
// Local to this browser, like the transparency setting above: it is how you
// were working, not part of the data.
// ---------------------------------------------------------------------------
const SESSION_KEY = "wayfindr.tracer.session";

function rememberSession() {
  try {
    const c = map.getCenter();
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      stem: current?.stem || null,
      mode,
      lng: Number(c.lng.toFixed(6)),
      lat: Number(c.lat.toFixed(6)),
      zoom: Number(map.getZoom().toFixed(2)),
      bearing: Number(map.getBearing().toFixed(1)),
    }));
  } catch { /* private mode; nothing to remember with */ }
}

function lastSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Panning and zooming happen constantly; writing on every frame would be
// silly, so the view is written once things settle.
let sessionTimer = null;
map.on("moveend", () => {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(rememberSession, 400);
});

/**
 * Reopen the floor that was open last, looking at what was being looked at.
 *
 * The camera is restored after the plan loads, because opening a plan moves
 * the map to it -- which is right the first time and wrong every time after.
 */
async function restoreSession() {
  const saved = lastSession();
  if (!saved) return;

  if (saved.mode === "network" || saved.mode === "plan") setMode(saved.mode);

  if (saved.stem && plans.some((pl) => pl.stem === saved.stem)) {
    el("planPicker").value = saved.stem;
    await loadPlan(saved.stem);
  }

  if (Number.isFinite(saved.lng) && Number.isFinite(saved.lat)) {
    map.jumpTo({
      center: [saved.lng, saved.lat],
      zoom: Number.isFinite(saved.zoom) ? saved.zoom : map.getZoom(),
      bearing: Number.isFinite(saved.bearing) ? saved.bearing : 0,
    });
  }
}

function planOpacity() {
  return Number(el("opacity").value) / 100;
}

function applyOpacity(value) {
  el("opacityOut").textContent = `${Math.round(value * 100)}%`;
  if (map.getLayer("plan-image-layer")) {
    map.setPaintProperty("plan-image-layer", "raster-opacity", planHidden ? 0 : value);
  }
}

el("opacity").addEventListener("input", () => {
  planHidden = false;
  el("togglePlan").textContent = "Hide Plan";
  applyOpacity(planOpacity());
  try { localStorage.setItem(OPACITY_KEY, el("opacity").value); } catch { /* private mode */ }
});

try {
  const saved = localStorage.getItem(OPACITY_KEY);
  if (saved !== null) {
    el("opacity").value = saved;
    el("opacityOut").textContent = `${saved}%`;
  }
} catch { /* private mode; the default stands */ }

// Hiding the plan outright is the quickest way to check a tracing against
// nothing but the map -- and holding H peeks without losing your place.
function setPlanHidden(hidden) {
  planHidden = hidden;
  el("togglePlan").textContent = hidden ? "Show Plan" : "Hide Plan";
  applyOpacity(planOpacity());
}

el("togglePlan").addEventListener("click", () => setPlanHidden(!planHidden));

window.addEventListener("keydown", (e) => {
  if (e.key !== "h" && e.key !== "H") return;
  // e.target is the window when nothing has focus, and the window has no
  // .matches -- reading it blindly threw and killed the shortcut
  const t = e.target;
  if (e.repeat || (t && typeof t.matches === "function"
    && t.matches("input, select, textarea"))) return;
  setPlanHidden(true);
});
window.addEventListener("keyup", (e) => {
  if (e.key === "h" || e.key === "H") setPlanHidden(false);
});

// ---------------------------------------------------------------------------
// Position, scale and rotation as separate controls.
//
// Dragging the corner handle changes size and angle together, which is quick
// but cannot do one without disturbing the other. These do exactly one thing
// each, and show the current value, so a plan can be brought onto the building
// by eye and then trued up by a tenth of a degree.
// ---------------------------------------------------------------------------
function syncAdjustFields() {
  if (!placement) return;
  const w = el("planWidth");
  const r = el("planRotation");
  // don't fight the user mid-type
  if (document.activeElement !== w) w.value = placement.widthM.toFixed(1);
  if (document.activeElement !== r) r.value = normaliseAngle(placement.rotation).toFixed(1);
}

/** Keep the displayed angle in -180..180 so it reads sensibly after many turns. */
function normaliseAngle(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function changePlacement(fn) {
  if (!placement) return;
  fn(placement);
  applyPlacement();
  syncAdjustFields();
  markDirty();
}

const nudgeStep = () => Number(el("nudgeStep").value) || 1;

// north/south move in latitude, east/west in longitude -- both converted from
// metres so a 1 m step is 1 m on the ground wherever the plan happens to be
const moveBy = (dxM, dyM) => changePlacement((p) => {
  p.lng += dxM / mPerDegLng(p.lat);
  p.lat += dyM / mPerDegLat();
});

el("nudgeUp").addEventListener("click", () => moveBy(0, nudgeStep()));
el("nudgeDown").addEventListener("click", () => moveBy(0, -nudgeStep()));
el("nudgeLeft").addEventListener("click", () => moveBy(-nudgeStep(), 0));
el("nudgeRight").addEventListener("click", () => moveBy(nudgeStep(), 0));

const nudgeRotation = (deg) => changePlacement((p) => { p.rotation += deg; });
el("rotLeft").addEventListener("click", () => nudgeRotation(-1));
el("rotRight").addEventListener("click", () => nudgeRotation(1));
el("rotQuarter").addEventListener("click", () => nudgeRotation(90));

// scaling is proportional, so one press changes the plan by the same
// fraction whether it is 20 m or 200 m across
const scaleBy = (factor) => changePlacement((p) => {
  p.widthM = Math.max(1, p.widthM * factor);
});
el("scaleUp").addEventListener("click", () => scaleBy(1.02));
el("scaleDown").addEventListener("click", () => scaleBy(1 / 1.02));

el("planWidth").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v >= 1) changePlacement((p) => { p.widthM = v; });
  else syncAdjustFields();
});

el("planRotation").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) changePlacement((p) => { p.rotation = v; });
  else syncAdjustFields();
});
el("fitBuilding").addEventListener("click", fitToBuilding);
el("zoomPlan").addEventListener("click", zoomToPlan);
el("adjustToggle").addEventListener("click", () => setAdjusting(!adjusting));

const beginDrawing = () => {
  if (adjusting) setAdjusting(false);
  draft = [];
  redrawDraft();
  setDrafting(true);
  const t = activeType();
  setDrawHint(
    t === "node" ? "Click to drop a node. Keep clicking to place more."
      : isLinkType(t) ? "Click one node, then the node to link it to."
        : isPointType(t) ? "Click where the door or entrance is."
          : "Click each corner, then Finish. Double-click also closes it.");
};

el("startDraw").addEventListener("click", beginDrawing);
for (const id of ["nodeFilter", "linkFilter"]) {
  el(id).addEventListener("input", () => renderRoomList());
}

el("doneNetDraw").addEventListener("click", () => {
  cancelDraft();
  setDrawHint(activeType() === "node"
    ? "Done placing. Click Place Nodes to add more."
    : "Done linking. Click Link Nodes to join more.");
});
el("startNetDraw").addEventListener("click", beginDrawing);

el("modePlan").addEventListener("click", () => { setMode("plan"); rememberSession(); });
el("modeNetwork").addEventListener("click", () => { setMode("network"); rememberSession(); });
function networkButtonLabel() {
  const t = activeType();
  if (t === "node") return "Place Nodes";
  if (isLinkType(t)) return "Link Nodes";
  return isPointType(t) ? "Place Marker" : "Draw";
}

el("netType").addEventListener("change", () => {
  el("startNetDraw").textContent = networkButtonLabel();
  if (draft) cancelDraft();
});

el("drawType").addEventListener("change", () => {
  el("startDraw").textContent = networkButtonLabel();
  if (draft) cancelDraft();
});
el("finishDraw").addEventListener("click", finishDraft);
el("cancelDraw").addEventListener("click", cancelDraft);
el("undoPoint").addEventListener("click", () => {
  if (!draft) return;
  draft.pop();
  redrawDraft();
});

function showToolResult(text) {
  const out = el("netToolsResult");
  out.textContent = text;
  out.hidden = false;
}

el("autoName").addEventListener("click", () => {
  // nodes now take a room as they are placed, so this is for the ones that
  // predate that, or that were placed before their room was traced
  const { named, already, outside } = autoNameNodes();
  showToolResult(named
    ? `Named ${named} node${named === 1 ? "" : "s"} from the room each sits in.`
      + (outside ? ` ${outside} sit outside any numbered outline.` : "")
    : already
      ? "Every node already names a room."
      : "No node sits inside a numbered outline — trace the rooms first.");
});

el("tidyLinks").addEventListener("click", () => {
  const { duplicates, selfLinks, dangling, removed } = tidyLinks();
  if (!removed) return showToolResult("No duplicate or broken links to remove.");
  const parts = [];
  if (duplicates) parts.push(`${duplicates} duplicate`);
  if (selfLinks) parts.push(`${selfLinks} joining a node to itself`);
  if (dangling) parts.push(`${dangling} pointing at a missing node`);
  showToolResult(`Removed ${removed} link${removed === 1 ? "" : "s"}: ${parts.join(", ")}.`);
});

el("saveFloor").addEventListener("click", saveFloor);

/** Rebuild the search index and the routing graph from what is on disk. */
async function rebuildDerived() {
  const btn = el("rebuild");
  const state = el("rebuildState");
  btn.disabled = true;
  state.textContent = "rebuilding…";
  try {
    const data = await fetchJson("/admin/api/rebuild", { method: "POST" });
    // "places" rather than "buildings": a car park is somewhere you can be
    // routed to and is counted here, and it is not a building.
    state.textContent = `${data.rooms} rooms searchable, ${data.buildings} `
      + `places routable, ${data.nodes} nodes linked by ${data.links} paths`;
  } catch (err) {
    state.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

el("rebuild").addEventListener("click", async () => {
  if (dirty) return saveFloor();   // which rebuilds anyway
  rebuildDerived();
});

// Capture phase: Mapbox's canvas handles keys of its own and swallows Enter
// before it reaches the window, so the shortcut only works if we look first.
window.addEventListener("keydown", (e) => {
  if (!el("roomDialog").hidden) {
    if (e.key === "Escape") closeDialog();
    return;
  }
  if (!draft) {
    // Arrow keys nudge the selected marker, for the last pixel or two that
    // dragging cannot manage. Shift moves it further.
    const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (NUDGE[e.key] && selected >= 0 && rooms[selected]?.kind === "point") {
      const t = e.target;
      if (t && typeof t.matches === "function" && t.matches("input, select, textarea")) return;
      e.preventDefault();
      const [dx, dy] = NUDGE[e.key];
      const step = e.shiftKey ? 10 : 1;   // pixels on screen, at this zoom
      const item = rooms[selected];
      const p = map.project(itemLngLat(item));
      const moved = map.unproject([p.x + dx * step, p.y + dy * step]);
      if (item.ll) item.ll = [moved.lng, moved.lat];
      else item.uv = lngLatToUv([moved.lng, moved.lat]);
      if (item.type === "node") {
        item.room = roomAtUv(itemUv(item));
        item.building = buildingAt(itemLngLat(item));
      }
      redrawRooms();
      markDirty();
      return;
    }

    // nothing being drawn: Delete removes whatever is selected
    if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) {
      const t = e.target;
      if (t && typeof t.matches === "function" && t.matches("input, select, textarea")) return;
      e.preventDefault();
      removeItem(selected);
    }
    return;
  }
  if (e.key === "Enter") { e.preventDefault(); finishDraft(); }
  else if (e.key === "Backspace") { e.preventDefault(); draft.pop(); redrawDraft(); }
  else if (e.key === "Escape") { e.preventDefault(); cancelDraft(); }
}, true);

el("roomForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (editingIndex < 0) return;
  const form = e.target;
  const r = rooms[editingIndex];
  r.room = form.room.value.trim() || null;
  r.type = form.type.value;
  const name = form.name.value.trim();
  if (name) r.name = name; else delete r.name;
  const amenity = form.amenity.value;
  if (amenity) r.amenity = amenity; else delete r.amenity;

  if (r.type === "node") {
    // what a node serves is stored as its room, which is what the router
    // reads when joining the node to that space
    r.room = form.connectA.value || null;
    delete r.connects;
  } else if (isPointType(r.type)) {
    const pair = [form.connectA.value, form.connectB.value].filter(Boolean);
    if (pair.length) r.connects = pair; else delete r.connects;
  } else {
    delete r.connects;
  }

  closeDialog();
  redrawRooms();
  markDirty();
});

el("deleteRoom").addEventListener("click", () => {
  if (editingIndex >= 0) removeItem(editingIndex);
});

// switching a thing between an outline and a marker changes whether it can
// be joined to anything, so the fields follow
el("roomForm").type.addEventListener("change", (e) => {
  if (editingIndex < 0) return;
  const preview = { ...rooms[editingIndex], type: e.target.value };
  configureDialog(preview);
  fillConnects(preview);
});

el("cancelRoom").addEventListener("click", closeDialog);

window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});
