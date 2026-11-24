// services/planLibrary.js
//
// The floor-plan library: the sheets themselves, and what happens when one of
// them is replaced.
//
// BCIT owns these drawings and keeps drawing them. A wall moves, a lab is
// split in two, a whole floor is refitted -- and the sheet we traced from is
// then a picture of a building that no longer exists. So a new sheet has to be
// something a person can hand to the app, not something that needs a
// developer, a checkout and a Python prompt.
//
// Replacing a sheet is four things, and this does all four so that none of
// them can be forgotten:
//
//   1. keep the old one. An update can be wrong, or be the wrong floor, and
//      the way back should be a click rather than an email to Facilities.
//   2. render the picture the tracer draws under the map.
//   3. keep the position that picture was given on the map, when the geometry
//      says it is safe to -- see carryPlacement below.
//   4. say what is now in doubt: the rooms traced from the old sheet are still
//      there, and nothing but a person looking at both can say which of them
//      moved.
//
// What is NOT done here: nothing is deleted, and no traced room is touched. A
// floor plan is the evidence; the tracing is the work. Replacing the evidence
// must never quietly throw away the work.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { isPlace, normalizePlaceName } from "./places.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DATA = path.join(REPO, "public", "data");

export const PDF_DIR = path.join(DATA, "floorplans");
export const IMAGE_DIR = path.join(DATA, "floorplan-images");
export const FLOOR_DIR = path.join(DATA, "floor-coordinates");
export const ARCHIVE_DIR = path.join(DATA, "floorplan-archive");
const INDEX = path.join(IMAGE_DIR, "_index.json");
const PLACEMENTS = path.join(IMAGE_DIR, "_placements.json");
const UPLOAD_LOG = path.join(ARCHIVE_DIR, "_uploads.json");

// The same shapes the tracer accepts, for the same reason: these become file
// names, so anything else is refused rather than tidied into something
// unexpected.
const CODE = /^[A-Za-z][A-Za-z0-9]{0,7}$/;
const FLOOR = /^[0-9]{1,3}$/;

// A BCIT sheet is a few megabytes; the largest in the set is under ten. The
// cap is not about disk, it is about noticing when somebody has dropped the
// wrong thing entirely -- a video, a zip, the whole CAD model.
export const MAX_BYTES = 64 * 1024 * 1024;

const R_EARTH = 6371008.8;
const mPerDegLat = () => (Math.PI / 180) * R_EARTH;
const mPerDegLng = (lat) => mPerDegLat() * Math.cos((lat * Math.PI) / 180);

/** An error that already knows what status the caller should answer with. */
export class PlanError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
};

const writeJson = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2), "utf-8");
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** The canonical name of a sheet: SW1-Floor2. */
export function stemFor(building, floor) {
  if (!CODE.test(String(building)) || !FLOOR.test(String(floor))) return null;
  // "04" and "4" are the same floor, and the file is named once, so pick one.
  return `${String(building).toUpperCase()}-Floor${Number(floor)}`;
}

/**
 * Which sheet a dropped file is, read from its name.
 *
 * Facilities will send a folder of drawings, not one file with a form filled
 * in beside it -- and the names they arrive with already say what they are:
 * "SW1-Floor2.pdf", "SW1_Floor2.pdf", "sw1 floor 2.pdf", "SW1-2.pdf". Reading
 * the name turns thirty uploads into one drop. Anything it cannot read is
 * handed back for a person to name rather than guessed at.
 *
 * The number has to be announced -- by the word "floor", or by a separator.
 * Building codes end in digits themselves, so without that rule "SW12" is
 * both a building and a floor of another one, and "scan0001.pdf" is confidently
 * read as floor 1 of a building called SCAN0. A wrong guess that looks right
 * is worse here than no guess at all: no guess stops at an empty box, and a
 * wrong one is uploaded onto somebody else's floor.
 */
export function parsePlanName(filename) {
  const base = String(filename || "").replace(/\.[A-Za-z0-9]+$/, "").trim();
  const m = base.match(
    /^([A-Za-z][A-Za-z0-9]{0,7}?)(?:[-_\s]*(?:floor|flr|fl|lvl|level|l)[-_\s]*|[-_\s]+)(\d{1,3})$/i
  );
  if (!m) return null;
  const stem = stemFor(m[1], m[2]);
  if (!stem) return null;
  return { building: m[1].toUpperCase(), floor: String(Number(m[2])), stem };
}

