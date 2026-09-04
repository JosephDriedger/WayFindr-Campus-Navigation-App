// services/sessionStore.js
//
// A session store that survives a restart.
//
// express-session's default MemoryStore keeps sessions in the process, so
// every restart signs everybody out -- and with nodemon watching the files,
// that is every time a line of code is saved. It also warns that it leaks
// memory and is not meant for production.
//
// One small JSON file per session is enough here: this is a campus app with a
// handful of concurrent users, the data is a uid and an email, and a file per
// session means no extra service to run and nothing new to install.

import fs from "fs";
import path from "path";
import session from "express-session";

const Store = session.Store;

// Ids come from express-session, but they end up as file names, so anything
// that is not a plain id is refused rather than escaped.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Windows refuses a rename onto a file another handle still has open, which
// under concurrent requests is a matter of milliseconds rather than a real
// failure. Backing off and trying again clears it.
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);

function renameWithRetry(from, to, cb, attempts = 5, delayMs = 20) {
  fs.rename(from, to, (err) => {
    if (!err || !LOCKED.has(err.code) || attempts <= 1) return cb(err || null);
    setTimeout(() => renameWithRetry(from, to, cb, attempts - 1, delayMs * 2), delayMs);
  });
}

export default class FileSessionStore extends Store {
  constructor({
    dir,
    ttlMs = 1000 * 60 * 60 * 24 * 5,
    sweepMs = 1000 * 60 * 60,
    touchAfterMs = 1000 * 60 * 10,
  } = {}) {
    super();
    this.dir = dir;
    this.ttlMs = ttlMs;
    // Rolling sessions ask the store to touch the record on every request.
    // Rewriting the file each time is pure churn, so a touch that changed
    // nothing is skipped unless the record is old enough to be worth
    // extending.
    this.touchAfterMs = touchAfterMs;
    this.lastTouch = new Map();
    fs.mkdirSync(this.dir, { recursive: true });

    // Expired files would otherwise pile up forever. unref so a pending sweep
    // never holds the process open.
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  fileFor(sid) {
    return SAFE_ID.test(sid) ? path.join(this.dir, `${sid}.json`) : null;
  }

  get(sid, cb) {
    const file = this.fileFor(sid);
    if (!file) return cb(null, null);
    fs.readFile(file, "utf-8", (err, raw) => {
      if (err) return cb(null, null); // no session is not an error
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        // a truncated write should log the user out, not crash the request
        return cb(null, null);
      }
      if (record.expires && Date.now() > record.expires) {
        fs.unlink(file, () => cb(null, null));
        return;
      }
      cb(null, record.session);
    });
  }

  set(sid, sess, cb = () => {}) {
    const file = this.fileFor(sid);
    if (!file) return cb(null);
    const maxAge = sess.cookie?.originalMaxAge ?? this.ttlMs;
    const record = { expires: Date.now() + maxAge, session: sess };
    // write then rename, so a crash mid-write cannot leave a half-written
    // session that reads as corrupt on the next request. The temp name
    // includes a counter as well as the pid: two concurrent writes for the
    // same session would otherwise share a temp file and rename it twice.
    const tmp = `${file}.${process.pid}.${(this.seq = (this.seq || 0) + 1)}.tmp`;
    fs.writeFile(tmp, JSON.stringify(record), (err) => {
      if (err) {
        // same reasoning as the rename below: losing a session write is worth
        // a warning, not a failed request
        console.warn(`[session] could not write ${sid}: ${err.code || err.message}`);
        return cb(null);
      }
      this.lastTouch.set(sid, Date.now());
      renameWithRetry(tmp, file, (renameErr) => {
        // A failed session write is not worth failing the request over: the
        // user keeps the session they already have. Windows in particular
        // refuses a rename while another handle is open on the target, and
        // reporting that as a request error crashed the server mid-response.
        if (renameErr) {
          fs.unlink(tmp, () => {});
          console.warn(`[session] could not save ${sid}: ${renameErr.code || renameErr.message}`);
        }
        cb(null);
      });
    });
  }

  touch(sid, sess, cb = () => {}) {
    const last = this.lastTouch.get(sid) || 0;
    if (Date.now() - last < this.touchAfterMs) return cb(null);
    this.set(sid, sess, cb);
  }

  destroy(sid, cb = () => {}) {
    const file = this.fileFor(sid);
    this.lastTouch.delete(sid);
    if (!file) return cb(null);
    fs.unlink(file, () => cb(null));
  }

  sweep() {
    fs.readdir(this.dir, (err, files) => {
      if (err) return;
      for (const name of files) {
        const file = path.join(this.dir, name);
        // A crash between the write and the rename leaves a temp file behind
        // with nothing to claim it.
        if (name.endsWith(".tmp")) {
          fs.stat(file, (statErr, st) => {
            if (statErr) return;
            if (Date.now() - st.mtimeMs > 60_000) fs.unlink(file, () => {});
          });
          continue;
        }
        if (!name.endsWith(".json")) continue;
        fs.readFile(file, "utf-8", (readErr, raw) => {
          if (readErr) return;
          try {
            const record = JSON.parse(raw);
            if (record.expires && Date.now() > record.expires) fs.unlink(file, () => {});
          } catch {
            fs.unlink(file, () => {}); // unreadable, so of no use to anyone
          }
        });
      }
    });
  }
}
