# 1. Overview

This repository contains Wayfindr, a campus navigation web application developed for COMP7082 Group 9.  
The system uses Node.js, Express, Firebase Authentication, Firestore, and Mapbox GL JS to provide secure login, map interaction, node graph retrieval, and user-saved favorites.

# 2. Prerequisites

## 2.1 Required Software

### Git
Download: https://git-scm.com/download/win  
Recommended installation options:
- Select Visual Studio Code as your editor  
- Select "Git from command line and 3rd-party software"

### Node.js + npm
Download LTS: https://nodejs.org

Verify installation:
```bash
node -v
npm -v
```

# 3. Environment Setup

## 3.1 Create Environment File
```bash
cp .env.example .env
```

## 3.2 Configure Required Variables
Add the following in `.env`:

```
FIREBASE_SERVICE_ACCOUNT_KEY='{"type": "service_account", ... }'
FIREBASE_API_KEY=your_web_api_key
FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_PROJECT_ID=your_project_id
MAPBOX_TOKEN=your_mapbox_access_token
SESSION_SECRET=your_session_secret
```

There is no setting for who administers the map. That is stored on the
Firebase account itself, as an `admin` custom claim, and managed from the
**People** page inside the app (see §11).

Note what is *not* a way in: a role field on the user's own Firestore
document. Nearly every account is an ordinary user, and a profile is the one
record a user may be able to write themselves — so a role read from there
would be a promotion anyone could grant themselves, depending entirely on
your Firestore rules. A custom claim can only be written with the Admin SDK,
which means by this server.

# 4. Firebase Setup

## 4.1 Enable Firebase Services
1. Open Firebase Console  
2. Create or select your project  
3. Enable:
   - Authentication → Email/Password  
   - Firestore Database  

## 4.2 Generate Admin SDK Credentials
1. Go to Project Settings → Service Accounts  
2. Click "Generate new private key"  
3. Copy the JSON output  
4. Paste it into FIREBASE_SERVICE_ACCOUNT_KEY inside `.env`

# 5. Install Dependencies

```bash
npm install
```

This project uses:
- express
- firebase-admin
- express-session
- dotenv
- winston
- morgan
- chalk
- Mapbox GL JS

# 6. Run the Server

```bash
npm start
```

Visit:  
http://localhost:5000

# 7. Project Structure

```
/project-root
│
├── /__tests__/           # Unit Tests
├── /config/              # firebase asset
├── /public/              # Frontend assets
├── /views/               # EJS templates
├── /routes/              # API and auth routes
├── /middleware/          # Auth + logging middleware
├── /controllers/         # Node logic
├── /floorPlans/          # Indoor logic
├── /models/              # class object
├── /logs/                # Winston log output
├── server.js             # Main server
└── .env                  # Environment variables
```

# 8. Authentication & Sessions

Wayfindr uses:
- Firebase Web SDK (client)
- Firebase Admin SDK (server)
- express-session

## 8.1 Login and Signup Pages
- /auth/login  
- /auth/signup  

## 8.2 Session Flow
1. Client signs in with Firebase Auth  
2. Client sends ID token to backend: /auth/sessionLogin  
3. Server verifies token and creates a secure session cookie  
4. Protected routes require session

### Example Protected Route:
```js
import { checkSession } from "./middleware/authMiddleware.js";

app.get("/map", checkSession, (req, res) => {
  res.render("map", { user: req.session.user });
});
```

# 9. API Routes

## 9.1 Nodes API

| Method | Route        | Description          |
|--------|--------------|----------------------|
| GET    | /api/nodes   | Fetch all nodes      |
| POST   | /api/nodes   | Create/update nodes  |

### Example Node:
```json
{
  "id": "node1",
  "long": -97.123,
  "lat": 49.123,
  "alt": 3,
  "connections": ["node2", "node5"]
}
```

## 9.2 Favorites API  
Stored in Firestore at: users/{uid}/favorites/{nodeId}

| Method | Route                        | Description                    |
|--------|------------------------------|--------------------------------|
| GET    | /api/favorites               | List all favorites             |
| POST   | /api/favorites               | Add/update a favorite          |
| PATCH  | /api/favorites/:nodeId/use   | Mark favorite as recently used |
| DELETE | /api/favorites/:nodeId       | Remove a favorite              |

### Example Favorite:
```json
{
  "nodeId": "abc123",
  "label": "My Entrance",
  "isKeyLocation": true,
  "nodeMeta": {},
  "addedAt": "...",
  "lastUsed": "..."
}
```

# 10. Logging

The application uses:
- Winston (log files in /logs/)
- Morgan (HTTP request logs)
- Chalk (console formatting)

Logs include:
- server start messages
- authentication events
- Firestore errors
- request timing and status codes

# 11. The Admin Area

Everything that changes the map itself lives under `/admin`, behind the
**Admin** menu, and is visible only to administrators:

