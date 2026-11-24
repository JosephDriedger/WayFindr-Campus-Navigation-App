// __tests__/routes.test.js
import request from "supertest";
import { jest } from "@jest/globals";
import { firebaseConfigStub } from "../test-utils/firebaseConfigStub.js";

// These routes are the public ones -- they never reach Firestore or Auth --
// so the app boots against a stubbed Firebase config. See the stub for why
// loading the real one breaks under Jest.
jest.unstable_mockModule("../config/firebase.js", firebaseConfigStub);

const { default: app } = await import("../server.js");

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

  // The tracer and the plan library maintain the map: they overwrite the
  // campus data every other page reads. They are for administrators, and a
  // visitor is sent to sign in rather than shown either.
  test("GET /admin sends a signed-out visitor to the login page", async () => {
    const res = await request(app).get("/admin");
    expect(res.status).toBe(302);
    expect(res.header.location).toBe("/auth/login");
  });

  test("every admin page sends a signed-out visitor to the login page", async () => {
    for (const url of ["/admin/tracer", "/admin/plans", "/admin/users"]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(302);
      expect(res.header.location).toBe("/auth/login");
    }
  });

  test("the accounts cannot be read, let alone changed, without signing in", async () => {
    const read = await request(app).get("/admin/api/users");
    expect(read.status).toBe(401);

    const write = await request(app)
      .post("/admin/api/users/somebody/admin")
      .send({ admin: true });
    expect(write.status).toBe(401);
  });

  // fetch() sends a wildcard Accept, so answering these with the login PAGE
  // is what made the tracer fail on "Unexpected token '<'".
  test("GET /admin/api/plans answers with JSON rather than the login page", async () => {
    const res = await request(app).get("/admin/api/plans");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Sign in First" });
  });

  test("the menu offers no maintenance links to someone who is not an admin", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('href="/admin"');
    expect(res.text).not.toContain('href="/admin/plans"');
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