// ---------------------------------------------------------------------------
// What arrived
// ---------------------------------------------------------------------------

const PDF_MAGIC = Buffer.from("%PDF-");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What a file actually is, from its first few bytes.
 *
 * Not from its name and not from its Content-Type: both are typed by whoever
 * is sending, and a .pdf that is really a Word document should fail here, in
 * a sentence, rather than three steps later inside a renderer.
 */
export function sniffKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;
  if (bytes.subarray(0, 5).equals(PDF_MAGIC)) return "pdf";
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  return null;
}

/** A PNG states its own size in the header; no decoder needed to read it. */
export function pngSize(bytes) {
  if (sniffKind(bytes) !== "png" || bytes.length < 24) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// Keeping the position a sheet was given
// ---------------------------------------------------------------------------
//
// A placement is a centre, a width in metres and an angle -- where THIS
// picture sits on the campus. The picture is the page cropped to its ink, and
// a redrawn sheet has ink in slightly different places, so the crop moves and
// the old centre now points at a different part of the drawing. Left alone,
// every update would nudge the plan off the building it belongs to and a
// person would have to drag it back by eye.
//
// But the two crops are windows onto the same page, and the renderer records
// where each one sat. If the page itself has not changed, the whole difference
// is: the window moved by so many pixels, and is so many pixels wider. Metres
// per pixel comes from the old placement, and the shift becomes a shift on the
// ground.
//
// Checking that the page frame matches is what keeps this honest. A sheet
// reissued at a different drawing scale, or on a different size of paper, is
// not the same picture at a new crop, and no arithmetic here can place it --
// that one is handed back to a person.

const frameOf = (entry) => {
  const crop = entry?.crop;
  const page = entry?.page;
  if (!Array.isArray(crop) || crop.length !== 4 || !Array.isArray(page)) return null;
  if (!crop.every(Number.isFinite) || !page.every(Number.isFinite)) return null;
  const width = Number(entry.width) || crop[2] - crop[0] + 1;
  const height = Number(entry.height) || crop[3] - crop[1] + 1;
  return {
    page,
    width,
    height,
    cx: crop[0] + width / 2,   // the middle of the crop window, in page pixels
    cy: crop[1] + height / 2,
    zoom: Number(entry.zoom) || null,
  };
};

/**
 * Where the old placement belongs on the new picture.
 *
 * Returns { status, placement, note }. Only "moved" and "unchanged" carry a
 * placement forward; every other status means "a person has to look at this",
 * and the caller says so rather than inventing a position.
 */
export function carryPlacement(before, after, placement) {
  if (!placement) {
    return { status: "none", note: "This Sheet Had No Position on the Map Yet." };
  }

  const a = frameOf(before);
  const b = frameOf(after);
  if (!a || !b) {
    return {
      status: "unknown",
      note: "The Old Picture Did Not Record Where It Sat on the Page, so Its "
        + "Position Could Not Be Carried over. Check It Against the Building.",
    };
  }
  if (a.zoom && b.zoom && a.zoom !== b.zoom) {
    return { status: "rescaled", note: "The Two Pictures Were Rendered at Different Scales." };
  }
  if (Math.abs(a.page[0] - b.page[0]) > 1 || Math.abs(a.page[1] - b.page[1]) > 1) {
    return {
      status: "page-changed",
      note: `The new sheet is a different size of page (${b.page[0]}x${b.page[1]} `
        + `rendered pixels, was ${a.page[0]}x${a.page[1]}), so it is probably drawn at `
        + "A Different Scale. Line It Up with the Building Again.",
    };
  }

  const mPerPx = placement.widthM / a.width;
  if (!Number.isFinite(mPerPx) || mPerPx <= 0) {
    return { status: "unknown", note: "The Old Position Was Not Usable." };
  }

  // How far the crop window moved, in metres on the ground. Page pixels run
  // down and north runs up, hence the flip; then the drawing's own rotation
  // turns that offset into one on the map, exactly as the tracer does.
  const x = (b.cx - a.cx) * mPerPx;
  const y = -(b.cy - a.cy) * mPerPx;
  const th = ((placement.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  const next = {
    lng: placement.lng + (x * cos - y * sin) / mPerDegLng(placement.lat),
    lat: placement.lat + (x * sin + y * cos) / mPerDegLat(),
    widthM: b.width * mPerPx,
    rotation: placement.rotation || 0,
  };

  const movedM = Math.hypot(x, y);
  const grewM = Math.abs(next.widthM - placement.widthM);
  if (movedM < 0.01 && grewM < 0.01) {
    return {
      status: "unchanged",
      placement,
      note: "The New Sheet Crops to the Same Part of the Page, so Its Position Is Unchanged.",
    };
  }
  return {
    status: "moved",
    placement: next,
    movedM,
    note: `The drawing crops differently, so its position was shifted ${movedM.toFixed(2)} m `
      + `and its width set to ${next.widthM.toFixed(1)} m to match.`,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Run one of the repo's Python tools.
 *
 * "py" is the Windows launcher the rest of this project's tooling uses;
 * python3 is the same thing on the host this is deployed to.
 */
export function runPython(script, args, { cwd = REPO, timeout = 600000 } = {}) {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const exe = win ? "py" : "python3";
    const argv = win ? ["-3", script, ...args] : [script, ...args];
    execFile(exe, argv, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`;
      resolve({
        script,
        // The renderer reports a bad sheet per-file and still exits 0, so a
        // zero status alone is not proof that anything was rendered.
        ok: !err && !output.includes("[FAIL]"),
        output,
        error: err ? err.message : null,
      });
    });
  });
}

const renderSheet = (building, floor) =>
  runPython("floorPlans/render_plan_images.py",
    [String(building).toUpperCase(), "--floor", String(Number(floor)), "--force"]);

// ---------------------------------------------------------------------------
// Reading the library
// ---------------------------------------------------------------------------

const tracedCount = (stem) => {
  const fc = readJson(path.join(FLOOR_DIR, `${stem}.geojson`), null);
  return Array.isArray(fc?.features) ? fc.features.length : 0;
};

const statOf = (file) => {
  try {
    const s = fs.statSync(file);
    return { bytes: s.size, updated: s.mtime.toISOString() };
  } catch {
    return null;
  }
};

/** The stamp a kept copy is named with, back as a readable time. */
function versionTime(version) {
  const m = String(version).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Previous versions of one sheet, newest first.
 *
 * A replacement keeps both the drawing and the picture rendered from it, and
 * those two files are one version of the sheet -- not two things to choose
 * between. They are grouped so that putting a version back means putting back
 * what was there, rather than asking somebody which half they meant.
 */
export function versionsOf(stem) {
  const dir = path.join(ARCHIVE_DIR, stem);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];   // nothing has ever been replaced here
  }

  const byVersion = new Map();
  for (const name of names) {
    const m = name.match(/^(.+)\.(pdf|png)$/i);
    if (!m) continue;
    const [, version, ext] = m;
    const kind = ext.toLowerCase();
    const stat = statOf(path.join(dir, name)) || { bytes: 0, updated: null };
    const row = byVersion.get(version)
      || { version, at: versionTime(version) || stat.updated, files: {} };
    row.files[kind] = {
      file: name,
      bytes: stat.bytes,
      url: `/data/floorplan-archive/${encodeURIComponent(stem)}/${encodeURIComponent(name)}`,
    };
    byVersion.set(version, row);
  }

  return [...byVersion.values()]
    .map((row) => ({
      ...row,
      // Putting a version back means handing its source drawing to the same
      // path an upload takes; the picture is only worth restoring when there
      // is no drawing behind it.
      restore: row.files.pdf?.file || row.files.png?.file || null,
    }))
    .sort((a, b) => String(b.version).localeCompare(String(a.version)));
}

/**
 * Every sheet the app has, with what a person needs in order to decide which
 * one they are replacing.
 */
export function listPlans() {
  const index = readJson(INDEX, {});
  const placements = readJson(PLACEMENTS, {});

  // A sheet exists if it has a rendered picture OR a source PDF -- a PDF that
  // failed to render is exactly the sort of thing that has to stay visible.
  const stems = new Set(Object.keys(index));
  try {
    for (const f of fs.readdirSync(PDF_DIR)) {
      if (f.toLowerCase().endsWith(".pdf")) stems.add(f.replace(/\.pdf$/i, ""));
    }
  } catch { /* no source PDFs on this host; the pictures are enough */ }

  const plans = [...stems].map((stem) => {
    const entry = index[stem] || {};
    const m = stem.match(/^(.+)-Floor(\d+)$/);
    const building = entry.building || m?.[1] || stem;
    const floor = String(entry.floor ?? m?.[2] ?? "");
    const pdf = statOf(path.join(PDF_DIR, `${stem}.pdf`));
    const png = statOf(path.join(IMAGE_DIR, `${stem}.png`));
    return {
      stem,
      building,
      floor,
      image: entry.image || (png ? `/data/floorplan-images/${stem}.png` : null),
      width: entry.width || null,
      height: entry.height || null,
      source: pdf ? { kind: "pdf", url: `/data/floorplans/${stem}.pdf`, ...pdf } : null,
      rendered: png,
      placed: Boolean(placements[stem]),
      traced: tracedCount(stem),
      versions: versionsOf(stem).length,
      // A code nobody has an outline for is usually a typo in a file name. It
      // is not refused -- a new building is a real thing -- but it is said out
      // loud, because "NE1O-Floor1" looks exactly like "NE10-Floor1".
      knownBuilding: isPlace(normalizePlaceName(building)),
    };
  });

  plans.sort((a, b) =>
    a.building.localeCompare(b.building, undefined, { numeric: true })
    || Number(a.floor) - Number(b.floor));
  return plans;
}

/** The last few replacements, newest first: who changed what, and when. */
export function uploadHistory(limit = 40) {
  const log = readJson(UPLOAD_LOG, []);
  return Array.isArray(log) ? log.slice(-limit).reverse() : [];
}

// ---------------------------------------------------------------------------
// Replacing a sheet
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Put the current files somewhere they can be got back from. */
function archiveCurrent(stem) {
  const dir = path.join(ARCHIVE_DIR, stem);
  const ts = stamp();
  const kept = [];
  for (const [from, ext] of [
    [path.join(PDF_DIR, `${stem}.pdf`), "pdf"],
    [path.join(IMAGE_DIR, `${stem}.png`), "png"],
  ]) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(from, path.join(dir, `${ts}.${ext}`));
    kept.push({ kind: ext, file: `${ts}.${ext}` });
  }
  return { version: ts, kept };
}

function appendLog(record) {
  const log = readJson(UPLOAD_LOG, []);
  const rows = Array.isArray(log) ? log : [];
  rows.push(record);
  // Long enough to answer "when did this floor last change", short enough
  // that nobody has to think about the file.
  writeJson(UPLOAD_LOG, rows.slice(-500));
}

// Two people replacing two sheets at the same moment would both read
// _index.json, both re-render, and the second would write back a copy of the
// index taken before the first one's entry existed. Replacements are rare and
// quick, so they take turns.
let queue = Promise.resolve();
const serialise = (job) => {
  const run = queue.then(job, job);
  queue = run.then(() => undefined, () => undefined);
  return run;
};

/**
 * Put a new sheet in place of whatever is there now.
 *
 * Returns a report rather than just "ok": what it rendered, whether the map
 * position survived, and what is now worth a second look.
 */
export function replacePlan(opts) {
  return serialise(() => doReplace(opts));
}

async function doReplace({ building, floor, bytes, filename = "", by = null }) {
  const stem = stemFor(building, floor);
  if (!stem) {
    throw new PlanError(400,
      "A Sheet Is Named by a Building Code and a Floor Number, Like SW1 Floor 2.");
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new PlanError(400, "The Upload Arrived Empty.");
  }
  if (bytes.length > MAX_BYTES) {
    throw new PlanError(413, `That file is ${(bytes.length / 1048576).toFixed(1)} MB; `
      + `the limit is ${MAX_BYTES / 1048576} MB.`);
  }
  const kind = sniffKind(bytes);
  if (!kind) {
    throw new PlanError(415,
      "Floor Plans Are PDF Drawings, or PNG Pictures of One. That File Is Neither.");
  }

  const index = readJson(INDEX, {});
  const before = index[stem] || null;
  const placements = readJson(PLACEMENTS, {});
  const placement = placements[stem] || null;
  const pdfPath = path.join(PDF_DIR, `${stem}.pdf`);
  const pngPath = path.join(IMAGE_DIR, `${stem}.png`);
  const replaced = Boolean(before) || fs.existsSync(pdfPath);

  const archive = archiveCurrent(stem);
  const restore = (file, kept) => {
    const from = kept && path.join(ARCHIVE_DIR, stem, kept.file);
    if (from && fs.existsSync(from)) fs.copyFileSync(from, file);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  };

  let after;
  if (kind === "pdf") {
    fs.mkdirSync(PDF_DIR, { recursive: true });
    fs.writeFileSync(pdfPath, bytes);
    const render = await renderSheet(building, floor);
    // The renderer owns _index.json, so what it wrote is read back rather
    // than assumed -- including the page frame the next update will need.
    const written = readJson(INDEX, {});
    const fresh = written[stem];
    if (!render.ok || !fresh) {
      // Nothing half-done is left behind: the sheet that was working goes
      // back, and the person is told what the renderer objected to.
      restore(pdfPath, archive.kept.find((k) => k.kind === "pdf"));
      restore(pngPath, archive.kept.find((k) => k.kind === "png"));
      throw new PlanError(422,
        "That PDF Could Not Be Turned into a Drawing, so Nothing Was Changed.",
        (render.output || render.error || "").trim().slice(-600));
    }
    after = fresh;
  } else {
    const size = pngSize(bytes);
    if (!size) throw new PlanError(415, "That PNG Could Not Be Read.");
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(pngPath, bytes);
    // A PDF left sitting beside a hand-supplied picture is a trap: the next
    // run of the renderer would quietly paint over the picture with the old
    // drawing. It is archived first, so taking it away loses nothing.
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    after = {
      building: String(building).toUpperCase(),
      floor: String(Number(floor)),
      image: `/data/floorplan-images/${stem}.png`,
      width: size.width,
      height: size.height,
      // No page frame: a picture handed over on its own says nothing about
      // the sheet it was cut from, so its position cannot be carried.
    };
    index[stem] = after;
    writeJson(INDEX, index);
  }

  const carried = carryPlacement(before, after, placement);
  if (carried.placement) {
    placements[stem] = { ...carried.placement, updated: new Date().toISOString() };
    writeJson(PLACEMENTS, placements);
  }

  const report = {
    ok: true,
    stem,
    building: after.building,
    floor: after.floor,
    kind,
    replaced,
    filename,
    image: after.image,
    width: after.width,
    height: after.height,
    resized: Boolean(before) && (before.width !== after.width || before.height !== after.height),
    was: before ? { width: before.width, height: before.height } : null,
    placement: { status: carried.status, note: carried.note },
    traced: tracedCount(stem),
    archived: archive.kept.map((k) => k.file),
    version: archive.kept.length ? archive.version : null,
    at: new Date().toISOString(),
  };

  appendLog({
    at: report.at,
    stem,
    kind,
    filename,
    bytes: bytes.length,
    by,
    replaced,
    placement: carried.status,
    version: report.version,
  });

  return report;
}

/**
 * Put a previous version back.
 *
 * The same path as an upload -- it IS an upload, of a file we happen to still
 * have -- so the copy being replaced is archived in its turn and the position
 * is carried the same way. Reverting a revert gets you back again.
 */
export function restoreVersion({ building, floor, file, by = null }) {
  const stem = stemFor(building, floor);
  if (!stem) throw new PlanError(400, "Bad Building or Floor.");
  // A version is a file this service wrote, in this sheet's own folder. The
  // shape is checked rather than the path cleaned, so nothing that is not one
  // of ours can be pointed at.
  if (!/^[-0-9TZ.]+\.(pdf|png)$/i.test(String(file || ""))) {
    throw new PlanError(400, "That Is Not a Saved Version of This Sheet.");
  }
  const from = path.join(ARCHIVE_DIR, stem, file);
  if (!fs.existsSync(from)) throw new PlanError(404, "That Version Is No Longer Stored.");
  return replacePlan({
    building,
    floor,
    bytes: fs.readFileSync(from),
    filename: `${stem} (restored from ${file})`,
    by,
  });
}
