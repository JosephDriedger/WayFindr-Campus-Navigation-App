// public/js/space-colours.js
//
// A colour per kind of space, for every map that draws a floor.
//
// Warm means somewhere you can be sent; everything else is cooler and sits
// back. Beyond that the point is telling them apart at a glance: a stairwell
// should not have to be read to be recognised.
//
// It lives on its own because two different maps draw the same floors -- the
// public map and the tracer you draw them on -- and a room that is orange in
// one and blue in the other is two pictures of one floor. Tracing is checking:
// you are looking at the sheet to see whether what you drew is right, and it
// is only checkable if it looks like what everyone else will see. So the table
// is written once and both read it, which is also why the fill, the outline,
// the label and the line weight are kept together rather than spread across
// whichever layer happens to need them.

export const SPACE_COLOURS = {
  room: {
    fill: "#fb923c", line: "#b91c1c", opacity: 0.65, label: "#7c2d12", width: 1.4,
  },
  hallway: {
    fill: "#cbd5e1", line: "#94a3b8", opacity: 0.5, label: "#475569", width: 1,
  },
  service: {
    fill: "#a8a29e", line: "#78716c", opacity: 0.45, label: "#57534e", width: 1,
  },
  stairs: {
    fill: "#6ee7b7", line: "#059669", opacity: 0.7, label: "#065f46", width: 1.4,
  },
  elevator: {
    fill: "#c4b5fd", line: "#7c3aed", opacity: 0.7, label: "#5b21b6", width: 1.4,
  },
  // The wall around everything else, so it is nearly all outline: a building
  // filled in like a room would sit over every room in it and turn the whole
  // floor one colour. Only the tracer draws these -- on the public map a
  // building comes from the campus outlines, not from the floor -- but it is
  // in the table so that a traced one cannot be mistaken for a room, which is
  // what the fallback below would otherwise make it.
  building: {
    fill: "#93c5fd", line: "#2563eb", opacity: 0.06, label: "#1d4ed8", width: 1.6,
  },
};

// An outline with no type, or one this table has not heard of, is a room:
// that is what most of them are, and a room is the safe thing to look like.
export const DEFAULT_SPACE = SPACE_COLOURS.room;

/** One field of the table above, as a Mapbox match expression on `type`. */
export const byType = (field) => [
  "match", ["get", "type"],
  ...Object.entries(SPACE_COLOURS).flatMap(([type, c]) => [type, c[field]]),
  DEFAULT_SPACE[field],
];
