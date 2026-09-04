import fs from "fs";
import os from "os";
import path from "path";
import FileSessionStore from "../services/sessionStore.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "wayfindr-sessions-"));

const set = (store, sid, sess) =>
  new Promise((resolve, reject) =>
    store.set(sid, sess, (err) => (err ? reject(err) : resolve())));

const get = (store, sid) =>
  new Promise((resolve, reject) =>
    store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess))));

const destroy = (store, sid) =>
  new Promise((resolve) => store.destroy(sid, resolve));

describe("FileSessionStore", () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = tmpDir();
    store = new FileSessionStore({ dir });
  });

  afterEach(() => {
    clearInterval(store.timer);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads back what it stored", async () => {
    await set(store, "abc123", { user: { uid: "u1", email: "a@b.c" }, cookie: {} });
    expect(await get(store, "abc123")).toMatchObject({ user: { uid: "u1" } });
  });

  // The whole reason this store exists: MemoryStore signed everybody out on
  // every restart, which with nodemon meant every file save.
  it("keeps sessions across a restart", async () => {
    await set(store, "survives", { user: { uid: "u2" }, cookie: {} });
    clearInterval(store.timer);

    const restarted = new FileSessionStore({ dir });
    try {
      expect(await get(restarted, "survives")).toMatchObject({ user: { uid: "u2" } });
    } finally {
      clearInterval(restarted.timer);
    }
  });

  it("returns nothing for a session it does not have", async () => {
    expect(await get(store, "never-seen")).toBeNull();
  });

  it("forgets a destroyed session", async () => {
    await set(store, "goodbye", { user: { uid: "u3" }, cookie: {} });
    await destroy(store, "goodbye");
    expect(await get(store, "goodbye")).toBeNull();
  });

  it("treats an expired session as gone", async () => {
    await set(store, "stale", { user: { uid: "u4" }, cookie: { originalMaxAge: -1000 } });
    expect(await get(store, "stale")).toBeNull();
  });

  // A half-written file should log someone out, not take the request down.
  it("survives a corrupt session file", async () => {
    fs.writeFileSync(path.join(dir, "broken.json"), "{ this is not json");
    expect(await get(store, "broken")).toBeNull();
  });

  // Rolling sessions touch the store on every request. Rewriting the file
  // each time was pointless churn, and on Windows two writes landing together
  // failed the rename outright.
  it("does not rewrite the file on every touch", async () => {
    const throttled = new FileSessionStore({ dir, touchAfterMs: 60_000 });
    try {
      const sess = { user: { uid: "u5" }, cookie: {} };
      await set(throttled, "busy", sess);
      const file = path.join(dir, "busy.json");
      const first = fs.statSync(file).mtimeMs;

      await new Promise((resolve) => throttled.touch("busy", sess, resolve));
      expect(fs.statSync(file).mtimeMs).toBe(first);
      expect(await get(throttled, "busy")).toMatchObject({ user: { uid: "u5" } });
    } finally {
      clearInterval(throttled.timer);
    }
  });

  it("touches once the record is old enough", async () => {
    const eager = new FileSessionStore({ dir, touchAfterMs: 0 });
    try {
      const sess = { user: { uid: "u6" }, cookie: {} };
      await set(eager, "eager", sess);
      eager.lastTouch.set("eager", 0); // as though the last write was long ago
      await new Promise((resolve) => eager.touch("eager", sess, resolve));
      expect(eager.lastTouch.get("eager")).toBeGreaterThan(0);
    } finally {
      clearInterval(eager.timer);
    }
  });

  // A session that cannot be written is not a reason to fail the request --
  // reporting it as one crashed the server mid-response.
  it("reports no error when the file cannot be written", async () => {
    const blocked = new FileSessionStore({ dir: path.join(dir, "nope") });
    try {
      fs.rmSync(path.join(dir, "nope"), { recursive: true, force: true });
      await expect(set(blocked, "doomed", { cookie: {} })).resolves.toBeUndefined();
    } finally {
      clearInterval(blocked.timer);
    }
  });

  // Session ids become file names, so anything odd is refused rather than
  // escaped into a path that could reach outside the directory.
  it("refuses a session id that is not a plain id", async () => {
    expect(await get(store, "../../etc/passwd")).toBeNull();
    await set(store, "../../escape", { user: {}, cookie: {} });
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
