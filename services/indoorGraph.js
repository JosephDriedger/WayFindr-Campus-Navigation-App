// services/indoorGraph.js
//
// Routing over the campus walking network.
//
// The graph is the network and nothing else: the nodes somebody placed and
// the links they drew between them (public/data/nav-graph.json, built by
// floorPlans/build_nav_graph.py). Rooms are not in it. A room is a label a
// node carries, so "route me to 1750" is "route me to a node that serves
// 1750" -- and where several nodes serve the same room, the one that makes
// the shortest walk wins.
//
// It used to work the other way round: a node was invented at each room's
// centroid, attached to the nearest walkable thing, and the router then had
// to be told not to route THROUGH rooms. That made every room part of the
// graph, sent people through walls to reach rooms nobody had traced, and had
// no way to express anything outside a building.
//
// There is one graph for the whole campus. A link between two buildings, or
// out to a path across the lawn, is an ordinary link -- nothing happens at a
// threshold -- so cross-building routing needs no special case here.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPlace, placeCentre, normalizePlaceName } from "./places.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_GRAPH_PATH = path.join(__dirname, "..", "public", "data", "nav-graph.json");

let cached = null;      // { mtimeMs, graph }

// Walking through somebody's lab to save ten metres is not a route anyone
// would give. Passing through a space that is not circulation therefore costs
// this much on top of the metres -- far more than any detour round the
// building -- so a route only ever enters a room when that room is where you
// are going or where you started. It is a cost rather than a ban: if the only
// way between two halves of a floor really is through a room, a long ugly
// route still beats no route at all.
const ROOM_ENTRY_PENALTY_M = 1000;

// Which spaces count as somewhere you would not walk through uninvited. A
// hallway, a stairwell and a lift are circulation; an untraced space (no
// outline, so no type) is left alone rather than guessed at.
const NOT_THOROUGHFARE = new Set(["room", "service"]);

/**
 * A caller's own words, trimmed to a length worth putting in a sentence.
 *
 * What was asked for is echoed back so the answer says which room could not
 * be found -- but it arrives from a request and can be any length at all, and
 * a five thousand character error message helps nobody.
 */
