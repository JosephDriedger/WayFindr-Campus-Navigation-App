// routes/schedule.js
//
// A student's timetable, stored against their profile the same way favourites
// are. The point of holding it here rather than in the browser is that it is
// what lets the map answer "where do I have to be right now" -- the schedule
// turns a room number you would otherwise have to remember into the one the
// app offers to navigate to at the time you need it.

import express from "express";
import User from "../models/user.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = express.Router();

async function ensureUserDoc(req, res, next) {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const user = new User(uid);
    await user.ensureExists({
      email: req.user.email || null,
      displayName: req.user.name || null,
    });
    req.userModel = user;
    next();
  } catch (err) {
    console.error("ensureUserDoc error:", err);
    next(err);
  }
}

/** GET /api/schedule -> { schedule: [...] } */
router.get("/", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    res.json({ schedule: await req.userModel.getSchedule() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/schedule
 * Body: { title, building, room, floor?, days: [0-6], startTime, endTime }
 */
router.post("/", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    const entry = await req.userModel.addClass(req.body || {});
    res.status(201).json({ class: entry });
  } catch (err) {
    // the model's validation messages are written for a person to read, so
    // pass them through as a 400 rather than turning them into a 500
    if (err instanceof Error && /required|must be/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/** DELETE /api/schedule/:classId */
router.delete("/:classId", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    await req.userModel.removeClass(req.params.classId);
    res.json({ message: "Class Removed", classId: req.params.classId });
  } catch (err) {
    next(err);
  }
});

export default router;