| Page | What it is for |
| --- | --- |
| `/admin` | Dashboard: what the map currently consists of, and the way into each tool |
| `/admin/tracer` | Draw the rooms of a floor over its drawing, and run the walking paths |
| `/admin/plans` | The drawings themselves — add or replace a sheet (see §12) |
| `/admin/users` | Who has an account, and which of them maintain the map |

## 11.1 Appointing an Administrator

On **People**, any administrator can make another one, or stand another one
down. The change is written as an `admin` custom claim on that Firebase
account — there is no second list anywhere — their refresh tokens are
revoked, and their sessions are ended, so it takes effect from their next
sign-in rather than whenever they happen to log out. Removing access signs
that person out everywhere immediately.

One row has no button: your own. Nobody can stand themselves down, because
that is how a campus ends up with no administrators at all.

## 11.2 The First Administrator

On a new deployment nobody is an administrator, so nobody can reach the
People page to appoint one. That first one is made on the server, by whoever
holds its credentials:

```bash
npm run make-admin -- someone@bcit.ca
```

```bash
npm run make-admin -- --list
```

`--remove` takes it away again. The account has to have signed in at least
once before it can be appointed — it has to exist to be given anything. This
script is deliberately not a route: the thing that can create an
administrator out of nothing should need a shell on the machine, not a
browser. It is also the way back if every administrator is removed or
leaves.

# 12. Updating Floor Plans

BCIT reissues floor plans, and the app is traced from them. Replacing one is
done in the browser, not in the repository.

1. Sign in as an administrator and open **Plans** (`/admin/plans`).
2. Drop the new drawings in — PDF, or a PNG picture of one. A file named
   `SW1-Floor2.pdf` goes to SW1, floor 2; anything whose name cannot be read
   is still accepted, and you say where it belongs before uploading.
3. Check what each row says it will change, then press **Upload**.

What happens then:

- The picture the tracer draws under the map is re-rendered from the new
  drawing (`floorPlans/render_plan_images.py`).
- The copy being replaced is kept under
  `public/data/floorplan-archive/<sheet>/`, and **Kept Copies** on that row
  will put an earlier one back.
- The position that plan had on the map is carried across when the old and
  new drawings agree about the page they came from. When they do not — a
  reissue at a different scale or on a different size of paper — the upload
  says so, and the sheet has to be lined up with its building again in the
  tracer.
- **Nothing traced is touched.** The rooms drawn from the old sheet stay
  exactly where they were, because only a person can say which of them the
  new drawing has moved. Open the floor in the tracer, check the outlines
  against the new picture, and save — that is what publishes the change to
  search and routing.

## 12.1 Reading a Sheet Without Tracing It

Tracing a floor by hand is the way to get one right, and there are eighty-nine
of them. Two scripts fill a floor in without anybody reading it, so that a
building nobody has got to yet is still drawn, still searchable and still
routable — approximately, and saying so.

```powershell
py -3 floorPlans/read_sheet_auto.py --empty --jobs 6
```

Reads the rooms off every sheet that has nothing traced on it: the outlines
come from the walls, the numbers from OCR of the labels re-rendered out of the
PDF. Then the corridors, which are what is left of the floor once the rooms
are taken out of it:

```powershell
py -3 floorPlans/read_sheet_auto.py --all --halls
```

And then a walking network on each floor — a line of nodes down the middle of
every corridor, a node in every room joined to the nearest one it can reach,
and one link out to the campus paths:

```powershell
py -3 floorPlans/lay_nodes.py --all
py -3 floorPlans/name_nodes.py
py -3 floorPlans/build_nav_graph.py
py -3 floorPlans/build_room_search_index.py public/data/floor-coordinates public/data/room-search-index.json
```

**None of it is checked, and all of it says so.** A room read this way carries
`source: "ocr"`, a corridor worked out by subtraction carries
`source: "auto"`, and so does every node; anything the reader was unsure of
carries `check: true` and a `conf` score, which the search index passes
through. Running any of these again replaces only what a machine made —
outlines somebody drew in the tracer and nodes somebody placed there are held
back and fitted around, never overwritten. So correcting a floor is ordinary
tracer work, and nothing here will undo it.

As it stands, all eighty-nine sheets are read: 2,984 rooms off the drawings,
1,215 corridors worked out between them, and a walking network of about 6,200
nodes laid on top, which routes end to end in all 43 buildings that have two
rooms on a floor. About 1,400 of those rooms are flagged `check: true`. The
474 spaces somebody traced by hand are untouched.

What to expect to correct: a misread digit (`105` for `108` where the stencil
8 reads as an S), two rooms given the same number — the second keeps its shape
under `105-2` rather than being thrown away — and the odd "corridor" that is
really the gap between the outer wall and the site line, which is two metres
wide and forty long and looks like every other corridor to a machine.

# 13. Notes

- All Firebase Admin operations occur server-side and are secure.  
- Favorites appear automatically on the map upon load.  
- Sensitive keys must remain in .env and never be committed.  
- Favorites are stored as user subcollections in Firestore.
