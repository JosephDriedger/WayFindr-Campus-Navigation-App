// __tests__/authMiddleware.test.js
import { jest } from "@jest/globals";

// 1️⃣ Mock Firebase BEFORE importing middleware
const mockVerifyIdToken = jest.fn();
await jest.unstable_mockModule("../config/firebase.js", () => ({
  getAuth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));

// 2️⃣ Import the middleware AFTER mocking
const middleware = await import("../middleware/authMiddleware.js");

describe("Auth Middleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: { accept: "application/json" }, session: {}, xhr: false };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      redirect: jest.fn(),
    };
    next = jest.fn();
    mockVerifyIdToken.mockReset();
  });

  test("calls next() when valid token provided", async () => {
    req.headers.authorization = "Bearer valid-token";
    mockVerifyIdToken.mockResolvedValue({ uid: "123", email: "test@test.com" });

    await middleware.verifyFirebaseToken(req, res, next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith("valid-token");
    expect(req.user).toEqual({ uid: "123", email: "test@test.com" });
    expect(next).toHaveBeenCalled();
  });

  test("returns 401 JSON when no token on API request", async () => {
    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated" });
  });

  test("redirects to login when no token on page request", async () => {
    req.headers.accept = "text/html";
    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith("/auth/login");
  });

  test("returns 401 JSON on invalid token for API request", async () => {
    req.headers.authorization = "Bearer invalid-token";
    mockVerifyIdToken.mockRejectedValue(new Error("Invalid token"));

    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid token" });
  });

  test("redirects to login on invalid token for page request", async () => {
    req.headers.authorization = "Bearer invalid-token";
    req.headers.accept = "text/html";
    mockVerifyIdToken.mockRejectedValue(new Error("Invalid token"));

    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith("/auth/login");
  });

  // checkSession tests
  // fetch() sends "*/*" unless told otherwise, so an API call was being
  // answered with a redirect to an HTML login page and the caller got a lump
  // of markup where it expected JSON.
  test("answers an /api/ call with JSON even when it asks for anything", async () => {
    req.headers.accept = "*/*";
    req.originalUrl = "/api/favorites";
    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Not authenticated" });
  });

  test("still sends a person opening a page to the login screen", async () => {
    req.headers.accept = "text/html";
    req.originalUrl = "/favorites";
    await middleware.verifyFirebaseToken(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith("/auth/login");
  });

  test("checkSession answers an /api/ call with JSON", () => {
    req.headers.accept = "*/*";
    req.originalUrl = "/api/schedule";
    req.session = {};
    middleware.checkSession(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test("checkSession calls next() when session user exists", () => {
    req.session.user = { uid: "123" };
    middleware.checkSession(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test("checkSession returns 401 JSON for API request when session missing", () => {
    req.headers.accept = "application/json";
    middleware.checkSession(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  test("checkSession redirects to login for page request when session missing", () => {
    req.headers.accept = "text/html";
    middleware.checkSession(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith("/auth/login");
  });
});

// The maintenance pages -- the tracer and the floor-plan library -- rewrite
// the campus data every other page reads. Being signed in is not the
// question; who you are is, and there is one place that answers it: the
// `admin` custom claim, carried on the session from sign-in.
describe("Who maintains the map", () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: { accept: "text/html" }, session: {}, xhr: false };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      redirect: jest.fn(),
      render: jest.fn(),
    };
    next = jest.fn();
  });

  test("the claim is the whole answer", () => {
    expect(middleware.isAdmin({ uid: "1", email: "maps@bcit.ca", admin: true })).toBe(true);
    expect(middleware.isAdmin({ uid: "2", email: "maps@bcit.ca", admin: false })).toBe(false);
    expect(middleware.isAdmin({ uid: "3", email: "student@my.bcit.ca" })).toBe(false);
    expect(middleware.isAdmin({ uid: "4" })).toBe(false);
    expect(middleware.isAdmin(null)).toBe(false);
  });

  // An address cannot make somebody an administrator, however it is spelled or
  // wherever it appears: there is no list of addresses any more.
  test("an address is not a way in", () => {
    process.env.ADMIN_EMAILS = "maps@bcit.ca";
    expect(middleware.isAdmin({ email: "maps@bcit.ca" })).toBe(false);
    delete process.env.ADMIN_EMAILS;
  });

  test("a visitor is sent to sign in, because that may be all they are missing", () => {
    middleware.requireAdmin(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith("/auth/login");
    expect(next).not.toHaveBeenCalled();
  });

  test("someone already signed in is told plainly, not bounced to a login page", () => {
    req.session.user = { email: "student@my.bcit.ca" };
    middleware.requireAdmin(req, res, next);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.render).toHaveBeenCalledWith("no-access", expect.any(Object));
    expect(next).not.toHaveBeenCalled();
  });

  test("an /admin/api call is refused with JSON, whatever it asks for", () => {
    req.headers.accept = "*/*";
    req.originalUrl = "/admin/api/library";
    req.session.user = { email: "student@my.bcit.ca" };
    middleware.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "This Is Only for Map Administrators",
    });
  });

  test("an admin is let through", () => {
    req.session.user = { uid: "1", email: "maps@bcit.ca", admin: true };
    middleware.requireAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test("refreshing a session from a token does not demote an administrator", async () => {
    req.session.user = { uid: "9", email: "someone@bcit.ca", admin: true };
    req.headers.authorization = "Bearer valid-token";
    mockVerifyIdToken.mockResolvedValue({ uid: "9", email: "someone@bcit.ca" });

    await middleware.verifyFirebaseToken(req, res, next);

    expect(middleware.isAdmin(req.session.user)).toBe(true);
  });
});
