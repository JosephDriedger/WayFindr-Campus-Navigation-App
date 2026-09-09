// config/firebase.js
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import dotenv from "dotenv";

dotenv.config();

// In tests, don't require a real service account
if (process.env.NODE_ENV === "test") {
  if (!getApps().length) {
    initializeApp({
      // minimal config so getFirestore() works in tests
      projectId: "demo-test",
    });
  }
} else {
  // Your existing logic, but with a safe guard
  let serviceAccount = null;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "{}";

  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    console.warn(
      "Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:",
      err.message
    );
  }

  if (!serviceAccount || !serviceAccount.project_id) {
    console.warn("FIREBASE_SERVICE_ACCOUNT_KEY missing or invalid in .env");
  } else if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
    });
  }
}

// firebase-admin v13 dropped the old `admin.firestore()` / `admin.auth()`
// namespace in favour of these per-product entry points. They are re-exported
// from here rather than imported from the SDK directly so that reaching for
// Firestore or Auth always goes through the module that ran initializeApp().
export { getFirestore, getAuth, FieldValue };