function quoted(text) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/** Metres between two [lng, lat] points. */
function haversine([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

/**
 * A room reference as (building, room).
 *
 * "SW3-1615" names its own building, "1615" takes the one it was asked for.
 * Carrying the building on the reference is what lets a route end in a
 * different building from the one it started in.
 */
function parseRef(ref, fallbackBuilding) {
  const text = String(ref ?? "").trim();
  const m = /^([A-Za-z]{1,6}\d{0,3})[-\s]+(.+)$/.exec(text);
  if (m && fallbackBuilding && m[1].toUpperCase() === fallbackBuilding.toUpperCase()) {
    return { building: m[1].toUpperCase(), room: m[2].trim() };
  }
  if (m && !/^\d+$/.test(m[1])) {
    return { building: m[1].toUpperCase(), room: m[2].trim() };
  }
  return { building: (fallbackBuilding || "").toUpperCase(), room: text };
}

/** The network, loaded once and reloaded when the file changes underneath. */
function loadGraph() {
  let stat;
  try {
    stat = fs.statSync(NAV_GRAPH_PATH);
  } catch {
    return null;
  }
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.graph;

  let file;
  try {
    file = JSON.parse(fs.readFileSync(NAV_GRAPH_PATH, "utf-8"));
  } catch {
    return null;
  }

  const nodes = (file.nodes || []).map((n, i) => ({
    id: i,
    nid: n.nid,
    building: (n.building || "").toUpperCase(),
    floor: n.floor ?? null,
    room: n.room ? String(n.room) : null,
    name: n.name || null,
    // what kind of space the node stands in, which is how directions can say
    // "take the NW stairs" rather than "follow S180"
    space: n.space || null,
    lng: n.lng,
    lat: n.lat,
  }));

  const adj = nodes.map(() => []);
  for (const [i, j, w] of file.edges || []) {
    if (!nodes[i] || !nodes[j]) continue;
    const weight = Number(w) > 0
      ? Number(w)
      : haversine([nodes[i].lng, nodes[i].lat], [nodes[j].lng, nodes[j].lat]);
    adj[i].push([j, weight]);
    adj[j].push([i, weight]);
  }

  // Which nodes answer to a given room or name, per building. Several nodes
  // may serve one room -- a lecture hall with two doors -- and all of them
  // are candidates.
  const byRoom = new Map();
  const key = (building, label) => `${building}|${String(label).toUpperCase()}`;
  nodes.forEach((n) => {
    for (const label of [n.room, n.name]) {
      if (!label) continue;
      const k = key(n.building, label);
      if (!byRoom.has(k)) byRoom.set(k, []);
      byRoom.get(k).push(n.id);
    }
  });

  // every node of a building, for when the building itself is the destination
  const byBuilding = new Map();
  nodes.forEach((n) => {
    if (!n.building) return;
    if (!byBuilding.has(n.building)) byBuilding.set(n.building, []);
    byBuilding.get(n.building).push(n.id);
  });

  // Which island of the network each node is on, and which island is the
  // network proper. A traced campus picks up strays -- a node dropped and
  // never linked to anything -- and the nearest node to a point is sometimes
  // one of them: Lot A's nearest node was an orphan two hundred metres away
  // with no links at all, so every route from Lot A came back "those two are
  // on parts of the network that are not linked to each other". Snapping a
  // point onto the network has to mean the part you can walk on.
  const component = new Array(nodes.length).fill(-1);
  const sizes = [];
  for (let start = 0; start < nodes.length; start += 1) {
    if (component[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    component[start] = id;
    while (stack.length) {
      const u = stack.pop();
      size += 1;
      for (const [v] of adj[u]) {
        if (component[v] === -1) {
          component[v] = id;
          stack.push(v);
        }
      }
    }
    sizes.push(size);
  }
  const mainComponent = sizes.length
    ? sizes.indexOf(Math.max(...sizes))
    : -1;

  const buildings = new Set(nodes.map((n) => n.building).filter(Boolean));
  const graph = {
    nodes, adj, byRoom, byBuilding, buildings, key, component, mainComponent,
  };
  cached = { mtimeMs: stat.mtimeMs, graph };
  return graph;
}

/** Forget the loaded network, so the next route reads it fresh. */
export function invalidateCache() {
  cached = null;
}

// The spaces that join one floor to another. Not somewhere you are sent, but
// the only way of getting between two floors that is worth drawing.
const VERTICAL_SPACES = new Set(["stairs", "elevator"]);

/**
 * The stairs and lifts each floor of a building can actually get to.
 *
 * A stairwell is one shaft through the whole building, but it is traced on
 * whichever sheet somebody happened to draw it on -- in SW3 that is floor 1
 * and nowhere else. So floor 2 was drawn showing no stairs at all, while the
 * network quietly ran up four of them to reach it: you could be told to take
 * the NW stairs and have nothing on the map to take.
 *
 * The links say which. A node on one floor joined to a node standing in a
 * stairwell on another means that stairwell reaches this floor, and belongs
 * on it. Nothing is inferred from geometry -- a shaft that nobody has linked
 * to this floor does not open onto it, whatever it sits above.
 *
 * Returns { "<floor>": [{ room, name, space, floor }] }, where `floor` is the
 * sheet the outline is traced on, so the caller knows where to find it.
 */
export function verticalSpacesByFloor(building) {
  const code = String(building || "").trim().toUpperCase();
  const graph = code ? loadGraph() : null;
  if (!graph) return {};

  const out = new Map();   // floor -> Map(room -> entry)
  const isVertical = (n) => VERTICAL_SPACES.has(n.space) && n.room;

  const carry = (onto, from) => {
    // The floor a shaft is traced on already draws it.
    if (String(onto.floor) === String(from.floor)) return;
    const floor = String(onto.floor);
    if (!out.has(floor)) out.set(floor, new Map());
    const seen = out.get(floor);
    if (seen.has(from.room)) return;
    seen.set(from.room, {
      room: from.room,
      name: from.name || null,
      space: from.space,
      floor: String(from.floor),
    });
  };

  // Walked through the adjacency, so every link is seen from both ends --
  // which is what is wanted here: either end may be the stairwell.
  graph.nodes.forEach((a, i) => {
    if (a.building !== code || a.floor == null) return;
    for (const [j] of graph.adj[i] || []) {
      const b = graph.nodes[j];
      if (!b || b.building !== code || b.floor == null) continue;
      if (String(a.floor) === String(b.floor)) continue;
      if (isVertical(b)) carry(a, b);
    }
  });

  const result = {};
  for (const [floor, rooms] of out) result[floor] = [...rooms.values()];
  return result;
}

/**
 * The nodes that answer to a destination, or an empty list if none do.
 *
 * A destination is usually a room, but it can be a whole building: "take me
 * to SW3" is a reasonable thing to ask when you do not know or care which
 * room you are heading for. Every node in the building is then a candidate,
 * and since the search runs to whichever is nearest, that lands you at the
 * closest way in rather than at some arbitrary point inside.
 */
function nodesFor(graph, building, room) {
  const wanted = String(room ?? "").trim();
  // no room at all, or the building's own name: the building is the target
  if (!wanted || wanted.toUpperCase() === building) {
    return graph.byBuilding.get(building) || [];
  }
  // "SW3-1615" typed into a box that already knows the building. The name
  // goes into a pattern, and place names are data -- "Drop off/Pick up Only"
  // is a real one -- so it is escaped rather than trusted to contain nothing
  // a regular expression cares about.
  const literal = building.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bare = wanted.replace(new RegExp(`^${literal}[-\\s]*`, "i"), "");
  return graph.byRoom.get(graph.key(building, bare))
    || graph.byRoom.get(graph.key(building, wanted))
    || [];
}

/**
 * The ones you could actually walk to or from.
 *
 * A node is dropped before it is linked, so while a floor is being traced the
 * network is full of loose ones. They are real nodes and they are in the
 * graph; they are just not yet part of anything you can walk.
 */
function onNetwork(graph, ids) {
  if (graph.mainComponent < 0) return ids;
  return ids.filter((id) => graph.component[id] === graph.mainComponent);
}

/**
 * The nearest node a walk from this point could actually join.
 *
 * Only the main body of the network counts. A stray node -- traced and never
 * linked to anything -- is nearer to some points than any real path is, and
 * snapping to one produces a route that cannot reach anywhere.
 */
function nearestNode(graph, lng, lat) {
  let best = null;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    if (graph.mainComponent >= 0 && graph.component[n.id] !== graph.mainComponent) continue;
    const d = haversine([lng, lat], [n.lng, n.lat]);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best === null ? null : { id: best, metres: bestD };
}

// Closer than this to the node it snapped to, a point is that node: drawing a
// two metre stub from a pin to the path it is standing on is noise.
const SNAP_NOISE_M = 5;

/**
 * What one end of a route means, in nodes.
 *
 * Three kinds of thing can be asked for, and they are tried in this order
 * because each is more specific than the next:
 *
 *   a point       {lng, lat} -- where the phone says you are, or where "Start
 *                 Here" was pressed. Snaps to the nearest node.
 *   a place       "LOT Q", "SW3" -- somewhere with an outline on the map. If
 *                 it has nodes they are the answer; if nobody has traced a
 *                 path into it, its middle is a point and snaps like one.
 *   a room        "1750", "SW3-1750" -- the nodes that serve it. A room with
 *                 no node stays an error: falling back to the building would
 *                 quietly take someone to the wrong place, which is worse
 *                 than saying the room is not mapped.
 *
 * Returns { ids, anchor } where anchor is the point the route should be drawn
 * from or to when it is not a node itself, or { ids: [] } when nothing
 * answers to the reference at all.
 */
function resolveEnd(graph, ref, fallbackBuilding) {
  const asPoint = (lng, lat, label) => {
    const near = nearestNode(graph, lng, lat);
    if (!near) return { ids: [] };
    return {
      ids: [near.id],
      anchor: near.metres > SNAP_NOISE_M ? { lng, lat, label: label || null } : null,
    };
  };

  if (ref && typeof ref === "object") {
    const lng = Number(ref.lng);
    const lat = Number(ref.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return { ids: [] };
    return asPoint(lng, lat, ref.label);
  }

  const text = normalizePlaceName(ref);
  if (!text) return { ids: [] };

  // A name is checked whole before it is taken apart. "LOT Q" split on the
  // space is room Q of a building called LOT, which is nothing at all.
  if (graph.buildings.has(text)) {
    // Only nodes you could actually walk to. A node is dropped before it is
    // linked, so the network always has loose ones in it while a floor is
    // being traced -- and one loose node standing in Lot Q was enough to make
    // the whole car park "somewhere with nodes", which sent every route to a
    // dot joined to nothing. A place whose only nodes are off the network has
    // nothing usable, so it falls through to its outline below.
    const ids = onNetwork(graph, graph.byBuilding.get(text) || []);
    if (ids.length) return { ids };
  }
  if (isPlace(text)) {
    const spot = placeCentre(text);
    return spot ? asPoint(spot.lng, spot.lat, spot.name) : { ids: [] };
  }

  const parsed = parseRef(ref, fallbackBuilding);
  return { ids: nodesFor(graph, parsed.building, parsed.room) };
}

/**
 * Shortest walk from any of `starts` to any of `goals`.
 *
 * Multi-source and multi-target because a room is served by however many
 * nodes it has: picking one of them up front would pick the wrong door.
 */
function dijkstra(graph, starts, goals, openRooms = new Set()) {
  const goalSet = new Set(goals);

  /** What it costs to set foot in a node, on top of walking there. */
  const entryCost = (node) => (
    NOT_THOROUGHFARE.has(node.space) && !openRooms.has(node.room)
      ? ROOM_ENTRY_PENALTY_M
      : 0
  );
  const dist = new Map();
  const prev = new Map();
  const seen = new Set();
  // A binary heap is not worth it at this size; the network is hundreds of
  // nodes, not hundreds of thousands.
  const queue = new Set();

  for (const s of starts) {
    dist.set(s, 0);
    queue.add(s);
  }

  while (queue.size) {
    let best = null;
    let bestD = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best === null) break;
    queue.delete(best);
    if (seen.has(best)) continue;
    seen.add(best);

    if (goalSet.has(best)) {
      const route = [best];
      let cur = best;
      while (prev.has(cur)) {
        cur = prev.get(cur);
        route.unshift(cur);
      }
      return route;
    }

    for (const [next, weight] of graph.adj[best] || []) {
      if (seen.has(next)) continue;
      const alt = bestD + weight + entryCost(graph.nodes[next]);
      if (alt < (dist.get(next) ?? Infinity)) {
        dist.set(next, alt);
        prev.set(next, best);
        queue.add(next);
      }
    }
  }
  return null;
}

/** How far it is along a route, in metres. */
function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversine([points[i - 1].lng, points[i - 1].lat], [points[i].lng, points[i].lat]);
  }
  return total;
}

/**
 * Find a walking route between two rooms.
 *
 * `building` is the one the caller is looking at; either room may name its
 * own ("SW3-1615"), which is how a route leaves the building it started in.
 * Returns { success, path: [{building, floor, room, name, space, lng, lat}],
 * distanceM } or { success: false, message }.
 */
export function findIndoorPath(building, startRoom, goalRoom) {
  const code = String(building || "").trim().toUpperCase();
  if (!code) return { success: false, message: "No building given." };

  const graph = loadGraph();
  if (!graph || !graph.nodes.length) {
    return { success: false, message: "No indoor map data has been built yet." };
  }

  // The building being looked at is only ever a fallback for a bare room
  // number now. It used to be checked against the network up front, which
  // refused every route that started somewhere untraced -- a car park with no
  // nodes in it -- before either end had been looked at.
  const fromEnd = resolveEnd(graph, startRoom, code);
  const toEnd = resolveEnd(graph, goalRoom, code);
  const starts = fromEnd.ids;
  const goals = toEnd.ids;

  // What to call each end in an error, which is the caller's own words --
  // a point has none, so it is described rather than quoted.
  const describe = (ref, fallback) => (
    ref && typeof ref === "object" ? "that spot" : quoted(ref || fallback)
  );
  const from = typeof startRoom === "object"
    ? { building: code, room: "" } : parseRef(startRoom, code);
  const to = typeof goalRoom === "object"
    ? { building: code, room: "" } : parseRef(goalRoom, code);

  const missing = [
    !starts.length && describe(startRoom, from.building),
    !goals.length && describe(goalRoom, to.building),
  ].filter(Boolean);
  if (missing.length) {
    // Naming what is missing matters: a room with no node is a room nobody
    // has traced a way into, and that is a fixable gap in the network rather
    // than a mystery.
    return {
      success: false,
      message: `${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} `
        + "no walking node, so there is no way to route to it yet.",
    };
  }

  const toPoint = (n) => ({
    building: n.building,
    floor: n.floor,
    room: n.room,
    name: n.name,
    space: n.space,
    // every point on a route is a network node now, kept so callers that
    // distinguished them do not have to change
    kind: "node",
    type: n.space || "node",
    lng: n.lng,
    lat: n.lat,
  });

  /**
   * The stretch between a point and the node it snapped to, as a route point.
   *
   * Somewhere with no traced path into it -- a car park, a spot on the lawn
   * somebody pressed "Start Here" on -- is not on the network, and pretending
   * the route begins at the nearest node instead would show a line starting a
   * few hundred metres from where the person is standing with no explanation.
   * It is drawn, so the approach is visible and counted, and marked as an
   * anchor so the directions can say it is a walk to the paths rather than
   * along one.
   */
  const toAnchor = (anchor) => ({
    building: null,
    floor: null,
    room: null,
    name: anchor.label || null,
    space: null,
    kind: "anchor",
    type: "anchor",
    lng: anchor.lng,
    lat: anchor.lat,
  });

  // Nothing asked for is not the same as asking for where you already are.
  // A building destination arrives as its own name, so an empty goal really
  // is empty rather than "the building I am in".
  if (goalRoom == null || (typeof goalRoom !== "object" && !String(goalRoom).trim())) {
    return { success: false, message: "No destination given." };
  }

  const withAnchors = (points) => {
    const out = [...points];
    if (fromEnd.anchor) out.unshift(toAnchor(fromEnd.anchor));
    if (toEnd.anchor) out.push(toAnchor(toEnd.anchor));
    return out;
  };

  const shared = starts.filter((s) => goals.includes(s));
  if (shared.length) {
    // Asking for a building you are already standing in is not a route. A
    // 0 m answer is true and useless; saying so and asking for a room is
    // what the person actually needs. Two untraced places that snapped to the
    // same node are a different thing -- the walk between them is real, even
    // though the network has nothing in between -- so this only applies when
    // neither end brought its own point.
    if (!fromEnd.anchor && !toEnd.anchor
      && (!to.room || to.room.toUpperCase() === to.building)) {
      return {
        success: false,
        message: `You are already in ${to.building}. Pick a room to route to.`,
      };
    }
    const points = withAnchors([toPoint(graph.nodes[shared[0]])]);
    return { success: true, path: points, distanceM: Math.round(pathLengthM(points)) };
  }

  // The rooms this route is allowed inside: the one it starts in and the one
  // it ends in. Everything else is somebody else's room.
  const openRooms = new Set(
    [...starts, ...goals].map((id) => graph.nodes[id].room).filter(Boolean)
  );

  const route = dijkstra(graph, starts, goals, openRooms);
  if (!route) {
    return {
      success: false,
      message: "Those two are on parts of the network that are not linked to each other.",
    };
  }

  const points = withAnchors(route.map((id) => toPoint(graph.nodes[id])));
  return {
    success: true,
    path: points,
    // Measured along the line that gets drawn, not taken from the search:
    // a floor change costs more than the metre it covers on the plan.
    distanceM: Math.round(pathLengthM(points)),
  };
}
