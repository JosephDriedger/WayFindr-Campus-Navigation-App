import request from "supertest";
import { jest } from "@jest/globals";
import { firebaseConfigStub } from "../test-utils/firebaseConfigStub.js";

// These routes are the public ones -- they never reach Firestore or Auth --
// so the app boots against a stubbed Firebase config. See the stub for why
// loading the real one breaks under Jest.
jest.unstable_mockModule("../config/firebase.js", firebaseConfigStub);

const { default: app } = await import("../server.js");

describe("Map page performance", () => {
  const MAX_HOME_TIME = 300; // ms
  const MAX_MAP_TIME = 400;  // ms including redirect

  test("GET / (home) responds quickly", async () => {
    const start = performance.now();

    const res = await request(app).get("/");

    const end = performance.now();
    const elapsed = end - start;

    // Home should render OK
    expect(res.statusCode).toBe(200);
    // Backend render time budget
    expect(elapsed).toBeLessThan(MAX_HOME_TIME);
  });

  test("GET /map (unauthenticated) responds quickly", async () => {
    const start = performance.now();

    const res = await request(app).get("/map");

    const end = performance.now();
    const elapsed = end - start;

    // For unauthenticated users your code redirects (302), which is fine
    expect([200, 302]).toContain(res.statusCode);

    // We only care that backend responds fast, not whether it's redirecting
    expect(elapsed).toBeLessThan(MAX_MAP_TIME);
  });
});
