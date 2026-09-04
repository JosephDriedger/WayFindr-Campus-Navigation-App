import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import session from "express-session";

import route from "./routes/route.js";
import nodeRoutes from "./routes/nodes.js";
import authRouter from './routes/auth.js';
import favoritesRouter from "./routes/favorites.js";
import scheduleRouter from "./routes/schedule.js";
import adminRouter from "./routes/admin.js";
import calibratorRouter from "./routes/calibrator.js";

import FileSessionStore from "./services/sessionStore.js";
import { requestLogger } from "./middleware/logger.js";
import { errorHandler } from './middleware/errorHandler.js';
import admin from './config/firebase.js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = admin.firestore();

// The traced network is one document and it grows: a few hundred nodes and
// the links between them is already past express.json()'s 100kb default, and
// every save was being refused with 413 once it crossed that line -- which
// read, in the tracer, as a mysterious cap on how many nodes could be added.
// There is no reason for a limit anywhere near the size of the thing being
// saved, so it is set well clear of it.
app.use(express.json({ limit: "50mb" }));
app.use(requestLogger);

const mapboxDistDir = path.dirname(require.resolve("mapbox-gl/dist/mapbox-gl.js"));

app.use(
  "/vendor/mapbox-gl",
  express.static(mapboxDistDir, {
    maxAge: "7d",
    immutable: true,
  })
);

app.use(express.static(path.join(__dirname, "public")));
// Static files are served before sessions are touched. With rolling sessions
// every request re-writes the session file, and a page pulling in a dozen
// assets meant a dozen pointless writes racing each other -- on Windows that
// surfaced as EPERM when two renames landed on the same file at once.
// Sessions survive a restart. The default MemoryStore holds them in the
// process, so every restart signed everybody out -- and nodemon restarts on
// every file save, which is why staying logged in was impossible while
// working on the app.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 5; // 5 days
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  // so secure cookies work behind a TLS-terminating proxy
  app.set("trust proxy", 1);
}

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[session] SESSION_SECRET is not set; using a default. Set one before deploying."
  );
}

app.use(session({
  name: "wayfindr.sid",
  secret: process.env.SESSION_SECRET || "keyboard cat",
  resave: false,
  saveUninitialized: false,
  rolling: true, // an active user should not be signed out mid-session
  store: new FileSessionStore({
    dir: path.join(__dirname, ".sessions"),
    ttlMs: SESSION_TTL_MS,
  }),
  cookie: {
    httpOnly: true,
    // A secure cookie is dropped outright over plain http, so hard-coding it
    // meant the browser silently kept nothing on localhost.
    secure: isProduction,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  },
}));

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));

app.use("/calibrator", calibratorRouter);
app.use('/auth', authRouter);
app.use("/api/nodes", nodeRoutes(db));
app.use("/api/favorites", favoritesRouter);
app.use("/api/schedule", scheduleRouter);
app.use("/admin", adminRouter);
app.use('/', route);

app.use(errorHandler);

const morgan = require('morgan');
app.use(morgan(':method :url :status :response-time ms - :date[iso]'));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} @ ${new Date().toISOString()}`);
  next();
});

// Only start the server if not running inside Jest
if (process.env.JEST_WORKER_ID === undefined) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
