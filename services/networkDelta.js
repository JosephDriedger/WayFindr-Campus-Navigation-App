// services/networkDelta.js
//
// Applying a change to the walking network.
//
// The network is one document for the whole campus and it grows with every
// node traced, so sending all of it back to change three of them is most of
// the cost of saving. A change says what it is a change TO, and is applied
// only to that version -- the rest of the safety is in the route, which
// refuses a change whose base has moved on.
//
// Kept out of the route so it can be tested for what it is: a small,
// order-preserving merge with no I/O in it.

/**
 * How a node or a link is identified.
 *
 * A node is its id. A link is the pair it joins, in a fixed order, so that
 * "A to B" and "B to A" are recognised as the same link rather than quietly
 * becoming two.
 */
export function featureKey(feature) {
  const props = feature?.properties || {};
  if (props.type === "node" && props.nid) return `n:${props.nid}`;
  if (props.type === "path" && Array.isArray(props.nodes) && props.nodes.length === 2) {
    return `p:${[...props.nodes].sort().join("|")}`;
  }
  return null;
}

/**
 * Merge a change into a set of features.
 *
 * Order is preserved: things that were already there stay where they were and
 * new ones go on the end, so the file stays a readable history of the tracing
 * rather than being reshuffled on every save.
 *
 * Returns { features, added, updated, removed } -- the counts are what
 * actually happened, which is not always what was asked for: removing
 * something that is not there changes nothing.
 */
export function applyDelta(existing, { add = [], update = [], remove = [] } = {}) {
  const byKey = new Map();
  for (const f of existing) {
    const key = featureKey(f);
    if (key) byKey.set(key, f);
  }

  let removed = 0;
  for (const key of remove) {
    if (byKey.delete(key)) removed += 1;
  }

  let added = 0;
  let updated = 0;
  for (const f of [...add, ...update]) {
    const key = featureKey(f);
    if (!key) continue;
    if (byKey.has(key)) updated += 1;
    else added += 1;
    byKey.set(key, f);
  }

  return { features: [...byKey.values()], added, updated, removed };
}

/**
 * Which links would be left pointing at a node that is not there.
 *
 * A link to a missing node is a hole: the graph builder drops it silently at
 * the next rebuild, so the network quietly loses a connection somebody drew.
 */
export function danglingLinks(features) {
  const nodes = new Set(
    features.filter((f) => f.properties?.type === "node").map((f) => f.properties.nid)
  );
  const dangling = [];
  for (const f of features) {
    if (f.properties?.type !== "path") continue;
    for (const nid of f.properties.nodes || []) {
      if (!nodes.has(nid)) dangling.push(nid);
    }
  }
  return dangling;
}
