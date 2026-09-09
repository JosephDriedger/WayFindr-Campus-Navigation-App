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

import { SPACE_COLOURS, byType } from "./space-colours.js";

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
  let data;
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
/**
 * Has the plan been moved since it was read?
 *
 * Leaving the Move/Rotate handles writes the placement back, and so does
 * switching mode or opening a floor, because both drop out of adjusting. That
 * meant merely LOOKING at a sheet rewrote its placement file -- harmless when
 * the value is the one just read, and not harmless at all when it is not:
 * whatever was in `placement` at that moment got written under whatever
 * `current` said, so one bad moment put one floor's position under another
 * floor's name. Nothing is written now unless something actually moved it.
 */
let placementMoved = false;
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
// Joining two buildings is the same act -- one link between two nodes -- but
// not the same job. The nodes you want are the two either side of the door
// between SW3 and SE12, and they look exactly like the six hundred others, so
// picking them off the map is where it goes wrong. This one names the two
// floors first and takes every other node off the map, so the two left to
// click are the two you meant. See bridgeClick().
const isBridgeType = (t) => t === "bridge";

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

/**
 * A colour per kind of node, by where it stands relative to the open sheet.
 *
 * Amber is the floor you are working on; everything else is somewhere you are
 * linking OUT to, and says which kind of somewhere. Kept in one table so the
 * dots on the map and the key beside them cannot drift apart.
 */
/**
 * How a traced outline is painted while you are drawing it.
 *
 * The same colours the public map uses, because tracing is checking: you are
 * looking at what you drew to see whether it is right, and it is only
 * checkable against the sheet if a room looks like a room rather than like
 * every other outline on the floor. One flat blue for all of them meant a
 * service cupboard, a corridor and a lecture theatre were the same picture,
 * and a stairwell traced as a room looked correct until it reached the map.
 *
 * Selection is the one thing the map has no opinion about, and it has to
 * survive the colours: with forty outlines in six colours, "which of these is
 * the one I am about to delete" is answered by the heavy dark edge, not by a
 * shade of fill.
 */
const isSelected = ["boolean", ["get", "selected"], false];
// A sheet from another building, drawn in full rather than as grey context,
// because it is the other half of the connection being made. See bridgeSheets().
const IS_COMPANION = ["boolean", ["get", "companion"], false];
const PLAN_FILL_OPACITY = ["case", isSelected, 0.85, byType("opacity")];
const PLAN_LINE_COLOUR = ["case", isSelected, "#111827", byType("line")];
// heavier than the map's, because here the line is the thing you are placing
const PLAN_LINE_WIDTH = ["case", isSelected, 4, ["*", 1.6, byType("width")]];

