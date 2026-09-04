// __tests__/authMiddleware.test.js
import { jest } from "@jest/globals";

// 1️⃣ Mock Firebase BEFORE importing middleware
const mockVerifyIdToken = jest.fn();
await jest.unstable_mockModule("../config/firebase.js", () => ({
  default: {
    auth: () => ({
      verifyIdToken: mockVerifyIdToken,
    }),
  },
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
