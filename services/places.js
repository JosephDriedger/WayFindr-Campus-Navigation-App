// services/places.js
//
// Where a named campus place is, for the ones the walking network does not
// reach.
//
// The network is traced by hand, so it stops where somebody stopped tracing:
// six car parks have nodes in them and twenty-eight do not, and asking to be
// taken to one of those twenty-eight used to be answered with "no walking
// node, so there is no way to route to it yet". That is true of the network
// and useless to the person asking -- the lot is right there on the map, they
// can see it, and the walk to the nearest path is a walk they can make.
//
// So a place nobody has traced still has an outline, and the middle of that
// outline is a point. The router snaps it to the nearest node and draws the
// approach, which is the honest answer: this is where the mapped paths begin.
//
// The outlines are the same files the map draws from, read once and reread
// when they change, so tracing a new lot or moving a building needs no
// second copy of anything.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "public", "data");

// name property to read, per file. A building goes by its code, and its
// display name is what people call it out loud; a car park is named outright.
//
// Buildings come first, and the order matters: where a lot outline runs under
// a building, a point in both is in the building, which is the more specific
// answer. The tracer resolves it the same way.
const SOURCES = [
  { file: "bcit-coordinates.geojson", keys: ["BuildingName", "Display_Name"] },
  { file: "parking-lots.geojson", keys: ["name"] },
];

let cached = null; // { stamp, places, outlines }

/** A name as it is looked up: upper case, single spaces, nothing else. */
export const normalizePlaceName = (text) =>
  String(text ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/** Every [lng, lat] in a geometry, whatever it is nested inside. */
function pointsOf(geometry) {
  const out = [];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") out.push(c);
    else c.forEach(walk);
  };
  walk(geometry?.coordinates);
  return out;
}

/** The outer ring of every polygon in a geometry. Holes are not outlines. */
function ringsOf(geometry) {
  if (geometry?.type === "Polygon") {
    return geometry.coordinates?.[0] ? [geometry.coordinates[0]] : [];
  }
  if (geometry?.type === "MultiPolygon") {
    return (geometry.coordinates || []).map((poly) => poly[0]).filter(Boolean);
  }
  return [];
}

/** The box a ring sits in, worked out once and kept on it. */
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

function inRing(ring, x, y) {
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

/**
 * Load the outlines, keyed by every name they answer to.
 *
 * A lot traced in several pieces -- LOT G is four polygons -- is one place,
 * so the pieces are accumulated and the middle taken over all of them rather
 * than over whichever piece was read last.
 *
 * The rings are kept as well as the middles, because "which place is this
 * point in" is the other question asked of the same data: a node dropped
 * inside Lot L belongs to Lot L, and that is a fact about where it stands.
 */
function load() {
  const stamp = SOURCES.map(({ file }) => {
    try {
      return fs.statSync(path.join(DATA, file)).mtimeMs;
    } catch {
      return 0;
    }
  }).join("|");
  if (cached && cached.stamp === stamp) return cached;

  const acc = new Map(); // NAME -> { name, sumLng, sumLat, n }
  const outlines = [];   // in source order: buildings, then car parks
  for (const { file, keys } of SOURCES) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(DATA, file), "utf-8"));
    } catch {
      continue; // a missing outline file is one fewer place, not an error
    }
    for (const feature of data.features || []) {
      const props = feature.properties || {};
      const points = pointsOf(feature.geometry);
      if (!points.length) continue;
      // The first key that is filled in is what the outline is called. A
      // building answers to its code before its display name.
      const primary = keys.map((k) => props[k]).find((v) => normalizePlaceName(v));
      const rings = ringsOf(feature.geometry);
      if (primary && rings.length) {
        outlines.push({ name: String(primary).trim(), rings });
      }
      for (const key of keys) {
        const label = normalizePlaceName(props[key]);
        if (!label) continue;
        if (!acc.has(label)) {
          acc.set(label, {
            name: String(props[key]).trim(), sumLng: 0, sumLat: 0, n: 0,
          });
        }
        const entry = acc.get(label);
        for (const [lng, lat] of points) {
          entry.sumLng += lng;
          entry.sumLat += lat;
          entry.n += 1;
        }
      }
    }
  }

  const places = new Map();
  for (const [label, e] of acc) {
    if (!e.n) continue;
    places.set(label, { name: e.name, lng: e.sumLng / e.n, lat: e.sumLat / e.n });
  }
  cached = { stamp, places, outlines };
  return cached;
}

/** Whether anything on campus goes by this name. */
export function isPlace(name) {
  const label = normalizePlaceName(name);
  return Boolean(label) && load().places.has(label);
}

/**
 * The middle of a named place, or null if nothing goes by that name.
 * Returns { name, lng, lat } -- name as it is written on the map, not as it
 * was typed, so the directions read the way the label does.
 */
export function placeCentre(name) {
  const label = normalizePlaceName(name);
  if (!label) return null;
  const found = load().places.get(label);
  return found ? { ...found } : null;
}

/**
 * The place a point stands in, or null when it is out in the open.
 *
 * Buildings are checked before car parks: where a lot outline runs under a
 * building, the building is the more specific answer, and this is the same
 * order the tracer uses so a node gets the same answer whether it was
 * labelled in the browser or on the way into the file.
 */
export function placeAt(lng, lat) {
  const x = Number(lng);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  for (const outline of load().outlines) {
    if (outline.rings.some((ring) => inRing(ring, x, y))) return outline.name;
  }
  return null;
}

/** Forget the loaded outlines, so the next lookup reads them fresh. */
export function invalidatePlaceCache() {
  cached = null;
}
