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

  const buildings = new Set(nodes.map((n) => n.building).filter(Boolean));
  const graph = { nodes, adj, byRoom, byBuilding, buildings, key };
  cached = { mtimeMs: stat.mtimeMs, graph };
  return graph;
}

/** Forget the loaded network, so the next route reads it fresh. */
export function invalidateCache() {
  cached = null;
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
  // "SW3-1615" typed into a box that already knows the building
  const bare = wanted.replace(new RegExp(`^${building}[-\\s]*`, "i"), "");
  return graph.byRoom.get(graph.key(building, bare))
    || graph.byRoom.get(graph.key(building, wanted))
    || [];
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
  if (!graph.buildings.has(code)) {
    return {
      success: false,
      message: `There is no indoor map data for ${code} yet.`,
    };
  }

  // A bare code that names a building is that building, not a room inside the
  // one being looked at: "SW3-1990 to SW7" crosses the campus, it does not
  // look for a room called SW7 in SW3.
  const asBuilding = (ref) => {
    const text = String(ref ?? "").trim().toUpperCase();
    return graph.buildings.has(text) ? { building: text, room: "" } : null;
  };
  const from = asBuilding(startRoom) || parseRef(startRoom, code);
  const to = asBuilding(goalRoom) || parseRef(goalRoom, code);
  const starts = nodesFor(graph, from.building, from.room);
  const goals = nodesFor(graph, to.building, to.room);

  const missing = [
    !starts.length && (startRoom || from.building),
    !goals.length && (goalRoom || to.building),
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

  const shared = starts.filter((s) => goals.includes(s));
  if (shared.length) {
    // Asking for a building you are already standing in is not a route. A
    // 0 m answer is true and useless; saying so and asking for a room is
    // what the person actually needs.
    if (!to.room || to.room.toUpperCase() === to.building) {
      return {
        success: false,
        message: `You are already in ${to.building}. Pick a room to route to.`,
      };
    }
    return { success: true, path: [toPoint(graph.nodes[shared[0]])], distanceM: 0 };
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

  const points = route.map((id) => toPoint(graph.nodes[id]));
  return {
    success: true,
    path: points,
    // Measured along the line that gets drawn, not taken from the search:
    // a floor change costs more than the metre it covers on the plan.
    distanceM: Math.round(pathLengthM(points)),
  };
}
