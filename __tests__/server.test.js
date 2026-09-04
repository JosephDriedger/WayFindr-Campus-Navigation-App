// __tests__/server.test.js
import request from "supertest";
import app from "../server.js";

describe("SERVER.JS – Core Express Setup", () => {
  test("App instance exists", () => {
    expect(app).toBeDefined();
  });

  test("Session middleware is installed", () => {
    const middlewares = app._router.stack
      .filter(r => r.name === "session" || r.handle.name === "session");
    expect(middlewares.length).toBeGreaterThan(0);
  });
});

describe("Public routes", () => {
  test("GET / returns 200 and HTML content", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<!DOCTYPE");
  });

  test("GET /about returns 200 and contains 'about'", async () => {
    const res = await request(app).get("/about");
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toContain("about");
  });

  test("GET /health returns JSON status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("Protected routes (check session redirect)", () => {
  // Only what is saved against a profile needs an account; the map itself is
  // public, so a visitor can find a room without signing up.
  const protectedRoutes = ["/favorites", "/schedule"];

  protectedRoutes.forEach(route => {
    test(`GET ${route} redirects when session missing`, async () => {
      const res = await request(app).get(route);
      expect(res.status).toBe(302);
    });
  });

  test("GET /map is reachable without a session", async () => {
    const res = await request(app).get("/map");
    expect(res.status).toBe(200);
  });
});

describe("Unknown routes", () => {
  // These used to redirect silently to "/", which hid typos and dead links.
  test("GET /some/random/path returns a 404 page naming the path", async () => {
    const res = await request(app).get("/some/random/path");
    expect(res.status).toBe(404);
    expect(res.text).toContain("/some/random/path");
  });
});
