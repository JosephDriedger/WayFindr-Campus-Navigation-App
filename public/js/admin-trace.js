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
  if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);
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
  if (map.isStyleLoaded()) return fn();
  const timer = setInterval(() => {
    if (!map.isStyleLoaded()) return;
    clearInterval(timer);
    fn();
  }, 60);
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
      filter: ["==", ["geometry-type"], "Polygon"],
      layout: { "text-field": ["get", "stem"], "text-size": 11 },
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

const nodeById = (nid) => rooms.find((r) => r.nid === nid);

function pathFeature(r) {
  const a = nodeById(r.nodes[0]);
  const b = nodeById(r.nodes[1]);
  if (!a || !b) return null; // an endpoint was deleted
  return {
    type: "Feature",
    properties: {
      room: null, building: current.building, floor: current.floor,
      type: "path", source: "traced", nodes: [...r.nodes],
    },
    geometry: { type: "LineString", coordinates: [uvToLngLat(a.uv), uvToLngLat(b.uv)] },
  };
}

function roomFeature(r) {
  if (r.kind === "path") return pathFeature(r);
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

function redrawRooms() {
  names = displayNames();
  const built = rooms.map(renderFeature).filter(Boolean);
  map.getSource(PATHS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "LineString"),
  });
  applyModeStyling();
  map.getSource(ROOMS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "Polygon"),
  });
  map.getSource(MARKS_SRC)?.setData({
    type: "FeatureCollection",
    features: built.filter((f) => f.geometry.type === "Point"),
  });
  renderRoomList();
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
  set("traced-fill", "fill-opacity", net ? 0.07 : 0.22);
  set("traced-line", "line-opacity", net ? 0.35 : 1);
  set("traced-label", "text-opacity", net ? 0.35 : 1);
  set("marks-dot", "circle-opacity", net ? 0.3 : 1);
  set("paths-line", "line-opacity", net ? 0.95 : 0.3);
}