const ZONE_COLOURS = {
  here:    { dot: "#f59e0b", label: "This floor" },
  floor:   { dot: "#10b981", label: "Other floor" },
  other:   { dot: "#ec4899", label: "Other building" },
  outside: { dot: "#64748b", label: "Outdoors" },
};

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
      paint: { "fill-color": byType("fill"), "fill-opacity": PLAN_FILL_OPACITY },
    });
    map.addLayer({
      id: "traced-line", type: "line", source: ROOMS_SRC,
      paint: { "line-color": PLAN_LINE_COLOUR, "line-width": PLAN_LINE_WIDTH },
    });
    map.addLayer({
      id: "traced-label", type: "symbol", source: ROOMS_SRC,
      layout: { "text-field": ["get", "room"], "text-size": 12 },
      paint: {
        "text-color": byType("label"),
        "text-halo-color": "#fff",
        "text-halo-width": 1.5,
      },
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
          ["match", ["get", "type"], "entrance", "#16a34a",
            // A node's colour says where it stands relative to the sheet you
            // have open, so the one you are about to link to is the one you
            // meant. See nodeZone().
            ["match", ["get", "zone"],
              ...Object.entries(ZONE_COLOURS).flatMap(([zone, c]) => [zone, c.dot]),
              ZONE_COLOURS.here.dot]]],
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
    // Beneath the sheet you are tracing, which is what the paragraph above
    // always claimed and what the layer order never did: added last, these
    // drew ON TOP, so every neighbouring floor laid a grey wash over the one
    // being worked on. It matters more now that a companion sheet is drawn in
    // full colour -- on top, it would simply cover the floor you are editing.
    const under = map.getLayer("traced-fill") ? "traced-fill" : undefined;
    map.addLayer({
      id: "overview-fill", type: "fill", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": ["case", IS_COMPANION, byType("fill"), "#64748b"],
        "fill-opacity": ["case", IS_COMPANION, byType("opacity"), 0.18],
      },
    }, under);
    map.addLayer({
      id: "overview-line", type: "line", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-color": ["case", IS_COMPANION, byType("line"), "#475569"],
        "line-width": ["case", IS_COMPANION, ["*", 1.4, byType("width")], 1],
      },
    }, under);
    map.addLayer({
      id: "overview-dot", type: "circle", source: OVERVIEW_SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 3, "circle-color": "#94a3b8" },
    });
    map.addLayer({
      id: "overview-label", type: "symbol", source: OVERVIEW_SRC,
      // a companion sheet is the one you are reading, so its name is legible
      // rather than another piece of faint context
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
        "text-color": ["case", IS_COMPANION, "#0f172a", "#334155"],
        "text-halo-color": "#fff",
        "text-halo-width": 1.5,
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

// ---------------------------------------------------------------------------
// One floor at a time
//
// The walking network is the whole campus and every traced sheet is drawn as
// context, so opening floor 2 of a building laid floor 1 underneath it: its
// outlines, its nodes and its links, sitting exactly on top of the drawing
// being traced and none of them yours to edit. You cannot see what you are
// tracing, and every click risks the wrong floor.
//
// So what belongs to another floor of the building you have open is hidden --
// except the stairs and the lifts. Those are the one thing you need FROM the
// floor below: a stairwell has to land in the same place on every floor, and
// there is nothing else to line it up against.
//
// Another building is not another floor. Its outlines sit beside yours rather
// than over them, and its nodes are what a door links to when a route leaves
// the building, so they stay. So does anything with no floor at all -- the
// paths across the campus belong to no storey.
// ---------------------------------------------------------------------------
const VERTICAL_TYPES = new Set(["stairs", "elevator"]);

/** Off only when someone has asked to see every floor at once. */
let floorFocus = true;

/**
 * The two floors being joined, while the Connect Two Buildings tool is open.
 *
 * `{ from, fromFloor, to, toFloor }`, or null when the tool is shut. It is
 * the answer to "which nodes are even on the map": see onHiddenFloor().
 */
let bridgeEnds = null;

/** How a space is named across the campus: "SW5|2|1840". */
const spaceKey = (building, floor, room) =>
  `${String(building || "").toUpperCase()}|${floor ?? ""}|${String(room || "").toUpperCase()}`;

// What kind of space each traced outline is, on every sheet. A node says
// which room it serves but not what that room IS, and the outline that would
// say so is on a floor that is not open -- which is exactly the case this has
// to answer. Built from the overview, which has already fetched every sheet.
let spaceTypes = new Map();
function indexSpaceTypes(features) {
  const index = new Map();
  for (const f of features) {
    const p = f.properties || {};
    if (!p.room || !p.type) continue;
    index.set(spaceKey(p.building, p.floor, p.room), p.type);
  }
  spaceTypes = index;
}

/** Is this on a floor other than the one open? */
function onOtherFloor(item) {
  if (!current) return false;              // no sheet open: nothing to be off
  const floor = item.floor ?? null;
  if (floor === null || floor === "") return false;   // belongs to no storey
  const building = String(item.building || "").toUpperCase();
  if (building !== String(current.building).toUpperCase()) return false;
  return String(floor) !== String(current.floor);
}

/** Does it connect floors -- a stairwell or a lift? */
function isVerticalSpace(item) {
  // An outline says what it is. A node only says which space it stands in, so
  // what that space is has to be looked up on the sheet it was traced on.
  const type = item.type === "node"
    ? spaceTypes.get(spaceKey(item.building, item.floor, item.room))
    : item.type;
  return VERTICAL_TYPES.has(type);
}

/**
 * Is this item on a floor you do not have open, and therefore out of the way?
 *
 * A link goes when either end does: a line drawn to a node that is not there
 * is a line into empty space, and there is nothing useful to do with it.
 */
function onHiddenFloor(item) {
  if (!item) return false;
  if (item.kind === "path") {
    return (item.nodes || []).some((nid) => {
      const end = nodeById(nid);
      return end ? onHiddenFloor(end) : false;
    });
  }
  // While two floors are being joined, those two floors ARE the network.
  // Six hundred other dots are not context here, they are the hazard: the
  // whole difficulty of joining SW3 to SE12 is that the wrong node looks
  // exactly like the right one. So everything else comes off the map, and
  // what is left to click is only the two floors you named.
  if (bridgeEnds && item.type === "node") return !atBridgeEnd(item);
  if (!floorFocus || !current) return false;
  return onOtherFloor(item) && !isVerticalSpace(item);
}

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
      // Counting is the fallback, for a node placed before it had a building
      // to be named after -- naming happens on save, when the server decides
      // which place a node actually stands in.
      const label = r.name || `Node ${seen.node}`;
      return {
        title: label,
        sub: r.room ? `serves ${r.room}` : (r.building || "outdoors"),
        short: label,
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
 * Where a node stands relative to the sheet that is open, which is what its
 * colour says.
 *
 * Every node on campus is drawn while you work -- that is the point, since a
 * path runs out of one building and into the next -- but they were all the
 * same amber dot. Six hundred identical dots is not a network you can read:
 * linking SW3 to SE12 meant clicking a dot and hoping it was SE12's.
 *
 * A node in this building with no floor of its own -- one standing at its
 * door -- belongs to whichever floor you have open, because that is the floor
 * it opens onto.
 */
function nodeZone(r) {
  if (!current) return "here";        // no sheet open: nothing to be far from
  const building = String(r.building || "").toUpperCase();
  if (!building) return "outside";
  if (building !== String(current.building).toUpperCase()) return "other";
  if (r.floor == null || String(r.floor) === String(current.floor)) return "here";
  return "floor";
}

/** Where a node is, in words: "SE12", "SW3 floor 2 · 2704", "outdoors". */
function whereIs(node) {
  if (!node) return "somewhere";
  const parts = [];
  if (node.building) parts.push(node.building);
  else parts.push("outdoors");
  if (node.floor != null && node.floor !== "") parts.push(`floor ${node.floor}`);
  const where = parts.join(" ");
  return node.room ? `${where} · ${node.room}` : where;
}

/**
 * What a node is called.
 *
 * "Node 7" was a number counted off the list, so it changed whenever anything
 * before it was deleted and meant nothing on the map -- you could not look at
 * a dot and a row and tell they were the same thing. A name says where the
 * node IS: the building it stands in, and then the room it serves, because
 * that is how everybody already refers to a place here -- SW3-1615 is what
 * the search box and the deep links have always used.
 *
 * A node in no room takes its floor and the next free number instead --
 * SW3-2H1, the first unassigned node on floor 2 of SW3 -- so the corridors
 * and the paths outside are still named after somewhere rather than after
 * nothing.
 *
 * The floor is there because it is the first thing you need to know about a
 * corridor node and the only thing its name could not otherwise tell you: a
 * room number carries its own floor here (1602 is floor 1, 2690 is floor 2)
 * and a bare count carries nothing. It also means each floor counts from one,
 * so the numbers stay short and a floor can be renumbered without touching
 * the others.
 *
 * The H keeps the two forms apart. Room numbers are digits, so without it
 * SW3-1 and SW3-1602 are the same shape of name and there is no telling by
 * looking whether a node sits in room 1 or is simply the first unassigned
 * node in SW3. That ambiguity is not only a reading problem: it is what a
 * tool has to answer to know whether a name has gone stale.
 */
const OUTDOOR_PREFIX = "OUT";

// What marks a name as a count rather than a room, inside a building: H,
// for the hallway or corridor such a node almost always stands in.
//
// Only where there are hallways to stand in, and room numbers to be confused
// with. Outdoors has neither -- there is no corridor across the grass, and no
// room number for OUT-5 to be mistaken for -- so out there a count is just a
// count. The same goes for a car park.
const SPARE_MARK = "H";

/** Does this place have floors, and so hallways and room numbers? */
const placeIsMarked = (prefix) => prefix !== OUTDOOR_PREFIX
  && tracedSheets(prefix).length > 0;

// The floor written into a spare name, or nothing for a node that belongs to
// no storey -- one on a path across the campus, or standing at another
// building's door while a different sheet was open.
const floorMark = (r) => (r.floor == null || r.floor === "" ? "" : String(r.floor));

/**
 * Every traced outline, by the floor it is on, as rings in world coordinates.
 *
 * The building's own boundary is left out: everything on the floor is inside
 * it, so it answers "is this node in a space" with yes for the whole site.
 *
 * Built from the overview, which holds every sheet, with the open one taken
 * live from `rooms` instead -- what you have drawn in the last minute counts
 * as traced, and the overview's copy of that sheet is only as new as the last
 * save. Thrown away whenever anything is edited, so it cannot go stale.
 */
let shapeIndex = null;
const forgetShapeIndex = () => { shapeIndex = null; };

function tracedShapes() {
  if (shapeIndex) return shapeIndex;
  const index = new Map();
  const add = (building, floor, ring) => {
    const key = `${String(building || "").toUpperCase()}|${floor ?? ""}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(ring);
  };
  for (const f of overviewFeatures) {
    const props = f.properties || {};
    if (!props.type || props.type === "building") continue;
    if (f.geometry?.type !== "Polygon") continue;
    if (current && props.stem === current.stem) continue;   // the live copy wins
    add(props.building, props.floor, f.geometry.coordinates[0]);
  }
  if (current && placement) {
    for (const r of rooms) {
      if (r.kind !== "polygon" || r.type === "building") continue;
      add(current.building, current.floor, r.uv.map(uvToLngLat));
    }
  }
  shapeIndex = index;
  return index;
}

/**
 * Is this node standing in a room, a corridor, a stairwell -- anything drawn?
 *
 * A node on a floor of its own can only be held by that floor's outlines. One
 * on no floor is answered by any storey of the building, because a node at a
 * door belongs to whichever it opens onto.
 */
function insideTracedShape(r) {
  const floor = floorMark(r);
  // A node on no storey is on nobody's floor plan, so no floor plan holds it.
  // These are the ones placed while another building's sheet was open -- the
  // paths that run across the campus and past the wall -- and clipping the
  // edge of a corridor three floors up by half a metre is not being in that
  // corridor. Open the sheet it really belongs to and Name Nodes will give it
  // that floor, and the room, and a name to match.
  if (!floor) return false;
  const at = itemLngLat(r);
  if (!at) return false;
  const index = tracedShapes();
  const building = String(r.building || "").toUpperCase();
  return (index.get(`${building}|${floor}`) || []).some((ring) => inRing(ring, at));
}

/**
 * The building, car park, or OUT that a node's name is built on.
 *
 * Standing within a building's footprint is not the same as being in the
 * building. A path across the campus runs right past the wall, and part of a
 * traced floor is often nothing but the space between the rooms -- so a node
 * that is inside SW3's outline but inside none of SW3's rooms, corridors or
 * stairwells is not somewhere in SW3. It is outside, and calling it SW3-2H4
 * says it is on floor 2 of a building it has never been in.
 *
 * The test is only asked where it can be answered. A car park has no traced
 * shapes and never will, so a node in one is in the lot it says it is in;
 * and a node that names a room is in that room by saying so.
 */
function namePrefix(r) {
  const place = r.building ? String(r.building) : null;
  if (!place) return OUTDOOR_PREFIX;
  if (r.room) return place;
  if (!tracedSheets(place).length) return place;
  return insideTracedShape(r) ? place : OUTDOOR_PREFIX;
}

/**
 * The names this node could be called, in order of preference.
 *
 * A room with two doors has two nodes in it and they cannot both be
 * SW3-1615, so the second is SW3-1615-2. Told as a sequence rather than a
 * single answer because which one is free depends on the others.
 */
function* nameCandidates(r, prefix = namePrefix(r)) {
  if (r.room) {
    yield `${prefix}-${r.room}`;
    for (let i = 2; i <= 99; i += 1) yield `${prefix}-${r.room}-${i}`;
  }
  if (!placeIsMarked(prefix)) {
    // nothing here to tell a count apart from, so it is told plainly
    for (let i = 1; ; i += 1) yield `${prefix}-${i}`;
  }
  const floor = floorMark(r);
  for (let i = 1; ; i += 1) yield `${prefix}-${floor}${SPARE_MARK}${i}`;
}

/** The first name for this node that nothing else has taken. */
function freeNodeName(r, used, prefix = namePrefix(r)) {
  for (const name of nameCandidates(r, prefix)) {
    if (!used.has(name)) return name;
  }
  return null;   // unreachable: the numbered run has no end
}

// A place, a floor, the mark and a count: "SW3-2H7". Read off the name itself
// rather than checked against what the node is now, so that a node which has
// moved -- out of a building, or onto another floor -- is seen to disagree
// with its own name.
const SPARE_FORM = /^(.*)-([0-9]*)H([0-9]+)$/;
// And the unmarked form, "OUT-7", which is only a count where the place it
// names has no room numbers for it to be confused with.
const PLAIN_FORM = /^(.*)-([0-9]+)$/;

/**
 * Read a spare name back: what it claims about the node, or null if the name
 * is not one of ours.
 *
 * Inside a building the H is what makes this answerable -- see SPARE_MARK.
 * Outside, the place itself answers it: OUT and a car park have no rooms, so
 * a trailing number there can only be a count.
 */
function spareName(r) {
  const name = String(r.name || "");
  const marked = SPARE_FORM.exec(name);
  if (marked) return { prefix: marked[1], floor: marked[2], marked: true };
  const plain = PLAIN_FORM.exec(name);
  if (plain && !placeIsMarked(plain[1])) {
    return { prefix: plain[1], floor: "", marked: false };
  }
  return null;
}

/**
 * Has this node's own name stopped describing it?
 *
 * Only a spare name can: it is a count of where nothing else was known, so it
 * goes wrong the moment something is. A node that has since been matched to a
 * room should be named after the room, and one that has moved to another
 * floor should not still say the floor it left. SW3-1615, and anything
 * somebody typed, mean what they say wherever the node ends up.
 */
function spareNameStale(r) {
  const spare = spareName(r);
  if (!spare) return false;
  if (r.room) return true;
  const prefix = namePrefix(r);
  if (spare.prefix !== prefix) return true;
  const marked = placeIsMarked(prefix);
  // it moved between a place that marks its counts and one that does not
  if (spare.marked !== marked) return true;
  return marked && spare.floor !== floorMark(r);
}

/** Every node name in use, so a new one cannot collide with one. */
const usedNodeNames = () => new Set(
  rooms.filter((r) => r.type === "node" && r.name).map((r) => String(r.name)),
);

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
      // What this node is called: its building and the room it serves, or its
      // building and a number. See nameCandidates().
      name: r.name || null,
    },
    geometry: { type: "Point", coordinates: itemLngLat(r) },
  };
}

/** The map copy of an item, tagged with where it lives in the list. */
function renderFeature(r, i) {
  // Drawn, not deleted: an item on another floor is still part of the network
  // and is still saved. It is only kept off the sheet you are working on.
  if (onHiddenFloor(r)) return null;
  const f = roomFeature(r);
  if (!f) return null;
  // only for hit-testing and labelling on the map; the saved file never sees it
  f.properties = {
    ...f.properties, idx: i, selected: i === selected,
    mapLabel: names[i]?.short || "",
    // Where the node stands relative to the open sheet, which is what its
    // colour says. Added here rather than in nodeFeature() because it is not
    // a fact about the node: it changes when you open a different floor, and
    // when it was part of the saved feature every node on campus counted as
    // changed on every floor change -- so a one-node edit sent the whole
    // network back as a "change".
    ...(r.type === "node" ? { zone: nodeZone(r) } : {}),
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
    renderZoneKey();
    renderTypeKey();
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
  // ...except while two buildings are being joined, when reading both floor
  // plans IS the job. The network drops back to being a wash over a full
  // floor plan in every other network task; here it is the other way round,
  // and a sheet at 7% next to a companion sheet at full strength is not two
  // floors you can compare -- it is one floor and a ghost.
  const readingFloors = net && isBridgeType(activeType());
  const faded = net && !readingFloors;
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

  set("traced-fill", "fill-opacity", faded ? 0.07 : PLAN_FILL_OPACITY);
  set("traced-line", "line-opacity", faded ? 0.35 : 1);
  set("traced-label", "text-opacity", faded ? 0.35 : 1);

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
  syncNetTool();
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
  if (!draft || !draft.length || t === "node" || isLinkType(t) || isBridgeType(t)) {
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
    placementMoved = true;
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
    placementMoved = true;
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
    placementMoved = true;
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
    placementMoved = true;   // a fitted plan has never been written down
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
    if (r.kind !== "point" || !itemInMode(r) || onHiddenFloor(r)) continue;
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
    // Snapping to a node you cannot see is how a link ends up joining the
    // floor below by accident.
    if (onHiddenFloor(r)) continue;
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

  if (isBridgeType(type)) {
    if (!bridgeEnds) {
      setDrawHint("Pick a place and a floor at each end first.");
      return;
    }
    bridgeClick(e.lngLat);
    return;
  }

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
      // Which node you picked, named. Six hundred dots look alike, and a link
      // out of this building is exactly the case where being one dot off
      // matters -- so both ends are said out loud rather than assumed.
      setDrawHint(`From ${whereIs(node)}. Now click the node to link it to.`);
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
    const joined = `${whereIs(nodeById(first))} ↔ ${whereIs(node)}`;
    setDrawHint(existing >= 0
      ? `Unlinked ${joined}. Click the same two again to put it back.`
      : `Linked ${joined}. Click a node to start another link.`);
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
    // and which place it is standing in -- a building, or a car park, which
    // is what makes "take me to Lot L" mean anything. Worked out once: it is
    // asked for three times below and it walks the campus outlines.
    const place = buildingAt(ll);
    const used = usedNodeNames();
    forgetNodeIndex();
    const placed = {
      kind: "point", type: "node", nid: newNodeId(),
      // world coordinates: a node is part of the campus network, not of the
      // drawing that happened to be open when it was placed
      ll,
      room: servedRoom,
      building: place,
      // the floor only means something if this is the building whose floor
      // is open; a node dropped anywhere else is on no particular floor
      floor: current && place === current.building ? current.floor : null,
    };
    // Named from where it landed, now, rather than left as "Node 412" until
    // somebody runs a tool over it.
    placed.name = freeNodeName(placed, used);
    rooms.push(placed);
    redrawRooms();
    markDirty();
    const n = rooms.filter((r) => r.type === "node").length;
    // What it serves and where it stands are two different things, and the
    // second is the one that matters in a car park -- there are no room
    // numbers out there, so "not inside a numbered outline" was the only
    // thing a node in Lot L had ever been told about itself.
    const where = servedRoom
      ? `serves ${servedRoom}${place ? ` in ${place}` : ""}`
      : place ? `is in ${place}`
        : "is outdoors, in no building or lot";
    setDrawHint(`${n} nodes placed — ${placed.name} ${where}.`);
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
  // The bridge tool's own hint sits under its pickers; writing to the general
  // network hint would put the instructions somewhere you are not looking,
  // and leave two hints disagreeing about what to do next.
  const target = mode === "network"
    ? (isBridgeType(activeType()) ? el("bridgeHint") : el("netHint"))
    : el("drawHint");
  if (target) target.textContent = text;
}

function setDrafting(on) {
  // a marker is one click, so it has nothing to finish or undo
  // nodes and links have nothing to "finish" -- each click completes itself
  const t = activeType();
  el("draftControls").hidden = !on || isPointType(t) || isLinkType(t)
    || isBridgeType(t);
  // Its buttons sit under its own pickers, because you choose the two ends
  // before you start clicking and a Start button above them reads backwards.
  el("bridgeStart").disabled = on;
  el("bridgeDone").hidden = !(on && isBridgeType(t));
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

/**
 * The key to the node colours, written from the same table that paints them.
 *
 * Counted, because the useful question is not "what does pink mean" but "how
 * many nodes are there in the next building for me to link to".
 */
/** What the Draw picker calls this kind of outline. */
const outlineTypeLabel = (type) =>
  (OUTLINE_TYPES.find(([value]) => value === type) || [])[1] || type;

/**
 * The key to the outline colours, written from the table that paints them.
 *
 * Six colours are only worth having if you know what they mean, and the one
 * you have to look up is the one you are about to draw wrong.
 */
function renderTypeKey() {
  const key = el("typeKey");
  if (!key) return;
  const counts = {};
  for (const r of rooms) {
    if (r.kind !== "polygon" || onHiddenFloor(r)) continue;
    counts[r.type || "room"] = (counts[r.type || "room"] || 0) + 1;
  }
  key.innerHTML = Object.entries(SPACE_COLOURS)
    // only what is actually on this floor: a key to colours that are not
    // there is a list to read past
    .filter(([type]) => counts[type])
    .map(([type, c]) => `<li><i style="background:${c.fill};border-color:${c.line}"></i>`
      + `${esc(outlineTypeLabel(type))} <b>${counts[type]}</b></li>`)
    .join("");
}

function renderZoneKey() {
  const key = el("zoneKey");
  if (!key) return;
  const counts = {};
  for (const r of rooms) {
    if (r.type !== "node" || onHiddenFloor(r)) continue;
    const zone = nodeZone(r);
    counts[zone] = (counts[zone] || 0) + 1;
  }
  key.innerHTML = Object.entries(ZONE_COLOURS)
    // With no sheet open every node is "here", so the other three would be a
    // row of zeroes explaining a distinction that is not being drawn.
    .filter(([zone]) => counts[zone] || (zone === "here" && current))
    .map(([zone, c]) => `<li><i style="background:${c.dot}"></i>${esc(c.label)}
      <b>${counts[zone] || 0}</b></li>`)
    .join("");
}

function renderRoomList() {
  // The list matches the map. Offering a row for something that is not drawn
  // means selecting it scrolls to a highlight nobody can see.
  const shown = rooms.map((r, i) => ({ r, i }))
    .filter(({ r }) => itemInMode(r) && !onHiddenFloor(r));

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
  let elsewhere = 0;

  for (const r of rooms) {
    if (r.kind !== "point" || r.type !== "node") continue;
    if (r.room) { already += 1; continue; }
    // The outlines being measured against are the open sheet's, so this can
    // only answer for nodes on that floor. Without the check, opening floor 2
    // handed floor-2 room numbers to nodes recorded as being on floor 1 --
    // they sit at the same place on the ground, so every one of them is
    // "inside" a room on the floor above.
    if (onOtherFloor(r)) { elsewhere += 1; continue; }
    const found = roomAtUv(itemUv(r));
    if (!found) { outside += 1; continue; }
    r.room = found;
    // It stands in a room on this sheet, so it is on this floor -- which it
    // may never have been told if it was placed while another was open.
    if (r.floor == null || r.floor === "") r.floor = current?.floor ?? null;
    named += 1;
  }
  if (named) { redrawRooms(); markDirty(); }
  return { named, already, outside, elsewhere };
}

/**
 * Give every unnamed node a name from the convention.
 *
 * It only ever fills in blanks. A name already on a node was either put there
 * by this and is still right, or was typed by somebody -- and there is no way
 * to tell those apart that is worth being wrong about, so neither is
 * overwritten. Renaming one is editing it, which the details dialog does.
 *
 * Room nodes are named first: SW3-1615 has to be free for the node that
 * actually serves 1615, and a numbered node would otherwise have taken it.
 */
function nameNodes() {
  const nodes = rooms.filter((r) => r.type === "node" && r.nid);
  const used = usedNodeNames();
  // Nothing to be called; or called after a number only because it had no
  // room at the time, and now it has one.
  const blank = nodes.filter((r) => !r.name);
  const stale = nodes.filter((r) => r.name && spareNameStale(r));
  const todo = [...blank, ...stale];
  let named = 0;
  let renamed = 0;

  for (const pass of [todo.filter((r) => r.room), todo.filter((r) => !r.room)]) {
    for (const r of pass) {
      // Its own name is not a name it collides with: without this, a node
      // being looked at again is pushed off the name it already holds and
      // onto the next free one.
      if (r.name) used.delete(String(r.name));
      const name = freeNodeName(r, used);
      used.add(name || String(r.name));
      if (!name || name === r.name) continue;
      if (r.name) renamed += 1; else named += 1;
      r.name = name;
    }
  }
  if (named || renamed) { redrawRooms(); markDirty(); }
  return {
    named, renamed, already: nodes.length - todo.length, total: nodes.length,
  };
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

// ---------------------------------------------------------------------------
// Connecting two buildings
//
// The campus network only routes between two buildings if some link actually
// crosses from one to the other, and nothing places that link for you: SW3
// and SE12 share a wall, but until a node on one side is joined to a node on
// the other the router thinks you have to walk round.
//
// Making that link by clicking was the problem: both dots are in view, they
// are metres apart, and they look identical to the six hundred others -- so
// you click, miss, and quietly join the wrong pair.
//
// The answer is not to guess the pair for you. Which two nodes to join is a
// judgement about the building -- which corridor actually runs on into the
// next one, which door is the one people use -- and the nearest two nodes are
// not reliably that. So this tool does the part that was in the way and none
// of the part that was yours: you name the two floors, both floor plans are
// drawn in full, every node that is not on one of them comes off the map, and
// then you click the two you meant. What is left to click is only ever the
// two floors you are joining.
// ---------------------------------------------------------------------------

// Nodes on the paths across campus belong to no building, and joining a
// building to those paths is the same job as joining it to its neighbour --
// so outdoors is offered as a place like any other. A real building can never
// be called this, so it cannot collide with one.
const OUTDOORS_PLACE = "__outdoors__";
const placeLabel = (place) => (place === OUTDOORS_PLACE ? "Outdoors" : place);

/** Metres between two world positions, near enough at campus scale. */
function metresBetween(a, b) {
  const dx = (b[0] - a[0]) * mPerDegLng((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * mPerDegLat();
  return Math.hypot(dx, dy);
}

const nodePlace = (r) => (r.building ? String(r.building) : OUTDOORS_PLACE);

/**
 * Every place that has nodes in it, with how many, ordered for the pickers.
 *
 * Built from the nodes rather than from the campus outlines: a building with
 * nothing traced in it has nothing to link to, and offering it would be
 * offering a connection that cannot be made.
 */
function placesWithNodes() {
  const counts = new Map();
  for (const r of rooms) {
    if (r.type !== "node" || !r.nid) continue;
    const place = nodePlace(r);
    counts.set(place, (counts.get(place) || 0) + 1);
  }
  return [...counts.entries()]
    // outdoors last: it is the odd one out, and it is not what you are
    // usually looking for in this list
    .sort(([a], [b]) => Number(a === OUTDOORS_PLACE) - Number(b === OUTDOORS_PLACE)
      || NAME_ORDER.compare(a, b))
    .map(([place, count]) => ({ place, count }));
}

const samePlace = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

/** The traced sheets of a building, lowest floor first. */
const tracedSheets = (place) => plans
  .filter((pl) => pl.traced && samePlace(pl.building, place))
  .sort((a, b) => Number(a.floor) - Number(b.floor));

/**
 * Is this node on the floor chosen for its end of the link?
 *
 * A blank choice means every floor, and so does a node that is on none. A
 * node standing at SE12's door was placed while SW3 was the open sheet, so it
 * carries no floor of its own -- and it is exactly the node an internal
 * connection wants, so it must not be filtered out by the floor it lacks.
 */
const onChosenFloor = (r, floor) => !floor
  || r.floor == null || r.floor === ""
  || String(r.floor) === String(floor);

const nodesInPlace = (place, floor) => rooms.filter(
  (r) => r.type === "node" && r.nid && nodePlace(r) === place
    && onChosenFloor(r, floor),
);

const metresText = (d) => (d < 10 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`);

function setBridgeHint(text) {
  el("bridgeHint").textContent = text;
}

/**
 * The sheets whose floor plans should be on show, in full, while the tool is
 * open -- one per end, minus whichever is already open for editing.
 *
 * Two buildings that touch are joined INSIDE: a door through a shared wall,
 * a corridor that runs on. Placing that link means reading both floors at
 * once, and the other one was grey context with every one of its storeys
 * drawn on top of each other. So the floor at each end is drawn properly and
 * the rest of those two buildings goes away.
 */
function bridgeSheets() {
  const sheets = new Set();
  if (!bridgeEnds) return sheets;
  for (const [place, floor] of [[bridgeEnds.from, bridgeEnds.fromFloor],
    [bridgeEnds.to, bridgeEnds.toFloor]]) {
    const on = tracedSheets(place);
    // With no floor named there is no one sheet to show: "every floor of
    // SE12 at once" is the picture this is trying to get rid of.
    const sheet = floor ? on.find((pl) => String(pl.floor) === String(floor)) : null;
    if (sheet && sheet.stem !== current?.stem) sheets.add(sheet.stem);
  }
  return sheets;
}

/** Fill one floor picker for the place chosen beside it. */
function fillFloorPicker(selectId, fieldId, place, prefer) {
  const sel = el(selectId);
  const sheets = place ? tracedSheets(place) : [];
  // Nothing traced there -- a car park, or a building nobody has drawn yet.
  // There is no floor to pick, and saying so with an empty picker would be
  // asking a question that has no answers.
  el(fieldId).hidden = sheets.length === 0;
  if (!sheets.length) { sel.innerHTML = ""; return; }
  const keep = sel.value;
  sel.innerHTML = sheets
    .map((pl) => `<option value="${esc(pl.floor)}">Floor ${esc(pl.floor)}</option>`)
    .join("") + '<option value="">Any floor</option>';
  const has = (f) => f !== undefined && f !== null
    && sheets.some((pl) => String(pl.floor) === String(f));
  // Keep what was chosen; otherwise the floor you are on, because two
  // buildings that touch almost always touch on the same storey.
  if (has(keep)) sel.value = keep;
  else if (has(prefer)) sel.value = String(prefer);
  else sel.value = String(sheets[0].floor);
}

/** Both floor pickers, from whichever places are chosen. */
function refreshBridgeFloors() {
  const here = current ? current.floor : null;
  fillFloorPicker("bridgeFromFloor", "bridgeFromFloorField", el("bridgeFrom").value, here);
  fillFloorPicker("bridgeToFloor", "bridgeToFloorField", el("bridgeTo").value, here);
}

/**
 * Fill the two place pickers, keeping whatever was already chosen.
 *
 * Called whenever the tool is opened rather than once at startup, because
 * placing a node in a building that had none makes it a place you can link
 * to, and the list has to say so without a reload.
 */
function refreshBridgePlaces() {
  const places = placesWithNodes();
  for (const id of ["bridgeFrom", "bridgeTo"]) {
    const sel = el(id);
    const keep = sel.value;
    sel.innerHTML = ['<option value="">— pick a place —</option>']
      .concat(places.map(({ place, count }) => `<option value="${esc(place)}">`
        + `${esc(placeLabel(place))} (${count})</option>`))
      .join("");
    // The chosen place survives a refresh; one that has lost all its nodes
    // cannot, and falls back to nothing chosen rather than to the wrong place.
    sel.value = places.some((pl) => pl.place === keep) ? keep : "";
  }
  // The building you have open is almost always one end of the link, so it is
  // filled in -- but only if you have not already said otherwise.
  const here = current && places.find(
    (pl) => samePlace(pl.place, current.building),
  );
  if (here && !el("bridgeFrom").value) el("bridgeFrom").value = here.place;
  refreshBridgeFloors();
  syncBridgeSheets();
}

/**
 * Take up what the pickers now say.
 *
 * Which two floors are being joined decides three things at once -- which
 * floor plans are drawn, which nodes are on the map at all, and what the
 * hint says -- so they are all done from here and nowhere else.
 */
function syncBridgeSheets() {
  setBridgeEnds(readBridgePickers());
  if (draft) cancelDraft();      // the ends moved; a half-made link is stale
  drawOverview();
  redrawRooms();
  describeBridge();
}

/** Which end of the link this node is at, or null if it is at neither. */
function bridgeEndOf(r) {
  if (!bridgeEnds || r.type !== "node" || !r.nid) return null;
  const place = nodePlace(r);
  if (place === bridgeEnds.from && onChosenFloor(r, bridgeEnds.fromFloor)) return "from";
  if (place === bridgeEnds.to && onChosenFloor(r, bridgeEnds.toFloor)) return "to";
  return null;
}

/** Is this node one of the two floors being joined? */
const atBridgeEnd = (r) => bridgeEndOf(r) !== null;

/** What the pickers say, read off the page. */
function readBridgePickers() {
  const from = el("bridgeFrom").value;
  const to = el("bridgeTo").value;
  if (!from || !to || from === to) return null;
  return {
    from,
    to,
    // "" means every floor, which is all a car park or an untraced building
    // can mean
    fromFloor: el("bridgeFromFloor").value,
    toFloor: el("bridgeToFloor").value,
  };
}

/**
 * The two ends currently being worked between, or null when the tool is shut.
 *
 * Cached rather than read from the pickers on demand, because onHiddenFloor()
 * consults it for every node on every redraw -- eight thousand DOM reads a
 * frame is not a thing to do for an answer that only changes when someone
 * touches a picker.
 */
function setBridgeEnds(next) {
  bridgeEnds = next;
}

/** A place and the floor of it being worked with: "SE12 floor 2". */
const endLabel = (place, floor) =>
  `${placeLabel(place)}${floor ? ` floor ${floor}` : ""}`;

const fromLabel = () => endLabel(bridgeEnds.from, bridgeEnds.fromFloor);
const toLabel = () => endLabel(bridgeEnds.to, bridgeEnds.toFloor);

/** How many nodes are left to choose between at each end. */
const endCount = (place, floor) => nodesInPlace(place, floor).length;

/**
 * Which floor plans are actually on the map, said out loud.
 *
 * The floors on show are the whole point of choosing them, so a floor that
 * cannot be shown has to be said rather than left as an empty patch of map
 * where a plan was expected. There are two ways to end up with nothing: the
 * place has never been traced, or "any floor" was chosen -- and "any floor"
 * cannot be drawn, because every storey of a building sits on the same ground
 * and drawing them all is the heap this was built to get rid of.
 */
function showingText() {
  if (!bridgeEnds) return "";
  const sheets = bridgeSheets();
  const untraced = [];
  const unchosen = [];
  for (const [place, floor] of [[bridgeEnds.from, bridgeEnds.fromFloor],
    [bridgeEnds.to, bridgeEnds.toFloor]]) {
    const on = tracedSheets(place);
    if (!on.length) {
      // outdoors is not a building and was never going to have a plan, so
      // saying it has none is noise
      if (place !== OUTDOORS_PLACE) untraced.push(placeLabel(place));
      continue;
    }
    const sheet = on.find((pl) => String(pl.floor) === String(floor));
    if (!sheet) { unchosen.push(placeLabel(place)); continue; }
    if (!sheets.has(sheet.stem) && sheet.stem !== current?.stem) unchosen.push(placeLabel(place));
  }
  const said = [];
  if (untraced.length) {
    said.push(`No floor plan traced for ${untraced.join(" or ")}, so only its nodes are drawn.`);
  }
  if (unchosen.length) {
    said.push(`Pick a floor for ${unchosen.join(" and ")} to see its plan.`);
  }
  return said.length ? ` ${said.join(" ")}` : " Both floor plans are drawn.";
}

/** Say what is on show and what to do with it. */
function describeBridge() {
  if (!el("bridgeFrom").value || !el("bridgeTo").value) {
    setBridgeHint("Pick the two places you want someone to be able to walk between.");
    return;
  }
  if (el("bridgeFrom").value === el("bridgeTo").value) {
    setBridgeHint("Pick two different places — this joins one to another.");
    return;
  }
  if (!bridgeEnds) return;
  const a = endCount(bridgeEnds.from, bridgeEnds.fromFloor);
  const b = endCount(bridgeEnds.to, bridgeEnds.toFloor);
  setBridgeHint(`${fromLabel()} has ${a} node${a === 1 ? "" : "s"}, `
    + `${toLabel()} has ${b}. Everything else is off the map.${showingText()}`
    + " Click Link Nodes, then a node on each side.");
}

/** A box round everything drawn on one sheet, or null if it is empty. */
function sheetBounds(stem) {
  const b = { x0: 180, y0: 90, x1: -180, y1: -90 };
  let any = false;
  const eat = ([x, y]) => {
    any = true;
    b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
    b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
  };
  if (stem && stem === current?.stem) {
    // the open sheet is not in the overview -- it is what you are drawing
    for (const r of rooms) {
      if (r.kind === "polygon") r.uv.map(uvToLngLat).forEach(eat);
    }
  } else {
    for (const f of overviewFeatures) {
      if (f.properties.stem !== stem) continue;
      if (f.geometry?.type === "Polygon") f.geometry.coordinates[0].forEach(eat);
      else if (f.geometry?.type === "Point") eat(f.geometry.coordinates);
    }
  }
  return any ? b : null;
}

/** Fit the map round the given world boxes, ignoring the empty ones. */
function fitBoxes(boxes) {
  const real = boxes.filter(Boolean);
  if (!real.length) return false;
  map.fitBounds([
    [Math.min(...real.map((b) => b.x0)), Math.min(...real.map((b) => b.y0))],
    [Math.max(...real.map((b) => b.x1)), Math.max(...real.map((b) => b.y1))],
  ], { padding: 60, maxZoom: 19.5, duration: 600 });
  return true;
}

/**
 * Both floors on screen at once.
 *
 * The whole of each, not the doorway between them: an internal connection is
 * placed by reading the two plans against each other -- where the corridor on
 * one side lines up with the corridor on the other -- and that is not a
 * question you can answer zoomed in on two dots.
 */
function showBothFloors() {
  if (!bridgeEnds) {
    describeBridge();
    return;
  }
  const stems = [...bridgeSheets()];
  if (current?.stem) stems.push(current.stem);
  if (fitBoxes(stems.map(sheetBounds))) return;
  // Nothing traced at either end, so there is no floor plan to frame. The
  // nodes on show are all there is, and they are still worth looking at.
  const shown = [...nodesInPlace(bridgeEnds.from, bridgeEnds.fromFloor),
    ...nodesInPlace(bridgeEnds.to, bridgeEnds.toFloor)]
    .map(itemLngLat).filter(Boolean);
  if (!shown.length) { describeBridge(); return; }
  fitBoxes([{
    x0: Math.min(...shown.map((c) => c[0])), y0: Math.min(...shown.map((c) => c[1])),
    x1: Math.max(...shown.map((c) => c[0])), y1: Math.max(...shown.map((c) => c[1])),
  }]);
}

/**
 * One click of the two that make a link between the floors.
 *
 * The same two-click act as the ordinary link tool, and it makes the same
 * ordinary link -- two node ids and the fact that they join. What is
 * different is what can be clicked: only the two floors are on the map, so a
 * miss lands on nothing rather than on a node in another building.
 */
function bridgeClick(lngLat) {
  const node = nodeNear(lngLat);
  if (!node) {
    setDrawHint(`Click directly on a node. Only ${fromLabel()} and ${toLabel()} `
      + "are on the map — everything else is hidden while you join these two.");
    return;
  }
  const end = bridgeEndOf(node);
  const first = draft.length ? nodeById(draft[0]) : null;
  if (!first) {
    draft.push(node.nid);
    const other = end === "from" ? toLabel() : fromLabel();
    setDrawHint(`From ${whereIs(node)}. Now click the node in ${other} to join it to.`);
    return;
  }
  if (first.nid === node.nid) {
    setDrawHint("Pick a different node for the other end.");
    return;
  }
  // Both ends in the same place is not the link this tool is for, and it is
  // the mistake the tool exists to catch: it means the wrong dot was hit.
  if (bridgeEndOf(first) === end) {
    setDrawHint(`Both of those are in ${endLabel(nodePlace(node),
      end === "from" ? bridgeEnds.fromFloor : bridgeEnds.toFloor)}. `
      + "The second node has to be on the other side.");
    return;
  }
  // Clicking a pair that is already joined removes the link -- the tool for
  // making links is where you look when you want to unmake one.
  const existing = rooms.findIndex((r) => r.kind === "path"
    && r.nodes.includes(first.nid) && r.nodes.includes(node.nid));
  if (existing >= 0) rooms.splice(existing, 1);
  else rooms.push({ kind: "path", nodes: [first.nid, node.nid] });
  forgetNodeIndex();
  draft = [];
  selected = -1;
  redrawRooms();
  markDirty();
  const apart = metresText(metresBetween(itemLngLat(first), itemLngLat(node)));
  const joined = `${whereIs(first)} ↔ ${whereIs(node)}`;
  setDrawHint(existing >= 0
    ? `Unlinked ${joined}. Click the same two again to put it back.`
    : `Joined ${joined}, ${apart} apart. Click another pair, or Done.`);
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
  // A node's name is its handle -- it is what the list, the map label and the
  // filter box all show -- so it has to be editable. A doorway has no name of
  // its own; it is described by what it joins.
  el("nameField").hidden = isMarker && !isNode;
  if (isNode) {
    el("roomForm").name.placeholder = freeNodeName(item, usedNodeNames()) || "SW3-1615";
  }

  const saveBtn = el("roomForm").querySelector('button[type="submit"]');
  if (saveBtn) saveBtn.textContent = isMarker ? "Save" : "Save Room";

  el("roomDialogTitle").textContent =
    isNode ? (item.name || "Path Node")
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
  // Editing may have drawn, moved or deleted an outline, and where the
  // outlines are is what decides whether a node is inside one.
  forgetShapeIndex();
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
    // A floor with outlines on it is a traced floor, so the picker says so
    // now rather than at the next page load.
    // A floor with outlines on it is a traced floor, and the tick that says
    // so should appear on saving rather than at the next page load. The
    // count is the server's, so the tick and the file cannot disagree.
    const plan = plans.find((p) => p.stem === current.stem);
    if (plan && plan.traced !== (data.features > 0)) {
      plan.traced = data.features > 0;
      renderPlanOptions();
    }
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
/**
 * Take back the places the server worked out.
 *
 * Which building or car park a node stands in is decided again when the file
 * is written, so a node dropped before the campus outlines had loaded still
 * ends up mapped to the lot it is sitting in. That answer has to come back
 * into the working copy: leaving it on the server would mean the page carries
 * on from a picture the file disagrees with, and the next save would send the
 * blank straight back.
 */
function applyPlacements(placed, features) {
  if (!Array.isArray(placed) || !placed.length) return;
  const byNid = new Map(placed.map((p) => [p.nid, p.building]));
  for (const r of rooms) {
    if (r.type === "node" && byNid.has(r.nid)) r.building = byNid.get(r.nid);
  }
  for (const f of features) {
    const nid = f.properties?.nid;
    if (nid && byNid.has(nid)) f.properties.building = byNid.get(nid);
  }
}

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
    applyPlacements(result.placed, features);
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

  applyPlacements(result.placed, features);
  markNetworkSynced(features, result.version);
  return result;
}

async function savePlacement() {
  if (!current || !placement) return;
  // Nothing has moved, so there is nothing to say. Writing anyway is how a
  // placement that was never touched gets a new timestamp -- or, when the
  // page is briefly between two sheets, gets written under the wrong name.
  if (!placementMoved) return;
  placementMoved = false;
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
        name: p.name || undefined,
      });
    } else if (p.type === "path" && Array.isArray(p.nodes) && p.nodes.length === 2) {
      out.push({ kind: "path", nodes: p.nodes });
    }
  }
  return out;
}

