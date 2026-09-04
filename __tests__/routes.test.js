// __tests__/routes.test.js
import request from "supertest";
import app from "../server.js";

describe("Public routes", () => {
  test("GET / should render index page", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<!DOCTYPE"); // EJS-rendered HTML
  });

  test("GET /about should render About page", async () => {
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

describe("Access", () => {
  // Finding a room is the point of the app and needs no account; only the
  // things saved against a profile do.
  test("GET /map is public", async () => {
    const res = await request(app).get("/map");
    expect(res.status).toBe(200);
  });

  test("GET /bcit-map redirects to /map", async () => {
    const res = await request(app).get("/bcit-map");
    expect(res.status).toBe(302);
    expect(res.header.location).toBe("/map");
  });

  test("GET /favorites redirects when session missing", async () => {
    const res = await request(app).get("/favorites");
    expect(res.status).toBe(302);
  });

  test("GET /schedule redirects when session missing", async () => {
    const res = await request(app).get("/schedule");
    expect(res.status).toBe(302);
  });

  // The tracer is open while the campus is being traced, so its API answers
  // with data rather than the login page -- which the page could not read.
  test("GET /admin is reachable without a session", async () => {
    const res = await request(app).get("/admin");
    expect(res.status).toBe(200);
  });

  test("GET /admin/api/plans returns JSON, not the login page", async () => {
    const res = await request(app).get("/admin/api/plans");
    expect(res.status).toBe(200);
    expect(Array.isArray(JSON.parse(res.text).plans)).toBe(true);
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
