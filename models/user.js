// models/user.js
import admin from "../config/firebase.js";

export default class User {
  constructor(uid) {
    if (!uid) throw new Error("UID is required to create a User instance");
    this.uid = uid;
    this.userRef = admin.firestore().collection("users").doc(uid);
    this.favoritesRef = this.userRef.collection("favorites");
    this.scheduleRef = this.userRef.collection("schedule");
  }

  // Ensure the user document exists (create minimal profile if missing)
  async ensureExists(profile = {}) {
    const doc = await this.userRef.get();
    if (!doc.exists) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      await this.userRef.set({
        uid: this.uid,
        email: profile.email || null,
        displayName: profile.displayName || null,
        createdAt: now,
        ...profile,
      }, { merge: true });
    }
  }

  // -------------------
  // Favorites Methods
  // -------------------

  // Return favorites with their ID included
  async getFavorites(limit = 100) {
    const snapshot = await this.favoritesRef
      .orderBy("lastUsed", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  // Add or update a favorite. Uses nodeId as the favorite doc ID for easy lookup.
  async addFavorite(nodeId, { label = null, isKeyLocation = false, nodeMeta = {} } = {}) {
    if (!nodeId) throw new Error("nodeId is required");
    const now = admin.firestore.FieldValue.serverTimestamp();
    const favRef = this.favoritesRef.doc(nodeId);
    await favRef.set({
      nodeId,
      label,
      isKeyLocation,
      nodeMeta,      // optional snapshot or small metadata
      addedAt: now,
      lastUsed: now
    }, { merge: true });
    return { nodeId, addedAt: now, lastUsed: now };
  }

  // Update lastUsed when user uses the favorite
  async markFavoriteUsed(nodeId) {
    if (!nodeId) throw new Error("nodeId is required");
    const now = admin.firestore.FieldValue.serverTimestamp();
    const favRef = this.favoritesRef.doc(nodeId);
    await favRef.update({ lastUsed: now });
    return { nodeId, lastUsed: now };
  }

  // Remove favorite
  async removeFavorite(nodeId) {
    if (!nodeId) throw new Error("nodeId is required");
    await this.favoritesRef.doc(nodeId).delete();
    return { nodeId };
  }

  // Get a single favorite doc
  async getFavorite(nodeId) {
    const doc = await this.favoritesRef.doc(nodeId).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  }

  // -------------------
  // Schedule Methods
  // -------------------
  //
  // A class is a room plus when you have to be in it: one entry covers the
  // days of the week it repeats on, so "MATH 1441, SW3-1600, Mon/Wed/Fri
  // 09:30-10:20" is a single document rather than three. Times are stored as
  // "HH:MM" local strings and days as 0-6 (Sunday=0, matching JS getDay), so
  // deciding what is on now is plain comparison with no timezone conversion --
  // a campus timetable is only ever read in the campus's own local time.

  async getSchedule() {
    const snapshot = await this.scheduleRef.get();
    const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    // sort in the app rather than the query: ordering by day then time needs
    // a composite index, and a personal timetable is a handful of rows
    entries.sort((a, b) => {
      const dayA = Math.min(...(a.days?.length ? a.days : [7]));
      const dayB = Math.min(...(b.days?.length ? b.days : [7]));
      return dayA - dayB || String(a.startTime).localeCompare(String(b.startTime));
    });
    return entries;
  }

  async addClass({ title, building, room, floor = null, days = [], startTime, endTime }) {
    if (!title) throw new Error("title is required");
    if (!building || !room) throw new Error("building and room are required");
    if (!Array.isArray(days) || !days.length) throw new Error("at least one day is required");
    if (!startTime || !endTime) throw new Error("startTime and endTime are required");
    if (endTime <= startTime) throw new Error("endTime must be after startTime");

    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = this.scheduleRef.doc();
    const entry = {
      title,
      building: String(building).toUpperCase(),
      room: String(room),
      floor: floor ? String(floor) : null,
      days: [...new Set(days.map(Number))].filter((d) => d >= 0 && d <= 6).sort(),
      startTime,
      endTime,
      createdAt: now,
    };
    await ref.set(entry);
    return { id: ref.id, ...entry };
  }

  async removeClass(classId) {
    if (!classId) throw new Error("classId is required");
    await this.scheduleRef.doc(classId).delete();
    return { classId };
  }

  // Optional: set profile (merge)
  async setProfile(profileData) {
    await this.userRef.set(profileData, { merge: true });
    return profileData;
  }

  async getProfile() {
    const doc = await this.userRef.get();
    return doc.exists ? doc.data() : null;
  }
}