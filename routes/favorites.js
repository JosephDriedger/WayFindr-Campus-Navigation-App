// routes/favorites.js

import express from "express";
// import admin from "../config/firebase.js";
import User from "../models/user.js";
import { verifyFirebaseToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// Middleware to ensure Firestore user doc exists and attach User instance
async function ensureUserDoc(req, res, next) {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    const user = new User(uid);
    // If we have some basic email info from token, pass it
    await user.ensureExists({ email: req.user.email || null, displayName: req.user.name || null });

    req.userModel = user;
    next();
  } catch (err) {
    console.error("ensureUserDoc Error:", err);
    next(err);
  }
}


/**
 * GET /api/favorites
 * Return favorites ordered by lastUsed desc
 */
router.get("/", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    const favorites = await req.userModel.getFavorites();
    res.json({ favorites });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/favorites
 * Body: { nodeId, label?, isKeyLocation?, nodeMeta? }
 */
router.post("/", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    const { nodeId, label, isKeyLocation = false, nodeMeta = {} } = req.body;
    if (!nodeId) return res.status(400).json({ error: "nodeId is required" });

    await req.userModel.addFavorite(nodeId, { label, isKeyLocation, nodeMeta });
  
    const fav = await req.userModel.getFavorite(nodeId);

    res.status(201).json({ favorite: fav });

  } catch (err) {
    console.error("Error in POST /api/favorites:", err);
    next(err);
  }
});



/**
 * PATCH /api/favorites/:nodeId/use
 * Mark as used (updates lastUsed)
 */
router.patch("/:nodeId/use", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    const { nodeId } = req.params;
    await req.userModel.markFavoriteUsed(nodeId);
    const fav = await req.userModel.getFavorite(nodeId);
    res.json({ favorite: fav });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/favorites/:nodeId
 */
router.delete("/:nodeId", verifyFirebaseToken, ensureUserDoc, async (req, res, next) => {
  try {
    const { nodeId } = req.params;
    await req.userModel.removeFavorite(nodeId);
    res.json({ message: "Favorite Removed", nodeId });
  } catch (err) {
    next(err);
  }
});

export default router;