function setMode(next) {
  mode = next;
  selected = -1;
  cancelDraft();
  el("modePlan").classList.toggle("is-active", next === "plan");
  el("modeNetwork").classList.toggle("is-active", next === "network");
  el("planTypeField").hidden = next !== "plan";
  el("netTypeField").hidden = next !== "network";
  el("netTools").hidden = next !== "network";
  el("netToolsResult").hidden = true;
  el("tracedHeading").firstChild.textContent =
    next === "network" ? "Network " : "Traced ";
  el("startDraw").textContent = networkButtonLabel();
  setDrawHint(next === "network"
    ? "Place nodes where people walk, then link them."
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

/** The walking node under the pointer, if there is one. */
function nodeNear(lngLat) {
  const here = map.project(lngLat);
  let best = null, bestD = SNAP_PX;
  for (const r of rooms) {
    if (r.kind !== "point" || r.type !== "node") continue;
    const p = map.project(uvToLngLat(r.uv));
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
    const uv = lngLatToUv([e.lngLat.lng, e.lngLat.lat]);
    const servedRoom = roomAtUv(uv);
    rooms.push({ kind: "point", type: "node", nid: newNodeId(), uv, room: servedRoom });
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

function setDrawHint(text) { el("drawHint").textContent = text; }

function setDrafting(on) {
  // a marker is one click, so it has nothing to finish or undo
  // nodes and links have nothing to "finish" -- each click completes itself
  const t = activeType();
  el("draftControls").hidden = !on || isPointType(t) || isLinkType(t);
  el("startDraw").disabled = on;
  // double-click finishes a room, so it must not also zoom the map
  if (on) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = on ? "crosshair" : "";
}

function finishDraft() {
  if (!draft || draft.length < 3) return;
  rooms.push({ kind: "polygon", uv: draft, room: null, type: activeType() });
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
function renderRoomList() {
  const list = el("roomList");
  const shown = rooms.map((r, i) => ({ r, i })).filter(({ r }) => itemInMode(r));
  el("roomCount").textContent = shown.length;

  // In the order they were traced, the list is the order you happened to work
  // in -- which is no order at all once there are two hundred rows. Sorted by
  // what each row is called, a room number is where you would look for it.
  // Numeric-aware, so 1985 comes after 1750 rather than between 1 and 2, and
  // the index stays the real one: only the order they are rendered changes.
  shown.sort((a, b) => String(names[a.i]?.title ?? "")
    .localeCompare(String(names[b.i]?.title ?? ""), undefined,
      { numeric: true, sensitivity: "base" }));
  if (!shown.length) {
    list.innerHTML = `<li class="tracer-empty">${
      mode === "network" ? "No walking network yet." : "Nothing traced yet."}</li>`;
    return;
  }
  // Sixty identical "node" rows tell you nothing, so each is numbered within
  // its own kind and says what it serves.
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
    const found = roomAtUv(r.uv);
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
    .map((r, i) => ({ r, i, d: r.kind === "polygon" ? uvDistanceToRoom(uv, r) : Infinity }))
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

  const nearest = rooms
    .map((r) => ({ r, d: r.kind === "polygon" && r.room ? uvDistanceToRoom(item.uv, r) : Infinity }))
    .sort((a, b) => a.d - b.d)
    .filter((x) => Number.isFinite(x.d))
    .map((x) => x.r.room);

  // a new marker is pre-filled with what it sits between, which is right far
  // more often than not, and can be corrected in the dropdown
  if (isNode) {
    el("connectA").innerHTML = connectOptions(item.uv, item.room || "", false);
    return;
  }
  const [a, b] = item.connects || [
    nearest[0] || "",
    item.type === "entrance" ? OUTSIDE : (nearest[1] || ""),
  ];
  el("connectA").innerHTML = connectOptions(item.uv, a, item.type === "entrance");
  el("connectB").innerHTML = connectOptions(item.uv, b, item.type === "entrance");
}

/** Bring an item into view without changing the zoom more than needed. */
function zoomToItem(i) {
  const r = rooms[i];
  if (!r) return;
  if (r.kind === "path") {
    const a = nodeById(r.nodes[0]);
    if (a) map.easeTo({ center: uvToLngLat(a.uv), duration: 400 });
    return;
  }
  const pts = r.kind === "point" ? [r.uv] : r.uv;
  const lngs = pts.map((uv) => uvToLngLat(uv)[0]);
  const lats = pts.map((uv) => uvToLngLat(uv)[1]);
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
  if (!current) return;
  el("saveState").textContent = "saving…";
  try {
    const data = await fetchJson(
      `/admin/api/floor/${current.building}/${current.floor}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          featureCollection: { type: "FeatureCollection", features: rooms.map(roomFeature) },
        }),
      });
    await savePlacement();
    dirty = false;
    el("saveState").textContent = `saved ${data.features} rooms`;
    const plan = plans.find((p) => p.stem === current.stem);
    if (plan) plan.traced = true;
    // what was just written is now part of the overview for other floors
    overviewFeatures = overviewFeatures.filter((f) => f.properties.stem !== current.stem)
      .concat(rooms.map(roomFeature).filter(Boolean).map((f) => ({
        ...f, properties: { ...f.properties, stem: current.stem },
      })));
    drawOverview();
  } catch (err) {
    el("saveState").textContent = err.message;
  }
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
  rooms = (data.featureCollection?.features || [])
    .filter((f) => ["Polygon", "Point", "LineString"].includes(f.geometry?.type))
    .map((f) => {
      if (f.geometry.type === "LineString") {
        const nodes = f.properties?.nodes;
        return Array.isArray(nodes) && nodes.length === 2
          ? { kind: "path", nodes }
          : null;
      }
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
    .filter(Boolean);

  dirty = false;
  selected = -1;
  el("saveState").textContent = "";
  applyPlacement();
  redrawRooms();

  el("placeBlock").hidden = false;
  el("drawBlock").hidden = false;
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
  const src = map.getSource(OVERVIEW_SRC);
  if (!src) return whenStyleReady(drawOverview);
  const skip = current?.stem;
  src.setData({
    type: "FeatureCollection",
    features: overviewFeatures.filter((f) => f.properties.stem !== skip),
  });
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
  picker.addEventListener("change", () => picker.value && loadPlan(picker.value));

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

};

loadPlanList();

// Input handlers are registered straight away rather than from a "load"
// handler. This module is deferred, so the map may have finished loading
// before it runs, and anything hung off map.on("load") would then be waiting
// on an event that has already been and gone -- which is exactly how clicking
// on the plan silently did nothing.
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

el("startDraw").addEventListener("click", () => {
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
});

el("modePlan").addEventListener("click", () => setMode("plan"));
el("modeNetwork").addEventListener("click", () => setMode("network"));
function networkButtonLabel() {
  const t = activeType();
  if (t === "node") return "Place Nodes";
  if (isLinkType(t)) return "Link Nodes";
  return isPointType(t) ? "Place Marker" : "Draw";
}

el("netType").addEventListener("change", () => {
  el("startDraw").textContent = networkButtonLabel();
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

el("rebuild").addEventListener("click", async () => {
  const btn = el("rebuild");
  const state = el("rebuildState");
  if (dirty) await saveFloor();
  btn.disabled = true;
  state.textContent = "rebuilding…";
  try {
    const data = await fetchJson("/admin/api/rebuild", { method: "POST" });
    state.textContent = `${data.rooms} rooms searchable, ${data.buildings} buildings routable`;
  } catch (err) {
    state.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Capture phase: Mapbox's canvas handles keys of its own and swallows Enter
// before it reaches the window, so the shortcut only works if we look first.
window.addEventListener("keydown", (e) => {
  if (!el("roomDialog").hidden) {
    if (e.key === "Escape") closeDialog();
    return;
  }
  if (!draft) {
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
