// __tests__/planLibrary.test.js
//
// The floor-plan library, from the outside in: what a dropped file is called,
// what it actually is, and -- the part with real arithmetic in it -- where a
// replaced sheet's picture belongs on the map.
//
// Nothing here writes a file. Replacing a sheet renders a PDF through Python
// and rewrites the live library, which is not something a test run should do
// to somebody's campus; what is worth testing is the reasoning around it.

import { jest } from "@jest/globals";
import { firebaseConfigStub } from "../test-utils/firebaseConfigStub.js";

import {
  parsePlanName,
  stemFor,
  sniffKind,
  pngSize,
  carryPlacement,
  listPlans,
  replacePlan,
  restoreVersion,
} from "../services/planLibrary.js";

jest.unstable_mockModule("../config/firebase.js", firebaseConfigStub);
const { default: app } = await import("../server.js");
const { default: request } = await import("supertest");

const R_EARTH = 6371008.8;
const M_PER_DEG_LAT = (Math.PI / 180) * R_EARTH;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

describe("Naming a dropped sheet", () => {
  test("reads the names BCIT's drawings arrive with", () => {
    for (const name of ["SW1-Floor2.pdf", "SW1_Floor2.pdf", "sw1 floor 2.PDF",
      "SW1-2.pdf", "SW1Floor2.png", "sw1-fl-2.pdf"]) {
      expect(parsePlanName(name)).toMatchObject({
        building: "SW1", floor: "2", stem: "SW1-Floor2",
      });
    }
  });

  test("a leading zero is the same floor, not another one", () => {
    expect(parsePlanName("NE1-Floor04.pdf").stem).toBe("NE1-Floor4");
  });

  test("hands back anything it cannot read rather than guessing", () => {
    for (const name of ["", "scan0001.pdf", "campus map.pdf", "SW1.pdf",
      "Site Plan Rev C.pdf",
      // A building code ends in digits too, so an unannounced number is
      // genuinely ambiguous: SW12 is a building, and could be SW1 floor 2.
      "SW12.pdf"]) {
      expect(parsePlanName(name)).toBeNull();
    }
  });

  test("a sheet name is a building code and a floor number, and nothing else", () => {
    expect(stemFor("SW1", "2")).toBe("SW1-Floor2");
    // these become file paths, so a way out of the folder must not survive
    expect(stemFor("../etc", "1")).toBeNull();
    expect(stemFor("SW1", "../2")).toBeNull();
    expect(stemFor("SW1", "1.5")).toBeNull();
    expect(stemFor("", "")).toBeNull();
  });
});

describe("What a file actually is", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(1200, 0); b.writeUInt32BE(800, 4); return b; })(),
  ]);

  test("a PDF and a PNG are recognised by their first bytes", () => {
    expect(sniffKind(Buffer.from("%PDF-1.7\nsomething something"))).toBe("pdf");
    expect(sniffKind(png)).toBe("png");
  });

  test("a file that is neither is neither, whatever it is called", () => {
    expect(sniffKind(Buffer.from("PK a zip pretending to be a plan"))).toBeNull();
    expect(sniffKind(Buffer.alloc(0))).toBeNull();
    expect(sniffKind("%PDF-1.7")).toBeNull();
  });

  test("a PNG states its own size", () => {
    expect(pngSize(png)).toEqual({ width: 1200, height: 800 });
    expect(pngSize(Buffer.from("%PDF-1.7 and then some"))).toBeNull();
  });
});

