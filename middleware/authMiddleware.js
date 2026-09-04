import admin from "../config/firebase.js";

/**
 * Does this request want data rather than a page?
 *
 * A request to /api/... always does, whatever its headers say. This used to
 * be decided on the Accept header alone, and fetch() sends a wildcard Accept,
 * so an API call without a token was answered with a 302 to the login PAGE:
 * the caller asked for JSON and got a lump of HTML, which fails to parse
 * somewhere far away from the actual problem. The path is the honest signal.
 */
function wantsJson(req) {
  const url = req.originalUrl || req.path || "";
  return Boolean(req.xhr)
    || url.startsWith("/api/")
    || (req.headers?.accept || "").includes("json");
}

export async function verifyFirebaseToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1] || req.session?.userToken;

    if (!token) {
      if (wantsJson(req)) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      // a person opening a page gets sent somewhere they can sign in
      return res.redirect("/auth/login");
    }

    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = decodedToken;
    if (req.session) req.session.user = decodedToken;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Invalid token" });
    }
    res.redirect("/auth/login");
  }
}

// Helper to check session for normal page routes
export function checkSession(req, res, next) {
  if (req.session?.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/auth/login");
}
