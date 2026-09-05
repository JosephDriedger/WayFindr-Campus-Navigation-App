import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { checkSession } from "../middleware/authMiddleware.js";

import { handlePathRequest } from "../controllers/pathfinderController.js";
import { verticalSpacesByFloor } from "../services/indoorGraph.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEARCH_INDEX = path.join(
  __dirname, "..", "public", "data", "room-search-index.json");

let coverageCache = { mtimeMs: -1, value: null };

/**
 * How much of campus is actually mapped, counted from the generated search
 * index rather than written into the page by hand -- a hardcoded "40+
 * buildings" goes stale silently, and these numbers move every time a floor
 * is traced.
 *
 * Recomputed when the index file changes rather than once at boot: the tracer
 * rebuilds that file while the server is running, so a boot-time snapshot
 * would show yesterday's campus until someone restarted.
 *
 * Returns null when nothing is mapped yet, so the home page leaves the
 * numbers out instead of presenting three zeros as though something broke.
 */
function getCoverage() {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(SEARCH_INDEX).mtimeMs;
  } catch {
    return null;
  }
  if (mtimeMs === coverageCache.mtimeMs) return coverageCache.value;

  let value = null;
  try {
    const rooms = JSON.parse(fs.readFileSync(SEARCH_INDEX, "utf-8")).rooms || [];
    if (rooms.length) {
      const buildings = new Set();
      const floors = new Set();
      for (const r of rooms) {
        if (!r.building) continue;
        buildings.add(r.building);
        if (r.floor) floors.add(`${r.building}|${r.floor}`);
      }
      value = { buildings: buildings.size, floors: floors.size, rooms: rooms.length };
    }
  } catch {
    value = null;
  }
  coverageCache = { mtimeMs, value };
  return value;
}


// Home page
router.get('/', (req, res) => {
  res.render('index', {
    page: 'index',
    title: 'Wayfindr the Campus Map Navigator',
    user: req.session.user,
    coverage: getCoverage(),
  });
});

// Map page (interactive BCIT campus map: buildings, floors, room search).
//
// Open to everyone. Finding a room is the whole point of the app, and it is
// exactly what a visitor or a first-week student needs before they have any
// reason to make an account. What is personal is what you SAVE -- favourites
// stay behind checkSession, and the map's star button already says "Log in to
// save favorites" when nobody is signed in.
router.get('/map', (req, res) => {
  res.render('bcit-map', { MAPBOX_TOKEN: process.env.MAPBOX_TOKEN, page: 'map', title: 'Wayfindr – Map', user: req.session.user });
});

// Old standalone URL, kept working for existing bookmarks/links
router.get('/bcit-map', (req, res) => {
  res.redirect('/map');
});

// The hand-entry Node Management page is gone. Navigation nodes are now
// generated from the floor plans themselves by floorPlans/build_nav_graph.py
// (public/data/nav-graph.json), so typing lat/long/connections by hand had
// stopped being a way to improve routing and had become a way to disagree
// with it. /api/nodes still serves the older Firestore node set that the
// outdoor campus paths use.
router.get('/nodes', (req, res) => {
  res.redirect('/map');
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// About page
router.get('/about', (req, res) => {
  res.render('about', { page: 'about', title: 'Wayfindr – About', user: req.session.user });
});

// Schedule page: the classes you have to be at, and when.
router.get('/schedule', checkSession, (req, res) => {
  res.render('schedule', {
    page: 'schedule',
    title: 'Wayfindr - Schedule',
    user: req.session.user,
  });
});

// Favorites Management page
router.get('/favorites', checkSession, (req, res) => {
  res.render('favorites', {
    page: 'favorites',
    title: 'Wayfindr – Favorites Management',
    user: req.session.user
  });
});

// The standalone room-to-room route finder is gone: the map sidebar takes the
// same two rooms, and it can actually draw the answer, so that page's own
// primary button did nothing but send you here. Old links keep working --
// /interior?from=1600&to=1990 is exactly the map's own deep-link shape.
router.get('/interior', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(qs ? `/map?${qs}` : '/map');
});

// Pathfinding submission
router.post("/find-path", handlePathRequest);

// Which stairs and lifts each floor of a building can get to.
//
// A stairwell is traced once, on whichever sheet somebody drew it on, but it
// serves every floor it opens onto -- so the map has to be told which floors
// those are before it can draw them. Answered from the walking network rather
// than from the drawings: a shaft that nothing links to a floor does not open
// onto it, whatever it happens to sit above.
//
// Small and it changes only when the network is rebuilt, so it is cheap to
// ask for per building instead of sending the whole graph to the browser.
router.get("/api/vertical-spaces/:building", (req, res) => {
  const building = String(req.params.building || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(building)) {
    return res.status(400).json({ error: "Not a building code." });
  }
  res.json({ building, floors: verticalSpacesByFloor(building) });
});


// --- Test Logging Route ---
router.get("/test-error", (req, res, next) => {
  const testError = new Error("🔥 Intentional test error for logging system auth");
  testError.statusCode = 500;
  next(testError); // Passes to errorHandler.js
});


// Unknown URLs used to be redirected silently to the home page, which hides
// typos and broken links -- you ask for /favourites, land on the home page,
// and have no idea why. Say what happened, and offer the way on.
router.use((req, res) => {
  res.status(404).render('404', {
    page: '404',
    title: 'Wayfindr - Page Not Found',
    requestedPath: req.originalUrl,
    user: req.session.user,
  });
});


export default router;
