import { applyDelta, featureKey, danglingLinks } from "../services/networkDelta.js";

const node = (nid, lng = 0, lat = 0, extra = {}) => ({
  type: "Feature",
  properties: { type: "node", nid, ...extra },
  geometry: { type: "Point", coordinates: [lng, lat] },
});

const link = (a, b) => ({
  type: "Feature",
  properties: { type: "path", nodes: [a, b] },
  geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
});

describe("featureKey", () => {
  it("identifies a node by its id", () => {
    expect(featureKey(node("abc"))).toBe("n:abc");
  });

  // "A to B" and "B to A" are one link, and treating them as two is how a
  // network quietly gains duplicates every time it round-trips.
  it("identifies a link by its pair, whichever way round it is written", () => {
    expect(featureKey(link("a", "b"))).toBe(featureKey(link("b", "a")));
  });

  it("has no key for something that is neither", () => {
    expect(featureKey({ properties: { type: "room" } })).toBeNull();
    expect(featureKey(null)).toBeNull();
  });
});

describe("applyDelta", () => {
  const existing = [node("a", 1, 1), node("b", 2, 2), link("a", "b")];

  it("adds what is new", () => {
    const out = applyDelta(existing, { add: [node("c", 3, 3)] });
    expect(out.features).toHaveLength(4);
    expect(out.added).toBe(1);
  });

  it("replaces what it already has", () => {
    const moved = node("a", 9, 9);
    const out = applyDelta(existing, { update: [moved] });
    expect(out.features).toHaveLength(3);
    expect(out.updated).toBe(1);
    const a = out.features.find((f) => f.properties.nid === "a");
    expect(a.geometry.coordinates).toEqual([9, 9]);
  });

  it("removes by key", () => {
    const out = applyDelta(existing, { remove: ["n:b"] });
    expect(out.removed).toBe(1);
    expect(out.features.map(featureKey)).not.toContain("n:b");
  });

  // The file is read by people as well as programs; reshuffling it on every
  // save would make each one look like a rewrite.
  it("keeps what was already there in the order it was in", () => {
    const out = applyDelta(existing, { add: [node("z", 5, 5)], update: [node("a", 9, 9)] });
    expect(out.features.map(featureKey)).toEqual(["n:a", "n:b", "p:a|b", "n:z"]);
  });

  it("counts what happened, not what was asked for", () => {
    // removing something absent, and "adding" something already present
    const out = applyDelta(existing, { add: [node("a", 4, 4)], remove: ["n:nope"] });
    expect(out.removed).toBe(0);
    expect(out.added).toBe(0);
    expect(out.updated).toBe(1);
  });

  it("changes nothing when the change is empty", () => {
    const out = applyDelta(existing, {});
    expect(out.features).toEqual(existing);
    expect([out.added, out.updated, out.removed]).toEqual([0, 0, 0]);
  });

  it("ignores a feature it cannot identify", () => {
    const out = applyDelta(existing, { add: [{ properties: { type: "room" } }] });
    expect(out.features).toHaveLength(3);
  });
});

describe("danglingLinks", () => {
  // A link to a node that is not there is dropped silently at the next
  // rebuild, so the network loses a connection somebody drew.
  it("spots a link whose node is missing", () => {
    expect(danglingLinks([node("a"), link("a", "ghost")])).toEqual(["ghost"]);
  });

  it("is happy when every link resolves", () => {
    expect(danglingLinks([node("a"), node("b"), link("a", "b")])).toEqual([]);
  });

  // deleting a node has to take its links with it, and this is what proves it
  it("catches what a careless delete would leave behind", () => {
    const after = applyDelta([node("a"), node("b"), link("a", "b")], { remove: ["n:b"] });
    expect(danglingLinks(after.features)).toEqual(["b"]);
  });
});
