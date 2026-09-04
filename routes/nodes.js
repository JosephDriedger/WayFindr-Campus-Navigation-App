// routes/nodes.js

import express from "express";
// import admin from "firebase-admin";

export default function nodeRoutes(db) {
  const router = express.Router();

// GET /api/nodes → fetch all nodes from Firestore
router.get("/", async (req, res) => {
  try {
    const snapshot = await db.collection("nodes").get();

    const nodes = snapshot.docs.map(doc => ({
      id: doc.id,    // Use Firestore doc ID
      ...doc.data()
    }));

    console.log(nodes);

    res.json(nodes);
  } catch (err) {
    console.error("Error fetching nodes:", err);
    res.status(500).json({ error: "Failed to Load Nodes" });
  }
});

  // POST: Add a new node
  router.post("/", async (req, res) => {
    const { long, lat, alt, connections } = req.body;
    const docRef = await db.collection("nodes").add({ long, lat, alt, connections });
    const newDoc = await docRef.get();
    res.status(201).json({ id: newDoc.id, ...newDoc.data() });
  });

  
  router.get("/data", async (req, res) => {
  try {
    const snapshot = await db.collection("nodes").get();
    const nodes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(nodes);
  } catch (err) {
    console.error("Error loading nodes:", err);
    res.status(500).json({ error: "Failed to Load Nodes." });
  }
});

  return router;
}
