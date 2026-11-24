import { getAuth } from "../config/firebase.js";

/**
 * Does this request want data rather than a page?
 *
 * A request to an /api/ path always does, whatever its headers say. This used
 * to be decided on the Accept header alone, and fetch() sends a wildcard
 * Accept, so an API call without a token was answered with a 302 to the login
 * PAGE: the caller asked for JSON and got a lump of HTML, which fails to parse
 * somewhere far away from the actual problem. The path is the honest signal.
 *
 * "An /api/ path" means any segment, not just the first: the tracer's own API
 * lives under /admin/api/, and matching only the start of the URL sent those
 * calls the login page -- which is the same failure, one directory down.
 */
function wantsJson(req) {
  const url = req.originalUrl || req.path || "";
  return Boolean(req.xhr)
    || /(^|\/)api\//.test(url)
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

    const decodedToken = await getAuth().verifyIdToken(token);

    req.user = decodedToken;
    if (req.session) {
      // Refreshing the session from the token must not demote anybody: an
      // administrator appointed by their Firestore profile carries that on
      // the session and nowhere else, so replacing the whole user outright
      // dropped it on the next authenticated request they made.
      const was = req.session.user?.admin === true;
      req.session.user = { ...decodedToken, admin: was || decodedToken.admin === true };
    }
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

/**
 * The people who maintain the map, as opposed to the people who use it.
 *
 * The tracer and the floor-plan library are not features of the app: they
 * overwrite the campus data every other page reads, replace BCIT's drawings
 * and start the rebuild scripts. A student with an account has no business on
 * either, so being signed in is not the question -- who you are is.
 *
 * There is one place that answers it: an `admin` custom claim on the Firebase
 * account, stamped onto the session when they sign in. One place matters. A
 * second list, in the environment, meant an administrator could be one for a
 * reason the People page could not show, change, or take back -- and the
 * person looking at that page had no way to tell which kind they were dealing
 * with beyond a note saying "set on the server".
 *
 * A claim can only be written with the Admin SDK, so being appointed is always
 * something done TO an account and never by it. Deliberately not a way in: a
 * field on the user's own profile document, which is the one record they may
 * be able to write themselves.
 *
 * The first administrator, on a system that has none, comes from
 * scripts/make-admin.js -- run on the server, by whoever holds its
 * credentials. That script is also the way back if every administrator is
 * removed.
 */
export function isAdmin(user) {
  return user?.admin === true;
}

/**
 * Guard the maintenance pages and their API.
 *
 * A visitor is sent to sign in, because signing in may well be all they are
 * missing. Somebody already signed in is told plainly that this is not for
 * them: bouncing them to a login page they are already past reads as a broken
 * app, and quietly answering 404 makes them hunt for a page that is right
 * there.
 */
export function requireAdmin(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    if (wantsJson(req)) return res.status(401).json({ error: "Sign in First" });
    return res.redirect("/auth/login");
  }
  if (!isAdmin(user)) {
    if (wantsJson(req)) {
      return res.status(403).json({ error: "This Is Only for Map Administrators" });
    }
    return res.status(403).render("no-access", {
      page: "403",
      title: "Wayfindr - Not Your Page",
      user,
    });
  }
  next();
}
