import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_GRAPH = path.join(__dirname, "..", "public", "data", "nav-graph.json");

const { findIndoorPath } = await import("../services/indoorGraph.js");

// The network is a generated artefact, so a checkout without it should skip
// rather than fail -- but when it IS there these are the guard on routing
// actually working end to end.
const graph = fs.existsSync(NAV_GRAPH)
  ? JSON.parse(fs.readFileSync(NAV_GRAPH, "utf-8"))
  : null;
const hasNetwork = Boolean(graph?.nodes?.length && graph?.edges?.length);
const withNetwork = hasNetwork ? it : it.skip;

/** A building that has a traced network, and the rooms its nodes serve. */
const pickBuilding = () => {
  const byBuilding = new Map();
  for (const n of graph.nodes) {
    if (!n.building || !n.room) continue;
    if (!byBuilding.has(n.building)) byBuilding.set(n.building, new Set());
    byBuilding.get(n.building).add(String(n.room));
  }
  for (const [building, rooms] of byBuilding) {
    if (rooms.size >= 2) return { building, rooms: [...rooms] };
  }
  return null;
};

describe("indoorGraph.findIndoorPath", () => {
  it("rejects a missing building", () => {
    expect(findIndoorPath(undefined, "1", "2").success).toBe(false);
  });

  it("says which ends are not on the network, rather than which building", () => {
    // The building being looked at is only a fallback for a bare room number
    // now -- refusing on it up front turned away every route that started
    // somewhere untraced, a car park included.
    const res = findIndoorPath("NOT_A_BUILDING", "1", "2");
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no walking node/i);
    expect(res.message).toContain("1");
    expect(res.message).toContain("2");
  });

  withNetwork("routes from a car park nobody has traced a path into", () => {
    // LOT Q has an outline on the map and no nodes in it. The middle of the
    // outline snaps to the nearest node, and the walk in from there is drawn
    // rather than pretended away.
    const pick = pickBuilding();
    const res = findIndoorPath(pick.building, "LOT Q", pick.rooms[0]);
    expect(res.success).toBe(true);
    expect(res.distanceM).toBeGreaterThan(0);
    // the route begins at the lot itself, not at whatever node it snapped to
    expect(res.path[0].kind).toBe("anchor");
    expect(res.path[0].name).toBe("LOT Q");
  });

  withNetwork("takes a { lng, lat } as an end of a route", () => {
    const pick = pickBuilding();
    const somewhere = { lng: -123.009, lat: 49.253, label: "Your Location" };
    const res = findIndoorPath(pick.building, somewhere, pick.rooms[0]);
    expect(res.success).toBe(true);
    expect(res.path[0].kind).toBe("anchor");
    expect(res.path[0].name).toBe("Your Location");
    expect(res.path[res.path.length - 1].kind).not.toBe("anchor");
  });

  withNetwork("routes across buildings", () => {
    const res = findIndoorPath("SW3", "SW3-1602", "SW5-1840");
    expect(res.success).toBe(true);
    expect(res.distanceM).toBeGreaterThan(0);
    const buildings = new Set(res.path.map((p) => p.building).filter(Boolean));
    expect(buildings.has("SW3")).toBe(true);
    expect(buildings.has("SW5")).toBe(true);
  });

  withNetwork("routes between two rooms the network serves", () => {
    const pick = pickBuilding();
    expect(pick).not.toBeNull();
    const res = findIndoorPath(pick.building, pick.rooms[0], pick.rooms[1]);
    expect(res.success).toBe(true);
    expect(res.path.length).toBeGreaterThanOrEqual(2);
    expect(res.distanceM).toBeGreaterThan(0);
    for (const p of res.path) {
      expect(typeof p.lng).toBe("number");
      expect(typeof p.lat).toBe("number");
    }
  });

  // An unmatched room used to fall through to "the first corridor in the
  // building", so two rooms that were both missing came back as a confident
  // 0m route between them. A route to somewhere the caller did not ask for is
  // worse than no route.
  withNetwork("fails on a room number that is not on the map", () => {
    const pick = pickBuilding();
    const res = findIndoorPath(pick.building, pick.rooms[0], "999999");
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/999999/);
  });

  // The whole point of the rewrite: a room is a label on a node, so a room
  // nobody has put a node in is honestly unreachable rather than quietly
  // attached to whatever happened to be nearest.
  withNetwork("says so when a room has no node rather than inventing one", () => {
    const orphans = graph.unreachableRooms || {};
    const building = Object.keys(orphans)[0];
    if (!building) return; // every room is served; nothing to assert
    const pick = pickBuilding();
    const res = findIndoorPath(building, pick.rooms[0], orphans[building][0]);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no walking node/i);
  });

  // Every point on a route is a node of the network, and every step between
  // them is a link somebody drew -- not a straight line between rooms.
  withNetwork("follows links that exist in the network", () => {
    const pick = pickBuilding();
    const linked = new Set(
      (graph.edges || []).map(([i, j]) => `${graph.nodes[i].nid}|${graph.nodes[j].nid}`)
    );
    const joined = (a, b) => linked.has(`${a}|${b}`) || linked.has(`${b}|${a}`);

    let routed = 0;
    for (let i = 0; i < Math.min(pick.rooms.length, 8); i++) {
      for (let j = i + 1; j < Math.min(pick.rooms.length, 8); j++) {
        const res = findIndoorPath(pick.building, pick.rooms[i], pick.rooms[j]);
        if (!res.success) continue;
        routed += 1;
        const ids = res.path.map((p) => {
          const hit = graph.nodes.find((n) => n.lng === p.lng && n.lat === p.lat);
          return hit?.nid;
        });
        for (let k = 1; k < ids.length; k++) {
          expect(joined(ids[k - 1], ids[k])).toBe(true);
        }
      }
    }
    expect(routed).toBeGreaterThan(0);
  });

  withNetwork("never returns a zero-length route between two different rooms", () => {
    const pick = pickBuilding();
    const unique = [...new Set(pick.rooms)].slice(0, 12);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const res = findIndoorPath(pick.building, unique[i], unique[j]);
        if (res.success) expect(res.distanceM).toBeGreaterThan(0);
      }
    }
  });
});