describe("Keeping the position a replaced sheet had", () => {
  // 200 px of drawing across 20 m of building: a tenth of a metre per pixel.
  const before = { page: [1000, 1000], crop: [100, 100, 299, 299], width: 200, height: 200, zoom: 3 };
  const placement = { lng: -123.0, lat: 49.25, widthM: 20, rotation: 0 };

  test("a sheet that crops the same way does not move", () => {
    const out = carryPlacement(before, { ...before }, placement);
    expect(out.status).toBe("unchanged");
    expect(out.placement).toEqual(placement);
  });

  test("a crop that shifts right moves the plan east by the same distance", () => {
    const after = { ...before, crop: [110, 100, 309, 299] };
    const out = carryPlacement(before, after, placement);
    expect(out.status).toBe("moved");
    expect(out.movedM).toBeCloseTo(1, 6);
    const eastM = (out.placement.lng - placement.lng) * mPerDegLng(placement.lat);
    expect(eastM).toBeCloseTo(1, 6);
    expect(out.placement.lat).toBeCloseTo(placement.lat, 12);
    expect(out.placement.widthM).toBeCloseTo(20, 9);
  });

  test("page pixels run down and north runs up", () => {
    const after = { ...before, crop: [100, 110, 299, 309] };
    const out = carryPlacement(before, after, placement);
    const northM = (out.placement.lat - placement.lat) * M_PER_DEG_LAT;
    expect(northM).toBeCloseTo(-1, 6);
  });

  test("a turned sheet moves along its own axes, not the map's", () => {
    // Quarter-turned on the map, a crop that slides right on the page slides
    // north on the ground -- which is the whole reason rotation is applied.
    const after = { ...before, crop: [110, 100, 309, 299] };
    const out = carryPlacement(before, after, { ...placement, rotation: 90 });
    const northM = (out.placement.lat - placement.lat) * M_PER_DEG_LAT;
    const eastM = (out.placement.lng - placement.lng) * mPerDegLng(placement.lat);
    expect(northM).toBeCloseTo(1, 6);
    expect(eastM).toBeCloseTo(0, 6);
  });

  test("a wider crop is a wider plan, anchored on the same drawing", () => {
    // 40 px more drawing on the right: 4 m wider, and its middle 2 m east.
    const after = { ...before, crop: [100, 100, 339, 299], width: 240 };
    const out = carryPlacement(before, after, placement);
    expect(out.placement.widthM).toBeCloseTo(24, 6);
    expect((out.placement.lng - placement.lng) * mPerDegLng(placement.lat)).toBeCloseTo(2, 6);
  });

  test("a different page is handed back to a person rather than guessed at", () => {
    const out = carryPlacement(before, { ...before, page: [1400, 1000] }, placement);
    expect(out.status).toBe("page-changed");
    expect(out.placement).toBeUndefined();
  });

  test("a picture that does not say where it sat cannot be placed", () => {
    // What an uploaded PNG looks like, and what every sheet rendered before
    // the renderer started recording its crop looks like.
    const out = carryPlacement({ width: 200, height: 200 }, { width: 220, height: 200 }, placement);
    expect(out.status).toBe("unknown");
    expect(out.placement).toBeUndefined();
  });

  test("a sheet nobody had positioned yet has nothing to carry", () => {
    expect(carryPlacement(before, before, null).status).toBe("none");
  });
});

describe("The library as the page sees it", () => {
  test("lists sheets with what is known about each", () => {
    const plans = listPlans();
    expect(Array.isArray(plans)).toBe(true);
    for (const p of plans.slice(0, 5)) {
      expect(p).toEqual(expect.objectContaining({
        stem: expect.any(String),
        building: expect.any(String),
        floor: expect.any(String),
        traced: expect.any(Number),
        placed: expect.any(Boolean),
      }));
    }
  });

  // Replacing BCIT's drawings is administrators' work, and the page behind
  // this is theirs. Answered as JSON, because the library page reads it with
  // fetch() and cannot do anything with a login page.
  test("the library is not readable without being signed in as an admin", async () => {
    const res = await request(app).get("/admin/api/library");
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
    expect(res.text).not.toContain("<!DOCTYPE");
  });

  test("nor can a sheet be uploaded", async () => {
    const res = await request(app)
      .post("/admin/api/plan/SW1/1")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.7 pretending to be a drawing"));
    expect(res.status).toBe(401);
  });

  // The same routes, reached by somebody who does maintain the map. Mounted
  // with a session of our own rather than signed in for real: what is being
  // checked is that the guard lets an administrator through to the library,
  // not how Firebase issues a cookie.
  test("an administrator is served the library", async () => {
    const { default: express } = await import("express");
    const { default: adminRouter } = await import("../routes/admin.js");

    const asAdmin = express();
    asAdmin.use((req, res, next) => {
      // what a signed-in administrator's session carries: the claim, stamped
      // on at sign-in
      req.session = { user: { uid: "u1", email: "maps@bcit.ca", admin: true } };
      next();
    });
    asAdmin.use("/admin", adminRouter);

    const res = await request(asAdmin).get("/admin/api/library");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.maxBytes).toBeGreaterThan(0);
  });
});

describe("Refusing a bad upload", () => {
  // Straight at the service: every one of these has to be refused before a
  // single byte is written, so a test that reached the writing would be
  // rewriting somebody's campus.
  const pdf = Buffer.from("%PDF-1.7 and then some drawing");

  const refusal = async (opts) => {
    try {
      await replacePlan(opts);
    } catch (err) {
      return err;
    }
    throw new Error("that upload was accepted, and should not have been");
  };

  test("a building code that is really a path", async () => {
    const err = await refusal({ building: "../../etc", floor: "1", bytes: pdf });
    expect(err.status).toBe(400);
  });

  test("a floor that is not a floor", async () => {
    expect((await refusal({ building: "SW1", floor: "1/../2", bytes: pdf })).status).toBe(400);
  });

  test("bytes that are neither a PDF nor a PNG, whatever they are called", async () => {
    const err = await refusal({
      building: "ZZTEST", floor: "1", filename: "SW1-Floor1.pdf",
      bytes: Buffer.from("PK a zip in a pdf's clothing"),
    });
    expect(err.status).toBe(415);
    expect(err.message).toMatch(/PDF drawings, or PNG/i);
  });

  test("an empty upload", async () => {
    expect((await refusal({ building: "ZZTEST", floor: "1", bytes: Buffer.alloc(0) })).status)
      .toBe(400);
  });

  test("restoring something that is not a kept copy", async () => {
    let err;
    try {
      restoreVersion({ building: "SW1", floor: "1", file: "../../../../etc/passwd" });
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(400);
  });
});
