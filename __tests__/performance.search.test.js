import request from "supertest";
import app from "../server.js";

// Search runs in the browser over public/data/room-search-index.json, so what
// the server has to be fast at is serving that index. This used to request
// "/search", which is not a route -- it was only ever measuring how quickly the
// catch-all redirect fired, which said nothing about search at all.
describe("Search performance", () => {
  const SEARCH_INDEX = "/data/room-search-index.json";
  const MAX_SINGLE_SEARCH = 250; // ms
  const MAX_BATCH_SEARCH  = 1500; // ms for 10 parallel requests

  test("Single search responds quickly", async () => {
    const start = performance.now();

    const res = await request(app).get(SEARCH_INDEX);

    const end = performance.now();
    const elapsed = end - start;

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.text).rooms)).toBe(true);

    expect(elapsed).toBeLessThan(MAX_SINGLE_SEARCH);
  });

  test("Concurrent searches stay performant", async () => {
    const requests = Array.from({ length: 10 }, () =>
      request(app).get(SEARCH_INDEX)
    );

    const start = performance.now();
    const results = await Promise.all(requests);
    const end = performance.now();
    const elapsed = end - start;

    // All should be quick-ish even when stacked
    expect(elapsed).toBeLessThan(MAX_BATCH_SEARCH);

    results.forEach((res) => {
      expect(res.statusCode).toBe(200);
    });
  });
});