// Which attempt to open a floor is the current one. See loadPlan().
let planLoadSeq = 0;

async function loadPlan(stem) {
  if (dirty && !confirm("This floor has unsaved changes. Leave anyway?")) return;
  const sheet = plans.find((p) => p.stem === stem);
  if (!sheet) return;

  // Opening a floor is several awaits long: `current` is set at the top and
  // `rooms` only replaced at the bottom. Two of these running at once -- the
  // remembered floor reopening while you pick another, or a second pick
  // before the first has landed -- interleave, and the tracer ends up saying
  // it has one sheet open while holding another's outlines. That is not just
  // a confusing picture: saving writes `rooms` to `current`, so it would put
  // one floor's rooms into another floor's file. Each attempt takes a ticket
  // and stands down the moment a newer one starts.
  const mine = planLoadSeq + 1;
  planLoadSeq = mine;
  const superseded = () => planLoadSeq !== mine;

  current = sheet;
  let data;
  try {
    data = await fetchJson(`/admin/api/floor/${sheet.building}/${sheet.floor}`);
  } catch (err) {
    if (!superseded()) el("planStatus").textContent = err.message;
    return;
  }
  if (superseded()) return;
  placement = data.placement || null;
  placementMoved = false;   // this is what the file already says

  ensureLayers();
  let fitted = false;
  if (!placement) {
    placement = { lng: BCIT.lng, lat: BCIT.lat, widthM: 100, rotation: 0 };
    fitted = await fitToBuilding();
    if (superseded()) return;
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
  if (superseded()) return;

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
  forgetShapeIndex();   // a different sheet is open, so different outlines apply
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
  updateFloorFocus();

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
  // The sheets being read alongside the one open, because a link is being
  // made between them. Drawn in full; and since a building's storeys sit on
  // top of one another, the rest of THEIR buildings comes off -- otherwise
  // "show me SE12 floor 2" is SE12 floors 2 and 3 in a heap.
  const companions = bridgeSheets();
  const claimed = new Set();
  for (const stem of companions) {
    const sheet = plans.find((pl) => pl.stem === stem);
    if (sheet) claimed.add(String(sheet.building).toUpperCase());
  }
  // Sheets showing only part of themselves, because the floor they are on is
  // not the one open. They get no label: "SW5 · Floor 1" written across two
  // stairwells says a whole floor is drawn there when it is not.
  const partial = new Set();
  const shown = overviewFeatures.filter((f) => {
    if (f.properties.stem === skip) return false;
    if (companions.has(f.properties.stem)) return true;
    // A different floor of a building whose floor is being shown in full:
    // it would sit over the plan that was asked for.
    if (claimed.has(String(f.properties.building || "").toUpperCase())) {
      partial.add(f.properties.stem);
      return false;
    }
    // Another floor of this building is drawn on top of the sheet being
    // traced, which is the whole reason for hiding it; its stairwells stay,
    // because that is what the floor above lines up against.
    if (onHiddenFloor(f.properties)) {
      partial.add(f.properties.stem);
      return false;
    }
    return true;
  });

  // A label per sheet, placed in the middle of what has been traced on it.
  const bounds = new Map();
  for (const f of shown) {
    if (f.geometry?.type !== "Polygon") continue;
    const stem = f.properties.stem;
    if (partial.has(stem) && !companions.has(stem)) continue;
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

  const tagged = companions.size
    ? shown.map((f) => (companions.has(f.properties.stem)
      ? { ...f, properties: { ...f.properties, companion: true } }
      : f))
    : shown;
  const taggedLabels = companions.size
    ? labels.map((f) => (companions.has(f.properties.stem)
      ? { ...f, properties: { ...f.properties, companion: true } }
      : f))
    : labels;
  src.setData({ type: "FeatureCollection", features: [...tagged, ...taggedLabels] });
}

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

/**
 * The floor picker, with a tick beside every sheet that has something on it.
 *
 * Redrawn rather than written once, because what is ticked changes: tracing a
 * floor and saving it makes it a traced floor. The list was built at page
 * load and never again, so the floor you had just finished stayed unticked
 * until you reloaded -- which reads as "that did not save".
 *
 * The selection is put back afterwards: replacing the options clears it, and
 * the picker is how you know which floor you are on.
 */
function renderPlanOptions() {
  const picker = el("planPicker");
  if (!picker) return;
  const chosen = picker.value;
  picker.innerHTML = '<option value="">Choose a Floor…</option>' +
    plans.map((p) => `<option value="${esc(p.stem)}">${esc(p.building)} — floor ${esc(p.floor)}${p.traced ? " ✓" : ""}</option>`).join("");
  if (chosen) picker.value = chosen;
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
  forgetShapeIndex();
  // Every sheet has now been read, which is the only place the type of a
  // space on a floor that is not open can be found -- so a node standing in
  // the stairwell of the floor below can be recognised as one.
  indexSpaceTypes(overviewFeatures);
  // The style may still be loading when the fetches land, so draw now AND
  // once it is ready -- whichever happens second is the one that sticks.
  drawOverview();
  redrawRooms();   // nodes can only be placed by floor once the types are known
  updateFloorFocus();
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
  renderPlanOptions();
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

/**
 * Say how much of the campus the open floor is hiding.
 *
 * Something disappearing with no explanation is worse than the clutter it
 * was hiding: without this, opening floor 2 silently loses a hundred nodes
 * and the only clue is a count in the status line that no longer matches.
 */
function updateFloorFocus() {
  const field = el("floorFocusField");
  if (!field) return;
  field.hidden = !current;
  const label = el("floorFocusCount");
  if (!label || !current) return;
  if (!floorFocus) {
    label.textContent = "every floor is showing";
    return;
  }
  let hidden = 0;
  let kept = 0;
  // Counted through the same test that does the hiding, so the number cannot
  // drift from what is actually on the map. A link is not on any floor itself
  // -- it is hidden because a node it joins is -- which is why counting only
  // the things that carry a floor said 130 when 217 had gone.
  const tally = (item) => {
    if (onHiddenFloor(item)) hidden += 1;
    else if (onOtherFloor(item) && isVerticalSpace(item)) kept += 1;
  };
  rooms.forEach(tally);
  for (const f of overviewFeatures) {
    if (f.properties.stem !== current.stem) tally(f.properties);
  }
  label.textContent = hidden
    ? `${hidden} hidden on other floors${kept ? `, ${kept} stairs and lifts kept` : ""}`
    : "stairs and lifts still show";
}

el("floorFocus")?.addEventListener("change", (e) => {
  floorFocus = e.target.checked;
  redrawRooms();
  drawOverview();
  updateFloorFocus();
});

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
  placementMoved = true;
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
      : isBridgeType(t) ? (bridgeEnds
        ? `Click a node in ${fromLabel()}, then the node in ${toLabel()} to join them.`
        : "Pick a place and a floor at each end first.")
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
  if (isBridgeType(t)) return "Connect Buildings";
  return isPointType(t) ? "Place Marker" : "Draw";
}

/**
 * Show the controls belonging to the network tool that is chosen.
 *
 * The two clicking tools want a Draw button and a hint about where to click;
 * connecting two buildings wants neither, because it is answered by naming
 * places. Both on screen at once is two sets of instructions for one task.
 */
function syncNetTool() {
  const bridge = mode === "network" && isBridgeType(activeType());
  el("bridgeFields").hidden = !bridge;
  el("netDrawRow").hidden = bridge;
  el("netHint").hidden = bridge;
  el("startNetDraw").textContent = networkButtonLabel();
  // Rebuilt on opening rather than kept up to date: a place becomes linkable
  // the moment it has a node, and this is the only moment that matters.
  if (bridge) { refreshBridgePlaces(); return; }
  // Leaving the tool puts the campus back: every node returns to the map and
  // the two full-colour sheets come off. They are there to make a link, not
  // to become the way the map looks.
  setBridgeEnds(null);
  drawOverview();
  redrawRooms();
  // and the floor plan goes back to being context for the network
  applyModeStyling();
}

el("netType").addEventListener("change", () => {
  syncNetTool();
  if (draft) cancelDraft();
});

// Changing a place changes which floors it has; changing either changes
// which two floor plans should be on the map.
for (const id of ["bridgeFrom", "bridgeTo"]) {
  el(id).addEventListener("change", () => {
    refreshBridgeFloors();
    syncBridgeSheets();
  });
}
for (const id of ["bridgeFromFloor", "bridgeToFloor"]) {
  el(id).addEventListener("change", syncBridgeSheets);
}
el("bridgeStart").addEventListener("click", beginDrawing);
el("bridgeDone").addEventListener("click", () => {
  cancelDraft();
  setDrawHint("Done linking. Click Link Nodes to join another pair.");
});
el("bridgeShow").addEventListener("click", showBothFloors);

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
  // Which room a node serves first, then what it is called -- the name is
  // built out of the room, so doing it the other way round would name a node
  // after a room it had not been given yet.
  const rooms_ = autoNameNodes();
  const names_ = nameNodes();
  const said = [];
  if (rooms_.named) {
    said.push(`Matched ${rooms_.named} node${rooms_.named === 1 ? "" : "s"} `
      + "to the room each sits in.");
  }
  if (names_.named) {
    said.push(`Named ${names_.named} node${names_.named === 1 ? "" : "s"} — `
      + "building and room, building floor and an H number, or a count outside.");
  }
  if (names_.renamed) {
    said.push(`Renamed ${names_.renamed} whose H number no longer said `
      + "where they are.");
  }
  // Said out loud, because it is why fewer were matched than you might have
  // counted on the map: they belong to a floor that is not open, and only
  // that sheet's outlines can say which room they are in.
  if (rooms_.elsewhere) {
    said.push(`${rooms_.elsewhere} sit on other floors — open those sheets `
      + "to match them.");
  }
  if (!said.length) {
    said.push(names_.total
      ? `All ${names_.total} nodes are already named.`
      : "There are no nodes yet.");
  } else if (names_.already && (names_.named || names_.renamed)) {
    said.push(`${names_.already} already had a name and were left alone.`);
  }
  showToolResult(said.join(" "));
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
