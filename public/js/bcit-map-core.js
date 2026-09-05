import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js";
import { classDueNow } from "/js/schedule-time.js";

window.addEventListener("DOMContentLoaded", () => {
  if (!window.mapboxgl) {
    console.error("[BCIT MAP] Mapbox GL JS failed to load.");
    return;
  }

  // --- Token setup ---
  const tokenMeta = document.querySelector('meta[name="mapbox-token"]');
  const tokenFromMeta = tokenMeta ? tokenMeta.content : "";
  const token = window.MAPBOX_TOKEN || tokenFromMeta || "";
  if (!token) {
    console.error("[BCIT MAP] Missing Mapbox token.");
    return;
  }
  mapboxgl.accessToken = token;

  // --- Map setup ---
  const BCIT_BURNABY = { lng: -123.001, lat: 49.251 }; // tweak if needed

  let isOverlayingIndoor = false;

  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [BCIT_BURNABY.lng, BCIT_BURNABY.lat],
    zoom: 15.3,
  });

  // Controls
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

  // Geolocate control + track user location
  const geoControl = new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true });
  map.addControl(geoControl, 'top-right');

  let lastUserLocation = null;
  geoControl.on('geolocate', (e) => {
    lastUserLocation = { lng: e.coords.longitude, lat: e.coords.latitude };
  });

  /**
   * Where the user is, asked for directly.
   *
   * lastUserLocation is only filled in once someone has pressed the locate
   * control, so a route with no start had nothing to go on and fell back to
   * the middle of the map -- which is why directions used to begin "Map
   * center". Asking at the moment a route is requested is also the moment the
   * permission prompt makes sense to the person seeing it.
   *
   * Resolves to null rather than rejecting: no position is a normal answer
   * (permission refused, no sensor, indoors with no fix), and the caller has
   * somewhere else to start from.
   */
  const requestUserLocation = ({ timeoutMs = 8000, maxAgeMs = 60000 } = {}) =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // some browsers never call either callback when a prompt is dismissed
      setTimeout(() => finish(null), timeoutMs + 500);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastUserLocation = { lng: pos.coords.longitude, lat: pos.coords.latitude };
          finish(lastUserLocation);
        },
        () => finish(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maxAgeMs }
      );
    });

  // Ensure map container is positioned (for overlays)
  const mapContainer = document.getElementById('map');
  if (mapContainer && getComputedStyle(mapContainer).position === 'static') {
    mapContainer.style.position = 'relative';
  }

  // ----------------- Google-Maps-style sidebar -----------------
  // A single left-hand panel that shows building info, room details, and
  // turn-by-turn directions -- replacing the old floating popup bubble,
  // floor-selector box, and nav pill that used to be scattered over the map.
  const sidebarBody = document.getElementById('sidebar-body');

  const sidebar = {
    setBody(html) { if (sidebarBody) sidebarBody.innerHTML = html; },
    reset() { renderBrowse(); },
    el() { return sidebarBody; },
  };
  window.BCITMap = window.BCITMap || {};
  window.BCITMap.sidebar = sidebar;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // ---------------- Resting state: browse + recents ----------------
  // The sidebar used to sit empty with "search for a building or room".
  // That asks the user to already know what the app covers -- there was no
  // way to find out which buildings even have floor plans without guessing
  // codes. The resting state now lists them, plus the rooms this browser
  // looked at recently and a two-room directions form, so the panel is a
  // starting point instead of a prompt.

  // "LECTURE HALL" -> the rooms that go by that name, so a name with a space
  // in it is recognised as one thing rather than split down the middle
  const roomsByName = new Map();

  const roomIndexPromise = (async () => {
    try {
      const res = await fetch('/data/room-search-index.json', { cache: 'no-store' });
      if (!res.ok) return [];
      const json = await res.json();
      const rooms = Array.isArray(json.rooms) ? json.rooms : [];
      // Rooms are known by their names as well as their numbers, and a name
      // with a space in it has to be recognised whole -- "Lecture Hall" is
      // not room HALL of a building called LECTURE.
      for (const r of rooms) {
        const name = String(r.name || '').trim().toUpperCase();
        if (!name || !r.building || !r.room) continue;
        if (!roomsByName.has(name)) roomsByName.set(name, []);
        roomsByName.get(name).push({ building: r.building.toUpperCase(), room: String(r.room) });
      }
      return rooms;
    } catch {
      return []; // search still works off the building index alone
    }
  })();
  // shared so the search plugin doesn't download the same index a second time
  window.__ROOM_INDEX_PROMISE__ = roomIndexPromise;

  let buildingsWithPlans = null;
  const getBuildingsWithPlans = async () => {
    if (buildingsWithPlans) return buildingsWithPlans;
    const byCode = new Map();
    for (const r of await roomIndexPromise) {
      if (!r.building) continue;
      if (!byCode.has(r.building)) byCode.set(r.building, { floors: new Set(), rooms: 0 });
      const entry = byCode.get(r.building);
      if (r.floor) entry.floors.add(String(r.floor));
      entry.rooms += 1;
    }
    buildingsWithPlans = [...byCode.entries()]
      .map(([code, e]) => ({ code, floors: e.floors.size, rooms: e.rooms }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    return buildingsWithPlans;
  };

  // Which codes are real buildings, so "SW3" is read as one and "1750" is
  // not. Filled in once the campus outlines load; empty until then, which
  // only means a bare code typed in the first second is read as a room.
  const buildingCodes = new Set();
  const buildingNames = new Map();   // code -> "Tall Timber Student Housing"
  const placeKinds = new Map();      // code -> 'building' | 'parking'

  const RECENTS_KEY = 'wayfindr.recentRooms';
  const RECENTS_MAX = 8;
  // A room number is unique within its building, so the floor is not part of
  // what makes two entries the same room. It was, and the result was SW5-1840
  // listed twice over: once from opening it, which knows the floor, and once
  // from arriving there, which does not.
  const recentKey = (r) => `${r.building}|${r.room}`;

  // localStorage throws outright in some privacy modes, so every access is
  // guarded -- a browser that can't remember recents should still get a
  // working sidebar.
  const readRecents = () => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENTS_KEY));
      if (!Array.isArray(v)) return [];
      // A room number never contains its own building code. Entries that do
      // were written by a bug, and there is no point making someone clear
      // their history by hand to be rid of them.
      const seen = new Set();
      return v.filter((r) => {
        if (!r || !r.building || !r.room) return false;
        const room = String(r.room).toUpperCase();
        const building = String(r.building).toUpperCase();
        if (room.startsWith(`${building}-`) || room === building) return false;
        // "LOT-A" is a place whose name has a space in it, split down the
        // middle by a parser that did not know better and stored as a room
        if (buildingCodes.has(`${building} ${room}`)) return false;
        // a room whose "number" is another building's code -- "SW3-SW7" --
        // came from a destination reference being stored whole
        if (buildingCodes.has(room)) return false;
        // The same room twice over was written by a bug, and there is no
        // point making someone clear their history by hand to be rid of it.
        const key = `${building}|${room}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      return [];
    }
  };
  const rememberRoom = (entry) => {
    if (!entry || !entry.building || !entry.room) return;
    const rec = {
      building: String(entry.building).toUpperCase(),
      floor: entry.floor ? String(entry.floor) : '',
      room: String(entry.room),
    };
    const existing = readRecents();
    // Arriving somewhere knows the room but not the floor; opening it knows
    // both. Whichever happens second should not forget what the first knew.
    if (!rec.floor) {
      const known = existing.find((x) => recentKey(x) === recentKey(rec) && x.floor);
      if (known) rec.floor = known.floor;
    }
    const next = [rec, ...existing.filter((x) => recentKey(x) !== recentKey(rec))]
      .slice(0, RECENTS_MAX);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* not fatal */ }
  };
  const clearRecents = () => {
    try { localStorage.removeItem(RECENTS_KEY); } catch { /* not fatal */ }
    renderBrowse();
  };

/**
 * Offer rooms as you type into a directions box.
 *
 * The main search bar has always suggested rooms; the From and To boxes did
 * not, so you had to know the exact number to ask for directions -- and a
 * near miss just failed. Same index, same matching, offered where the
 * question is being asked.
 */
  // Only a room is somewhere you ask to be taken. A hallway is how you get
  // there, a stairwell is something you pass through, and nobody asks to be
  // sent to a riser cupboard.
  const isDestinationType = (type) => String(type || 'room').toLowerCase() === 'room';


  function attachSuggest(input) {
    const box = document.createElement("div");
    box.className = "browse-suggest";
    box.hidden = true;
    input.insertAdjacentElement("afterend", box);

    let matches = [];
    let active = -1;

    const close = () => { box.hidden = true; active = -1; };

    const choose = (i) => {
      const m = matches[i];
      if (!m) return;
      input.value = m.isBuilding ? m.building : `${m.building}-${m.room}`;
      close();
      input.focus();
    };

    const render = () => {
      if (!matches.length) return close();
      box.innerHTML = matches.map((m, i) => `
        <button type="button" class="browse-suggest-row${i === active ? " is-active" : ""}" data-i="${i}">
          <span>${esc(m.building)}${m.isBuilding ? "" : `-${esc(m.room)}`}${m.name ? ` <em>${esc(m.name)}</em>` : ""}</span>
          <small>${esc(m.floorLabel)}${m.type && m.type !== "room" ? ` · ${esc(m.type)}` : ""}</small>
        </button>`).join("");
      box.hidden = false;
      box.querySelectorAll(".browse-suggest-row").forEach((b) => {
        // mousedown, not click: blur would close the list first
        b.addEventListener("mousedown", (e) => { e.preventDefault(); choose(Number(b.dataset.i)); });
      });
    };

    input.addEventListener("input", async () => {
      // Two readings of what was typed: without spaces for "SW3 1750", with
      // them for "lecture hall" -- collapsing the spaces out of a name would
      // have meant it never matched anything.
      const words = input.value.trim().toUpperCase();
      const q = words.replace(/\s+/g, "");
      if (q.length < 1) return close();
      const rooms = await roomIndexPromise;
      const scored = [];

      // Buildings are destinations in their own right -- "take me to SW7"
      // when you do not know or care which room. They rank above rooms on an
      // exact code match, because typing "SW3" means the building.
      for (const code of buildingCodes) {
        const label = String(code).toUpperCase();
        let rank = null;
        if (label === q) rank = -1;
        else if (label.startsWith(q)) rank = 1.5;
        if (rank === null) continue;
        scored.push({
          rank, building: code, room: '', isBuilding: true,
          name: buildingNames.get(label) || null,
          floorLabel: placeKinds.get(label) === 'parking' ? 'Parking' : 'Building',
        });
      }
      for (const r of rooms) {
        if (!r.building || !r.room) continue;
        // A corridor is something you walk along, not somewhere you are
        // going, and nobody asks to be taken to a riser shaft. Offering them
        // as destinations made the list mostly noise.
        if (!isDestinationType(r.type)) continue;
        const label = `${r.building}-${r.room}`.toUpperCase();
        const bare = String(r.room).toUpperCase();
        const name = String(r.name || "").toUpperCase();
        // a bare number you type is usually the room, so rank that first
        let rank = null;
        if (bare === q || label === q) rank = 0;
        else if (bare.startsWith(q)) rank = 1;
        else if (label.startsWith(q)) rank = 2;
        else if (name && name.startsWith(words)) rank = 2;
        else if (label.includes(q)) rank = 3;
        else if (name && name.includes(words)) rank = 3;
        if (rank === null) continue;
        scored.push({ rank, building: r.building, room: r.room, type: r.type,
          name: r.name || null,
          floorLabel: r.floor ? `Floor ${r.floor}` : "" });
        if (scored.length > 400) break;
      }
      scored.sort((a, b) => a.rank - b.rank
        || String(a.room).localeCompare(String(b.room), undefined, { numeric: true }));
      matches = scored.slice(0, 8);
      active = -1;
      render();
    });

    input.addEventListener("keydown", (e) => {
      if (box.hidden || !matches.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        render();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (e.key === "Escape") {
        close();
      }
    });

    input.addEventListener("blur", () => setTimeout(close, 120));
  }

  const browseRow = (onclick, title, subtitle) =>
    `<li><button type="button" class="browse-row" onclick="${onclick}">
       <span class="browse-row-title">${title}</span>
       <span class="browse-row-sub">${subtitle}</span>
     </button></li>`;

  async function renderBrowse() {
    const recents = readRecents();
    const recentsHtml = recents.length ? `
      <section class="browse-section">
        <h3 class="browse-heading">Recent
          <button type="button" class="browse-clear" onclick="window.BCITMap.clearRecents()">Clear</button>
        </h3>
        <ul class="browse-list">
          ${recents.map((r) => browseRow(
    `window.BCITMap.focusRoom({building:'${esc(r.building)}',floor:'${esc(r.floor)}',room:'${esc(r.room)}'})`,
    `${esc(r.building)}-${esc(r.room)}`,
    `Floor ${esc(r.floor || '1')}`
  )).join('')}
        </ul>
      </section>` : '';

    sidebar.setBody(`
      ${recentsHtml}
      <section class="browse-section">
        <h3 class="browse-heading">Directions</h3>
        <form class="browse-directions" onsubmit="return window.BCITMap.submitDirections(event)">
          <input name="from" placeholder="From, e.g. SW3-1600" autocomplete="off" aria-label="From room">
          <input name="to" placeholder="To, e.g. SW3-1990" autocomplete="off" aria-label="To room">
          <button type="submit" class="browse-go">Get Directions</button>
        </form>
        <p class="browse-error" id="browse-directions-error" hidden></p>
      </section>
      <section class="browse-section">
        <h3 class="browse-heading">Buildings With Floor Plans</h3>
        <ul class="browse-list" id="browse-buildings"><li class="sidebar-hint">Loading…</li></ul>
      </section>
    `);

    const form = document.querySelector('.browse-directions');
    if (form) {
      attachSuggest(form.from);
      attachSuggest(form.to);
    }

    const buildings = await getBuildingsWithPlans();
    const list = document.getElementById('browse-buildings');
    if (!list) return; // the panel moved on while we were loading
    list.innerHTML = buildings.length
      ? buildings.map((b) => browseRow(
        `window.BCITMap.focusRoom({building:'${esc(b.code)}'})`,
        esc(b.code),
        `${b.floors} floor${b.floors === 1 ? '' : 's'} · ${b.rooms} rooms`
      )).join('')
      : '<li class="sidebar-hint">No floor plan data is loaded yet.</li>';
  }

  // "SW3-1600", "sw3 1600" and a bare "1600" all mean something here; the
  // bare form only works when the other field names a building.
  const parseRoomRef = (raw) => {
    const s = (raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return null;
    // A place whose name has a space in it -- "LOT A", "LOT Q" -- is one
    // name, not a building and a room. Checking the whole string against the
    // places we know about first is what stops "LOT A" being read as room A
    // of a building called LOT.
    if (buildingCodes.has(s)) return { building: s, room: '' };

    // The same trap catches rooms: "Lecture Hall" was being read as room HALL
    // of a building called LECTURE. A room name is only accepted when it
    // names exactly one room -- three of them are lecture halls, and picking
    // one for the user would be picking wrong two times in three.
    const named = roomsByName.get(s);
    if (named && named.length === 1) {
      return { building: named[0].building, room: named[0].room };
    }
    if (named && named.length > 1) {
      return { ambiguous: s, building: null, room: s };
    }

    // Only a code we recognise separates a building from a room. Splitting on
    // the first space regardless is what turned every two-word name into a
    // building nobody has heard of.
    const m = s.match(/^([A-Z]+\d*)[-\s]+(\S.*)$/);
    if (m && buildingCodes.has(m[1])) return { building: m[1], room: m[2].trim() };
    if (m && /\d/.test(m[2])) return { building: m[1], room: m[2].trim() };
    // A building code on its own is a destination too -- "take me to SW3"
    // when you do not know which room you want. It has no room, and the
    // router reads that as "anywhere in this building".
    if (/^[A-Z]{1,4}\d{0,3}$/.test(s) && buildingCodes.has(s)) {
      return { building: s, room: '' };
    }
    return { building: null, room: s };
  };

  // Drawn straight away rather than from the map's load handler: the panel
  // is a list of buildings and a form, none of which needs the map, and
  // waiting on tiles left the sidebar showing a bare hint the whole time
  // the basemap was still coming in.
  renderBrowse();

  // Turns what was typed into an end of a route: the text the router should
  // be given, and the words to put on the card. Null when the box was empty.
  const endFromText = (raw, fallbackBuilding) => {
    const ref = parseRoomRef(raw);
    if (!ref) return null;
    if (ref.ambiguous) return { ambiguous: ref.ambiguous };
    const building = ref.building || fallbackBuilding || '';
    if (ref.room) {
      return {
        ref: building ? `${building}-${ref.room}` : ref.room,
        label: makeRoomLabel(building, '', ref.room),
        building,
      };
    }
    return { ref: ref.building, label: ref.building, building: ref.building };
  };

  const submitDirections = (event) => {
    event.preventDefault();
    const form = event.target;
    const errEl = document.getElementById('browse-directions-error');
    const showError = (msg) => {
      if (!errEl) return;
      errEl.textContent = msg;
      errEl.hidden = false;
    };
    if (errEl) errEl.hidden = true;

    const fromRef = parseRoomRef(form.from.value);
    const toRef = parseRoomRef(form.to.value);
    if (!toRef) {
      showError('Enter a room, a building or a car park to go to.');
      return false;
    }
    for (const ref of [fromRef, toRef]) {
      if (ref?.ambiguous) {
        showError(`More than one room is called ${ref.ambiguous}. `
          + 'Pick the one you mean from the list.');
        return false;
      }
    }
    // A bare room number takes its building from the other box, so
    // "SW3-1600" to "1990" still means two rooms in SW3. A car park cannot
    // stand in for it: there are no room numbers out there, and "LOT A" to
    // "1750" was being read as room 1750 of Lot A and refused as unmapped
    // rather than as the question it is.
    const isLot = (code) => placeKinds.get(String(code || '').toUpperCase()) === 'parking';
    const named = [fromRef?.building, toRef.building].filter(Boolean);
    const fallback = named.find((code) => !isLot(code)) || '';
    if (!fallback && ((fromRef && !fromRef.building) || !toRef.building)) {
      showError('Include the building code on the room, e.g. SW3-1750.');
      return false;
    }
    const to = endFromText(form.to.value, fallback);
    const from = endFromText(form.from.value, fallback);
    if (!to.building && !to.ref) {
      showError('Include the building code, e.g. SW3-1600 or just SW3.');
      return false;
    }
    if (!from) {
      // No start given means "from where I am". Nothing needs typing for
      // that, so it is not an error -- it is the common case.
      startRouteTo(to, { onError: showError });
      return false;
    }
    runRoute(from, to);
    return false;
  };

  /**
   * Go somewhere, starting from wherever the user already is.
   *
   * Every "Directions" button ends up here: on a room, on a building, on a
   * car park. The start is whatever they have already said it is -- a place
   * they pressed "Start Here" on -- and otherwise where their browser says
   * they are, asked for at the moment they ask for directions, which is the
   * moment the permission prompt makes sense to them.
   */
  const startRouteTo = async (to, { onError } = {}) => {
    if (!to) return;

    if (customStart) {
      runRoute(customStart, to);
      return;
    }

    renderDirectionsCard({
      fromLabel: 'Finding your location…', toLabel: to.label,
    });
    const here = await requestUserLocation();
    if (here) {
      runRoute({ lng: here.lng, lat: here.lat, label: 'Your Location' }, to);
      return;
    }

    // No fix -- refused, indoors, no sensor. There is nothing to guess at, so
    // ask. The message goes into the form's own error line rather than onto a
    // card of its own: "say where you are starting from" is only useful next
    // to the box you would say it in.
    const message = `Going to ${to.label}. Turn on location, or say where you `
      + 'are starting from.';
    if (onError) return onError(message);
    await renderBrowse();
    const form = document.querySelector('.browse-directions');
    if (form) {
      form.to.value = to.ref || to.label || '';
      form.from.focus();
    }
    const errEl = document.getElementById('browse-directions-error');
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
  };

  // "Directions" on a building or car park card: the place itself is the
  // destination, and which way in you end up at is the router's business.
  const routeToBuilding = (code) => {
    const b = String(code || '').trim();
    if (!b) return;
    startRouteTo({ ref: b, label: b, building: b.toUpperCase() });
  };

  const getJSON = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  };

  const asLines = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join('<br>');
    const s = String(v).trim();
    if (!s) return '';
    return s.split(/[\n;,]/).map((t) => t.trim()).filter(Boolean).join('<br>');
  };

  const geometryBounds = (geom) => {
    try {
      const coords = [];
      const collect = (g) => {
        if (!g) return;
        const t = g.type;
        if (t === 'Point') coords.push(g.coordinates);
        else if (t === 'MultiPoint' || t === 'LineString') coords.push(...g.coordinates);
        else if (t === 'MultiLineString' || t === 'Polygon') g.coordinates.forEach((c) => coords.push(...c));
        else if (t === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((c) => coords.push(...c)));
        else if (t === 'GeometryCollection') g.geometries.forEach(collect);
      };
      collect(geom);
      if (!coords.length) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of coords) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return [[minX, minY], [maxX, maxY]];
    } catch (e) 
    { 
      console.log(e.message);
      return null; 
    }
  };

  const roughCenter = (geom) => {
    const b = geometryBounds(geom);
    return b ? [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2] : null;
  };

  const sortFloorsBottomFirst = (labels) => {
    const nums = [], rest = [];
    for (const l of labels) {
      const n = parseInt(String(l).trim(), 10);
      if (Number.isFinite(n)) nums.push([n, l]); else rest.push(l);
    }
    nums.sort((a, b) => a[0] - b[0]);
    return [...nums.map((x) => x[1]), ...rest];
  };

  const _existCache = new Map();
  const pdfExists = async (url) => {
    if (_existCache.has(url)) return _existCache.get(url);
    try {
      const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-7' }, cache: 'no-store' });
      if (!res.ok && res.status !== 206) { _existCache.set(url, false); return false; }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let sig = '';
      for (let i = 0; i < Math.min(5, bytes.length); i++) sig += String.fromCharCode(bytes[i]);
      const ok = sig === '%PDF-' || ct.includes('application/pdf');
      _existCache.set(url, ok);
      return ok;
    } catch (e) 
    { 
      console.log(e.message);
      _existCache.set(url, false); 
      return false; 
    }
  };

  const filterExistingPDFs = async (buildingName, floorLabels) => {
    const code = (buildingName || '').trim();
    if (!code) return [];
    const checks = floorLabels.map(async (label) => {
      const clean = String(label).trim();
      const url = `/data/floorplans/${code}-Floor${clean}.pdf`;
      return (await pdfExists(url)) ? { label: clean, pdfUrl: url } : null;
    });
    const results = await Promise.all(checks);
    return results.filter(Boolean);
  };

  const buildPopupHTML = ({ title, buildingAddress, services, floorItems }) => {
    const floorsHTML = floorItems && floorItems.length ? floorItems.map(({ label, pdfUrl }) =>
      `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:.45rem .6rem;border-top:1px solid #f1f1f1;">
          <div style="font-weight:600;">Floor ${label}</div>
          <a href="${pdfUrl}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;">PDF</a>
        </div>
      `
    ).join('')
      : `<div style="padding:.55rem .6rem;opacity:.7;">No floor plans found.</div>`;

    return `
      <div class="bcit-popup" style="font-family:system-ui;width:360px;">
        
        <h3 style="margin:0 0 .25rem 0;font-size:1.15rem;font-weight:600;">${title}</h3>

        <div style="margin-top:.6rem;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04);">
          
          <div style="display:grid;grid-template-columns:38% 62%;border-bottom:1px solid #e5e7eb;">
            <div style="padding:.55rem .6rem;font-weight:600;background:#f9fafb;">Building</div>
            <div style="padding:.55rem .6rem;">${buildingAddress || '—'}</div>
          </div>

          <div style="display:grid;grid-template-columns:38% 62%;border-bottom:1px solid #e5e7eb;">
            <div style="padding:.55rem .6rem;font-weight:600;background:#f9fafb;">Service</div>
            <div style="padding:.55rem .6rem;">${services || '—'}</div>
          </div>

          <div>
            <div style="padding:.55rem .6rem;font-weight:600;background:#f9fafb;border-bottom:1px solid #e5e7eb;">Floor Plans</div>
            ${floorsHTML}
          </div>
        </div>
      </div>
    `;
  };

  let startMarker = null;
  let endMarker = null;
  // Where a route starts, when the user has said so rather than leaving it to
  // their phone. One object, because both ends of a route are the same kind
  // of thing: { ref, lng, lat, label, building }. `ref` is a name the router
  // knows ("SW3-1650", "LOT Q") when there is one, and the point is what
  // stands in for it when there is not.
  let customStart = null;
  let customStartMarker = null;

  // Hand-calibrated floor sheets store a room as "SW3-1602" and generated
  // ones store "1602". Either way the room is 1602.
  const bareRoom = (building, room) => {
    const b = String(building || '').trim();
    const r = String(room || '').trim();
    return b && r.toUpperCase().startsWith(`${b.toUpperCase()}-`)
      ? r.slice(b.length + 1) : r;
  };

  function makeRoomLabel(building, floor, room) {
    const b = String(building || '').trim();
    const f = String(floor || '').trim();
    const pureRoom = bareRoom(b, room);
    if (b && pureRoom) return `${b} · ${pureRoom}`;
    if (b && f) return `${b} · Floor ${f}`;
    if (b) return b;
    if (pureRoom) return pureRoom;
    return 'Selected point';
  }

  // Renders the sidebar's directions view: endpoints, and once the route is
  // back, distance + a room-by-room step list (grouped by floor).
  // The directions last drawn, so they can be gone back to. Looking at a room
  // along the way should not mean asking for the route a second time.
  let lastDirections = null;

  const renderDirectionsCard = (card) => {
    lastDirections = card;
    drawDirectionsCard(card);
  };

  /** Put the directions back up, if there are any. */
  const showLastDirections = () => {
    if (!lastDirections) return false;
    drawDirectionsCard(lastDirections);
    return true;
  };

  const drawDirectionsCard = ({ fromLabel, toLabel, path, distanceM, message }) => {
    // Every point on a route is a walking node standing IN some space, so
    // listing the points named the corridor you are walking along as though
    // it were a place to go: "1600", then "continue along the corridor",
    // which is the same corridor said twice. Consecutive points in the same
    // space are one leg instead, and a leg is an instruction: follow this
    // corridor for this far, then arrive.
    let stepsHtml = '';
    let stepCount = 0;

    if (path && path.length) {
      const metresBetween = (a, b) => {
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(h));
      };
      const push = (text, cls) => {
        stepsHtml += `<li${cls ? ` class="${cls}"` : ''}>${text}</li>`;
        if (!cls) stepCount += 1;
      };

      // One leg per space walked through. The walk BETWEEN two spaces counts
      // towards the one you are heading into -- "follow 1660 for 15 m" is the
      // whole walk along it, including getting there -- so the step distances
      // add up to the total rather than losing every transition.
      const legs = [];
      path.forEach((p, i) => {
        const prev = i > 0 ? path[i - 1] : null;
        const gap = prev ? metresBetween(prev, p) : 0;
        // The hop off an anchor -- a car park, wherever the phone put you --
        // is not a walk along anything: there is no mapped path under it. It
        // is kept apart so it can be said as its own step rather than adding
        // four hundred metres to "follow the path outside", which is a path
        // that does not go there.
        const offAnchor = Boolean(prev && prev.kind === 'anchor');
        const space = p.room || null;
        const last = legs[legs.length - 1];
        // A leg is a space, on a floor, in a building. Crossing from one
        // building to another starts a new leg even when neither end has a
        // room number -- walking out of SW3 and into SW7 is two things.
        // Same space, same building, and a floor that does not contradict:
        // a node whose floor was never recorded is not a different floor, and
        // treating it as one broke a single walk down one hallway into four
        // steps that each said "follow the hallway".
        const sameFloor = last && (last.floor === p.floor || !last.floor || !p.floor);
        // An anchor is a car park, or wherever the phone says you are: it is
        // not on the network, and the walk from it to the nearest path is its
        // own step. Without this it merged into the outdoor stretch that
        // follows and the name of the place you started from was lost.
        const sameKind = last && last.kind === (p.kind || null);
        if (last && last.space === space && sameFloor && sameKind
          && last.building === (p.building || null)) {
          last.metres += gap;
          last.floor = last.floor || p.floor;
          last.end = p;
        } else {
          legs.push({
            space, name: p.name || null, floor: p.floor,
            // the walk to or from an anchor is an approach, never a leg's own
            // distance, or it would be counted in both
            metres: (offAnchor || p.kind === 'anchor') ? 0 : gap,
            approach: (offAnchor || p.kind === 'anchor') ? gap : 0,
            building: p.building || null,
            // p.type is what the node is; p.space is what it stands in, and a
            // walking node in a stairwell is typed as a corridor either way
            type: p.space || p.type, kind: p.kind, end: p,
          });
        }
      });

      const isVertical = (leg) => leg.type === 'stairs' || leg.type === 'elevator';

      // "Take the stairs" is a step without a distance, so what you walk
      // getting through the stairwell moves to the leg that follows it rather
      // than disappearing from the total.
      legs.forEach((leg, i) => {
        const next = legs[i + 1];
        if (i > 0 && isVertical(leg) && next) {
          next.metres += leg.metres;
          leg.metres = 0;
        }
      });

      // Arriving is not a distance you walk either, so the last approach
      // belongs to the nearest step before it that shows one.
      if (legs.length > 1) {
        const arrival = legs[legs.length - 1];
        for (let i = legs.length - 2; i >= 0; i -= 1) {
          if (isVertical(legs[i])) continue;
          legs[i].metres += arrival.metres;
          arrival.metres = 0;
          break;
        }
      }

      // "1750 (Lecture Hall)" is how a person holds the place in their head:
      // the number gets you to the door, the name tells you you are there.
      const named = (leg, arriving) => {
        if (leg.space && leg.name) return `${leg.space} (${leg.name})`;
        if (leg.space) return leg.space;
        if (leg.name) return leg.name;
        // an anchor with nothing to call it: where the phone put you
        if (leg.kind === 'anchor') return 'where you are';
        if (leg.type === 'stairs') return 'the stairs';
        if (leg.type === 'elevator') return 'the lift';
        // Outside there are no room numbers at all.
        if (!leg.building) return 'the path outside';
        // A node in a place but on no floor is outdoors in it -- the path at
        // a building's door, or a car park, which has no hallways. "Start at
        // the hallway" was what a route out of Lot F opened with.
        if (!leg.floor) return leg.building;
        // Inside one, an unnamed stretch is a hallway. The building's own
        // name is the answer only when the building is where you are going --
        // "follow SW3 for 6 m" is not something anyone would say.
        return arriving ? leg.building : 'the hallway';
      };

      // Where you are, as a heading: the building and the floor of it. A
      // route that leaves the building needs to say so, and a node inside a
      // building that has no floor recorded is still in that building -- it
      // was announcing "SW3" as a new place one step after "Floor 1".
      let lastZone = null;
      let lastBuilding = null;
      legs.forEach((leg, i) => {
        const isLast = i === legs.length - 1;
        // Getting between somewhere unmapped and the network is a step of its
        // own: "head 456 m to the mapped paths" is the truth, where "follow
        // the path outside for 456 m" names a path that does not reach there.
        const approach = Math.round(leg.approach || 0);
        // That walk happens before you get where it takes you, so it goes
        // above the heading for that place rather than under it.
        if (approach >= 1 && i > 0 && leg.kind !== 'anchor') {
          push(`Head ${approach} m to the mapped paths`);
        }
        const zone = !leg.building ? 'Outside'
          : leg.floor ? `${leg.building} · Floor ${leg.floor}`
            : leg.building === lastBuilding ? lastZone   // still inside it
              : leg.building;
        if (zone !== lastZone) {
          push(zone, 'floor-heading');
          lastZone = zone;
        }
        if (leg.building) lastBuilding = leg.building;
        if (i === 0) {
          push(`Start at ${named(leg)}`);
          if (approach >= 1) push(`Head ${approach} m to the mapped paths`);
          // You can walk a long way before reaching anything worth naming --
          // 52 m along the corridor you started in was being left out of the
          // steps entirely.
          const out = Math.round(leg.metres);
          if (out >= 1 && !isLast) push(`Follow ${named(leg)} for ${out} m`);
          return;
        }
        if (isLast) {
          // the last hop off the network is a walk to the destination itself,
          // not to "the mapped paths" you are already standing on
          if (approach >= 1 && leg.kind === 'anchor') {
            push(`Head ${approach} m to ${named(leg, true)}`);
          }
          push(`Arrive at ${named(leg, true)}`);
          return;
        }
        if (isVertical(leg)) {
          // you take stairs, you do not follow them for a number of metres
          push(`Take ${leg.name || named(leg)}`);
          return;
        }
        const far = Math.round(leg.metres);
        push(far >= 1 ? `Follow ${named(leg)} for ${far} m` : `Through ${named(leg)}`);
      });
    }

    const body = message
      ? `<p class="directions-error">${message}</p>`
      : path
        ? `<div class="directions-summary">${distanceM}m &middot; ${stepCount} step${stepCount === 1 ? '' : 's'}</div><ol class="directions-steps">${stepsHtml}</ol>`
        : `<p class="sidebar-hint">Finding route…</p>`;

    sidebar.setBody(`
      <button type="button" class="sidebar-back" onclick="window.BCITMap.clearNavigation()">&larr; Back</button>
      <div class="directions-endpoints">
        <div class="directions-endpoint from">${fromLabel || ''}</div>
        <div class="directions-endpoint to">${toLabel || ''}</div>
      </div>
      ${body}
    `);
  };

  /**
   * Take the route off the map, leaving the panel alone.
   *
   * A drawn route belongs to the directions view. Once you have moved on --
   * opened a room, gone back to the building -- it is a line lying across the
   * floor plan meaning nothing, so it goes whenever the panel shows something
   * that is not a route.
   */
  const clearRouteOverlay = () => {
    lastDirections = null;
    if (startMarker) { startMarker.remove(); startMarker = null; }
    if (endMarker) { endMarker.remove(); endMarker = null; }

    const navSrc = map.getSource('nav-route');
    if (navSrc) navSrc.setData({ type: 'FeatureCollection', features: [] });
  };

  const clearNavigation = () => {
    clearRouteOverlay();
    // The floors on show were opened for the route. Leaving it should leave
    // them too, or you are left looking at three floor plans stacked on top
    // of each other with nothing on the panel to say why.
    if (window.BCITMap && typeof window.BCITMap.clearFloors === 'function') {
      window.BCITMap.clearFloors();
    }
    sidebar.reset();
  };

  /**
   * Say what the start is, above the panel.
   *
   * "Start Here" used to drop a green pin on the map and change nothing else,
   * so the only sign it had worked was a dot somewhere in the corner of the
   * view -- and every "Directions" afterwards then quietly ignored it. It has
   * its own strip because the panel body is replaced whenever you open a room
   * or step back to a building, and a start you set two clicks ago is still
   * your start.
   */
  const renderStartBanner = () => {
    const el = document.getElementById('start-banner');
    if (!el) return;
    if (!customStart) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <span class="start-banner-text">Starting from <strong>${esc(customStart.label)}</strong></span>
      <button type="button" class="start-banner-clear">Clear</button>`;
    el.hidden = false;
    el.querySelector('.start-banner-clear')
      .addEventListener('click', () => clearCustomStart());
  };

  const clearCustomStart = () => {
    customStart = null;
    if (customStartMarker) { customStartMarker.remove(); customStartMarker = null; }
    renderStartBanner();
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearNavigation(); });

  /** Remember a start, mark it, and say so. */
  const setCustomStart = (end) => {
    if (!end) return;
    const lng = Number(end.lng);
    const lat = Number(end.lat);
    const hasPoint = Number.isFinite(lng) && Number.isFinite(lat);
    // Somewhere with neither a name the router knows nor a position on the
    // map is not a place anything can be routed from.
    if (!end.ref && !hasPoint) return;
    customStart = {
      ref: end.ref || null,
      lng: hasPoint ? lng : null,
      lat: hasPoint ? lat : null,
      label: end.label || end.ref || 'Selected point',
      building: end.building || null,
    };
    if (hasPoint) {
      if (customStartMarker) customStartMarker.setLngLat([lng, lat]);
      else customStartMarker = new mapboxgl.Marker({ color: '#16a34a' }).setLngLat([lng, lat]).addTo(map);
    } else if (customStartMarker) {
      customStartMarker.remove();
      customStartMarker = null;
    }
    renderStartBanner();
  };

  // "Start Here" on a room card. The room's number is what the router should
  // be given -- it names a node on the network, which the middle of the room
  // does not -- and the middle of the room is where the pin goes.
  const setStartFromRoom = (payload) => {
    if (!payload) return;
    const building = String(payload.building || '').trim().toUpperCase();
    const room = bareRoom(building, payload.room);
    setCustomStart({
      ref: building && room ? `${building}-${room}` : (building || null),
      lng: payload.lng,
      lat: payload.lat,
      label: makeRoomLabel(building, String(payload.floor || '').trim(), room),
      building,
    });
  };

  // "Start Here" on a building or car park card: the place itself is the
  // start, and the router picks whichever way out is nearest.
  const setStartFromPlace = (name) => {
    const place = String(name || '').trim();
    if (!place) return;
    setCustomStart({ ref: place, label: place, building: place.toUpperCase() });
  };

  // Renders an indoor route (an ordered list of {room, floor, lng, lat} from
  // /find-path) as a line on the map, using the same nav-route source the
  // outdoor Dijkstra route draws into. Replaces the old approach of
  // overlaying a static PNG that only existed for two pre-rendered buildings
  // (SW3, SW5).
  const renderIndoorPath = (path, { fit = false } = {}) => {
    const src = map.getSource('nav-route');
    if (!src || !path || path.length < 2) return;

    // The floor is drawn by another module, which may have added its layers
    // after these -- and a hallway fill over the route is what made the route
    // look like a grey smear along the corridor. Whoever added what, the
    // route belongs on top.
    // ...but under the stairs and lift icons, which are the one thing that
    // should stay readable when a route runs over them.
    const above = map.getLayer('building-floor-icon') ? 'building-floor-icon' : undefined;
    for (const id of ['nav-route-casing', 'nav-route-line', 'nav-route-approach']) {
      if (map.getLayer(id)) map.moveLayer(id, above);
    }

    // Every point on a route is a network node -- rooms are labels on nodes,
    // not places the route passes through -- except the anchors at either
    // end, which are somewhere nobody has traced a path into: a car park,
    // wherever the phone put you.
    //
    // The hop between an anchor and the network is drawn dashed, because it
    // is not a route. It is a straight line to where the mapped paths begin,
    // and drawn solid it read as an instruction to walk through the buildings
    // it happens to cross.
    const coords = path.map((p) => [p.lng, p.lat]);
    const features = [];
    let run = [];
    path.forEach((p, i) => {
      run.push(coords[i]);
      const next = path[i + 1];
      const hop = p.kind === 'anchor' || (next && next.kind === 'anchor');
      if (!next) return;
      if (hop) {
        if (run.length > 1) {
          features.push({
            type: 'Feature', properties: { approach: 0 },
            geometry: { type: 'LineString', coordinates: run },
          });
        }
        features.push({
          type: 'Feature', properties: { approach: 1 },
          geometry: { type: 'LineString', coordinates: [coords[i], coords[i + 1]] },
        });
        run = [coords[i + 1]];
      }
    });
    if (run.length > 1) {
      features.push({
        type: 'Feature', properties: { approach: 0 },
        geometry: { type: 'LineString', coordinates: run },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
    if (!fit) return;
    // A route asked for by name (the directions form, or a shared link) has
    // no click to have moved the map first, so frame it here.
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 100, maxZoom: 19, duration: 800 });
  };

  /**
   * Draw the route between two ends, whatever kind of thing each end is.
   *
   * An end is { ref, lng, lat, label }: a name the router knows when there is
   * one, a point on the map otherwise. The two are interchangeable on purpose
   * -- that is what makes "Start Here" on a car park, "Directions" on a room
   * across campus, and typing both into the form the same operation instead
   * of three that behave differently.
   */
  const runRoute = async (from, to, { fit = true } = {}) => {
    if (!from || !to) return false;
    // A name beats a point: it names a node on the network, where a point has
    // to be snapped to the nearest one.
    const asRef = (end) => (end.ref
      ? end.ref
      : { lng: end.lng, lat: end.lat, label: end.label || null });
    if (!from.ref && !Number.isFinite(Number(from.lng))) return false;
    if (!to.ref && !Number.isFinite(Number(to.lng))) return false;

    clearNavigation();
    const fromLabel = from.label || from.ref || 'Your Location';
    const toLabel = to.label || to.ref || 'Destination';
    renderDirectionsCard({ fromLabel, toLabel });

    const routed = await requestAndOverlayIndoorPath({
      building: to.building || from.building || '',
      startRoom: asRef(from),
      goalRoom: asRef(to),
      fromLabel,
      toLabel,
      fit,
    });

    // Only somewhere you actually got to is worth remembering. Recording the
    // destination whatever happened filled the Recent list with the typos and
    // dead ends of every failed attempt.
    if (routed && typeof asRef(to) === 'string') {
      const toRef = parseRoomRef(to.ref);
      const building = toRef?.building || to.building;
      // the floor is the one the route ended on, when that is the building
      // being remembered -- a room's floor is not always the first one
      const floor = routed.building === building ? routed.floor : '';
      if (toRef?.room) rememberRoom({ building, room: toRef.room, floor });
    }
    return Boolean(routed);
  };

  /**
   * Route between two rooms named by number, with no prior map interaction.
   * Backs the /map?from=&to= deep link and the schedule page's hand-off, so
   * both behave the same as typing the two into the directions form.
   */
  const routeBetweenRooms = (building, fromRoom, toRoom, opts = {}) => {
    const b = (building || '').trim().toUpperCase();
    const from = (fromRoom || '').trim();
    const to = (toRoom || '').trim();
    if (!from || !to) return;
    const end = (text, label) => {
      const parsed = parseRoomRef(text) || {};
      const code = parsed.building || b;
      return {
        ref: parsed.room ? (code ? `${code}-${parsed.room}` : parsed.room) : (code || text),
        label: label || (parsed.room ? makeRoomLabel(code, '', parsed.room) : (code || text)),
        building: code,
      };
    };
    return runRoute(end(from, opts.fromLabel), end(to, opts.toLabel));
  };

  /** Draws a route, and says whether there was one. */
  async function requestAndOverlayIndoorPath({ building, startRoom, goalRoom, fromLabel, toLabel, fit = false }) {
    if (isOverlayingIndoor) {
      console.log('[INDOOR] overlay in progress, skipping');
      return false;
    }
    isOverlayingIndoor = true;
    try {
      const payload = {
        building: String(building || '').toUpperCase(),
        startRoom,
        goalRoom,
      };
      const response = await fetch('/find-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.success) {
        console.warn('[INDOOR PATH]', result?.message || response.statusText);
        renderDirectionsCard({ fromLabel, toLabel, message: result?.message || 'No route to there yet.' });
        return false;
      }

      // Every floor the route runs through, in the order it meets them.
      //
      // Only the building the route ENDED in used to be opened, so a walk
      // from SW3-1750 to SW5-2895 drew SW5's rooms and left SW3 a plain blue
      // block -- and "Start at 1750 (Lecture Hall)" named a room you could
      // not see. A route is a thing that passes through buildings; all of
      // them are worth being able to see inside.
      //
      // Read off the route rather than the request: a route can end in a
      // different building from the one asked for, and it can end outdoors,
      // at a car park with no floors at all.
      // One floor per building, and not more: two floors of the same building
      // drawn together sit exactly on top of each other, and in SW5 that
      // buried the room being routed to under the lecture hall of the floor
      // below. The one shown is the floor the route spends the most of itself
      // on in that building -- which is the floor you are walking -- and the
      // later floor wins a tie, because that is the one you end on.
      const byBuilding = new Map();
      result.path.forEach((p, i) => {
        if (p.kind === 'anchor' || !p.building || !p.floor) return;
        const floors = byBuilding.get(p.building) || new Map();
        const floor = String(p.floor);
        const seen = floors.get(floor) || { floor, points: 0, last: -1 };
        seen.points += 1;
        seen.last = i;
        floors.set(floor, seen);
        byBuilding.set(p.building, floors);
      });
      const sheets = [];
      for (const [building, floors] of byBuilding) {
        const best = [...floors.values()]
          .sort((a, b) => b.points - a.points || b.last - a.last)[0];
        sheets.push({ building, floor: best.floor, at: best.last });
      }
      // in the order the route meets them, so the last one drawn is the one
      // it arrives on
      sheets.sort((a, b) => a.at - b.at);
      // Awaited, not fired off: this draws into the same map and sidebar, and
      // since it waits on the sheets it finishes AFTER this function would
      // otherwise have drawn the directions -- wiping the route out from
      // under the user.
      if (window.BCITMap && typeof window.BCITMap.showRouteFloors === 'function') {
        await window.BCITMap.showRouteFloors(sheets);
      }

      renderIndoorPath(result.path, { fit });
      renderDirectionsCard({ fromLabel, toLabel, path: result.path, distanceM: result.distanceM });
      // The last sheet the route touched, so the caller can record the floor
      // it arrived on: a room remembered without one was listed as "Floor 1"
      // whichever floor it was actually on.
      return sheets.length ? sheets[sheets.length - 1] : true;
    } catch (error) {
      console.error('[INDOOR PATH ERROR]:', error);
      renderDirectionsCard({ fromLabel, toLabel, message: 'Something went wrong finding that route.' });
      return false;
    } finally {
      isOverlayingIndoor = false;
    }
  }


  // "Directions" on a room card: take me to this room from wherever I am, or
  // from wherever I said "Start Here".
  //
  // This used to throw the start away and begin instead at the node nearest
  // the destination WITHIN the destination's own building -- so "Start Here"
  // in SW3-1650, then "Directions" to SW5-1840, gave a route from SW5-1800,
  // a few metres from the room, and called it "SW3 \u00b7 1650 \u00b7 1800". The graph
  // covers the whole campus now, so the start is simply the start.
  const navigateToRoom = (payload) => {
    if (!payload) return;
    const b = (payload.building || '').trim().toUpperCase();
    const r = bareRoom(b, payload.room);
    if (!b || !r) {
      console.warn('[BCIT MAP] navigateToRoom needs a building and a room.');
      return;
    }
    startRouteTo({
      ref: `${b}-${r}`,
      label: makeRoomLabel(b, String(payload.floor || '').trim(), r),
      building: b,
    });
  };

  const app = initializeApp(window.firebaseConfig);
  const auth = getAuth(app);

  // Helper: Get current user's ID token for server requests
  async function getIdToken() {
    const user = auth.currentUser;
    if (!user) throw new Error("Not authenticated. Please log in.");
    return await user.getIdToken(/* forceRefresh */ true);
  }

  // ---------------- "You have a class now" banner ----------------
  //
  // The schedule is only worth keeping if it saves you the lookup, so the map
  // reads it on load and, when a class is on or about to start, offers the
  // route to that room straight from the sidebar. Signed-out visitors have no
  // schedule, so nothing is requested and nothing is shown.
  const CLASS_SOON_MIN = 30;

  async function showClassBanner() {
    if (!window.__SIGNED_IN__) return;
    const bannerEl = document.getElementById('class-banner');
    if (!bannerEl) return;
    let schedule = [];
    try {
      const token = await getIdToken();
      const res = await fetch('/api/schedule', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      schedule = (await res.json()).schedule || [];
    } catch {
      return; // no session yet, or offline -- the map is fine without this
    }

    const due = classDueNow(schedule, new Date(), CLASS_SOON_MIN);
    if (!due) return;
    const e = due.entry;
    const when = due.status === 'now'
      ? 'on now'
      : `starts in ${due.until} min`;
    bannerEl.innerHTML = `
      <div class="class-banner-text">
        <strong>${esc(e.title)}</strong> ${esc(when)} · ${esc(e.building)}-${esc(e.room)}
      </div>
      <button type="button" class="class-banner-go">Directions</button>
    `;
    bannerEl.hidden = false;
    bannerEl.querySelector('.class-banner-go').addEventListener('click', () => {
      if (typeof window.BCITMap.focusRoom === 'function') {
        window.BCITMap.focusRoom({ building: e.building, floor: e.floor || undefined, room: e.room });
      }
    });
  }

  async function loadFavoriteMarkers() {
    try {
      const token = await getIdToken();
      const favRes = await fetch('/api/favorites', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!favRes.ok) throw new Error('Failed to load favorites');
      const { favorites } = await favRes.json();

      const roomFavs = favorites.filter(f => f.nodeMeta?.kind === 'room');
      const legacyFavs = favorites.filter(f => f.nodeMeta?.kind !== 'room');

      const nodeRes = legacyFavs.length ? await fetch('/api/nodes/data', { cache: 'no-store' }) : null;
      const nodes = nodeRes && nodeRes.ok ? await nodeRes.json() : [];

      const labelFor = (fav) => {
        let label = fav.label;
        if (!label && fav.addedAt?._seconds) label = new Date(fav.addedAt._seconds * 1000).toLocaleDateString();
        return label;
      };

      const markers = [];
      for (const fav of roomFavs) {
        const { lng, lat, building, floor, room } = fav.nodeMeta;
        if (typeof lng !== 'number' || typeof lat !== 'number') continue;
        markers.push({ lng, lat, label: labelFor(fav) || `${building}-${room}`, building, floor, room });
      }
      for (const fav of legacyFavs) {
        const node = nodes.find(n => n.id === fav.nodeId);
        if (!node) continue;
        markers.push({ lng: parseFloat(node.long), lat: parseFloat(node.lat), label: labelFor(fav) });
      }

      // Clear old markers
      if (window.favoriteMarkers) window.favoriteMarkers.forEach(m => m.remove());
      window.favoriteMarkers = [];

      // Add favorite markers
      markers.forEach(({ lng, lat, label, building, floor, room }) => {
        const el = new mapboxgl.Marker({ color: '#FFD700' }) // gold
          .setLngLat([lng, lat])
          .setPopup(new mapboxgl.Popup().setHTML(`⭐ <strong>${label}</strong><br>`))
          .addTo(map);
        if (building && room) {
          el.getElement().style.cursor = 'pointer';
          el.getElement().addEventListener('click', () => {
            if (window.BCITMap && typeof window.BCITMap.focusRoom === 'function') {
              window.BCITMap.focusRoom({ building, floor, room });
            }
          });
        }
        window.favoriteMarkers.push(el);
      });
    } catch (err) { console.warn('loadFavoriteMarkers failed:', err); }
  }

  // Called from the room popup's ☆ button
  async function toggleFavoriteRoom(payload) {
    if (!payload) return;
    const building = (payload.building || '').trim();
    const room = (payload.room || '').trim();
    const floor = (payload.floor || '').trim();
    if (!building || !room) return;

    const nodeId = `room:${building}-${floor}-${room}`.toUpperCase();
    try {
      const token = await getIdToken();
      const res = await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          nodeId,
          label: `${building}-${room}`,
          nodeMeta: { kind: 'room', building, floor, room, lng: payload.lng, lat: payload.lat },
        }),
      });
      if (!res.ok) throw new Error('Failed to save favorite');
      loadFavoriteMarkers();
    } catch (err) {
      console.warn('toggleFavoriteRoom failed:', err);
      alert(err.message === 'Not authenticated. Please log in.'
        ? 'Log in to save favorites.'
        : 'Could not save favorite: ' + err.message);
    }
  }

  // ----------------- Map load + building layers + nav route -----------------

  // The sidebar's buttons call window.BCITMap.* from inline handlers, so the
  // functions have to be there whether or not the map has finished loading.
  // They used to be published from inside the load handler, which left "Get
  // Directions" submitting the form to the server because the handler it was
  // meant to call did not exist yet.
  window.BCITMap = window.BCITMap || {};
  Object.assign(window.BCITMap, {
    map,
    navigateToRoom,
    clearNavigation,
    clearRouteOverlay,
    geolocateControl: geoControl,
    clearCustomStart,
    setStartFromRoom,
    setStartFromPlace,
    showLastDirections,
    // whether a route is on the map, so a card's Back knows where back is
    hasRoute: () => Boolean(lastDirections),
    toggleFavoriteRoom,
    routeBetweenRooms,
    routeToBuilding,
    startRouteTo,
    submitDirections,
    rememberRoom,
    clearRecents,
  });
  window.BCITMap.focusRoom = window.BCITMap.focusRoom || function () { };

  // This module is deferred, so by the time it runs the map has often already
  // fired 'load' -- a handler registered then would never be called, which is
  // how the deep links and building layers came to be silently dead. Waiting
  // for 'load' is not enough either: isStyleLoaded() stays false until every
  // source has loaded too, which in a background or throttled tab may be
  // never. What actually has to be true before addSource/addLayer is that the
  // style itself is parsed -- the same thing 'style.load' announces.
  const whenMapReady = (fn) => {
    let done = false;
    const ready = () => map.isStyleLoaded() || map.style?._loaded === true;
    const run = () => {
      if (done || !ready()) return;
      done = true;
      clearInterval(poll);
      fn();
    };
    const poll = setInterval(run, 60);
    map.on('load', run);
    map.on('style.load', run);
    run();
  };

  whenMapReady(async () => {
    try {
      const [buildings, buildingsIndex] = await Promise.all([getJSON('/data/bcit-coordinates.geojson'), getJSON('/data/bcit-buildings-index.json')]);
      window.__BUILDINGS_INDEX__ = buildingsIndex || {};
      Object.keys(window.__BUILDINGS_INDEX__).forEach((c) => buildingCodes.add(c.toUpperCase()));
      for (const f of buildings.features || []) {
        const p = f.properties || {};
        const code = String(p.BuildingName || "").toUpperCase();
        if (!code) continue;
        buildingCodes.add(code);
        if (p.Display_Name) buildingNames.set(code, p.Display_Name);
      }

      // Car parks, in their own colour and their own layer. Not buildings --
      // no floors, you drive into them -- but places all the same, and ones
      // people ask to be taken to more often than any single room.
      try {
        const parking = await getJSON('/data/parking-lots.geojson');
        map.addSource('parking', { type: 'geojson', data: parking });
        // Purple, and solid enough to see. At the opacity this started on it
        // was a suggestion of a colour next to the blue of the buildings, and
        // a car park you cannot pick out is not marked at all.
        map.addLayer({
          id: 'parking-fill', type: 'fill', source: 'parking',
          paint: { 'fill-color': '#7c3aed', 'fill-opacity': 0.32 },
        });
        map.addLayer({
          id: 'parking-line', type: 'line', source: 'parking',
          paint: { 'line-color': '#5b21b6', 'line-width': 1.6, 'line-opacity': 0.9 },
        });
        // Clicking a lot offers directions to it, the same as a building.
        // Without this a lot is decoration: visible, named, and no way to say
        // "take me there" except by typing its name.
        map.on('mouseenter', 'parking-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'parking-fill', () => { map.getCanvas().style.cursor = ''; });
        map.on('click', 'parking-fill', (e) => {
          const p = e.features?.[0]?.properties || {};
          const name = String(p.name || '').trim();
          if (!name) return;
          // A GeoJSON source hands array properties back as JSON text, so
          // this has to cope with both shapes.
          const kinds = Array.isArray(p.kinds) ? p.kinds : (() => {
            try { return JSON.parse(p.kinds || '[]'); } catch { return []; }
          })();
          clearRouteOverlay();
          sidebar.setBody(`
            <div class="place-card">
              <button type="button" class="sidebar-back"
                      onclick="window.BCITMap.clearNavigation();">&larr; Back</button>
              <h2>${esc(name)}</h2>
              <div class="place-sub">Parking${p.stalls ? ` · ${esc(p.stalls)} stalls` : ''}</div>
              ${kinds.length ? `<div class="place-name">${esc(kinds.join(' · '))}</div>` : ''}
              <div class="place-actions">
                <!-- the handlers are attached below rather than written
                     inline: a name with an apostrophe in it would end the
                     string. "Start Here" is the half of this that matters --
                     a car park is somewhere you arrive, park, and walk from,
                     so it is far more often the start of a route than the
                     end of one, and there was no way to say so. -->
                <button type="button" class="btn-primary" id="parking-directions">Directions</button>
                <button type="button" class="btn-secondary" id="parking-start">Start Here</button>
              </div>
              ${p.hours ? `<p class="sidebar-hint">${esc(p.hours)}</p>` : ''}
            </div>`);
          const go = document.getElementById('parking-directions');
          if (go) go.addEventListener('click', () => routeToBuilding(name));
          const start = document.getElementById('parking-start');
          if (start) {
            start.addEventListener('click', () => {
              setStartFromPlace(name);
              // Saying "start here" and being left on the same card gives no
              // sign of what to do next; the browse panel is where the other
              // end gets chosen, and the start now rides above it.
              renderBrowse();
            });
          }
        });

        map.addLayer({
          id: 'parking-label', type: 'symbol', source: 'parking',
          // a lot traced in several pieces is still one lot with one name
          filter: ['==', ['get', 'label'], true],
          layout: {
            'text-field': ['get', 'name'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 14],
          },
          paint: {
            'text-color': '#5b21b6',
            'text-halo-color': '#ffffff', 'text-halo-width': 1.4,
          },
        });
        for (const f of parking.features || []) {
          const name = String((f.properties || {}).name || '').toUpperCase();
          if (!name) continue;
          buildingCodes.add(name);
          placeKinds.set(name, 'parking');
          const kinds = f.properties.kinds || [];
          const what = kinds.length ? kinds[0] : 'Parking';
          buildingNames.set(name, f.properties.stalls
            ? `${what} · ${f.properties.stalls} stalls`
            : what);
        }
      } catch (err) {
        console.warn('parking lots unavailable:', err.message);
      }

      map.addSource('buildings', { type: 'geojson', data: buildings });
      map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-color': '#93c5fd', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings', paint: { 'line-color': '#2563eb', 'line-width': 1.2 } });

      // Say which building is which.
      //
      // The car parks have been labelled since they were added and the
      // buildings never were, so campus read as a field of identical blue
      // shapes: you could search SW3 by name, or click a shape to find out
      // what it was, but you could not look at the map and see where SW3 is.
      //
      // The code is the label, because the code is what a room number, a
      // timetable and everyone on campus uses. The longer name goes
      // underneath once you are close enough for it to fit.
      map.addLayer({
        id: 'buildings-label', type: 'symbol', source: 'buildings',
        // Four outlines have no name. Everything goes through to-string so a
        // missing name is an empty string rather than a null the expression
        // has to be typed around.
        filter: ['!=', ['to-string', ['get', 'BuildingName']], ''],
        layout: {
          'text-field': ['to-string', ['get', 'BuildingName']],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 16, 12, 19, 16],
          // a label belongs to its own outline, and should not spill across
          // the one next door
          'text-max-width': 9,
          'text-padding': 2,
        },
        paint: {
          'text-color': '#1e40af',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4,
        },
      });

      map.on('mouseenter', 'buildings-fill', () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', 'buildings-fill', () => map.getCanvas().style.cursor = '');

      // Highlight source/layer for selected building
      const selSrc = 'building-selected';
      if (!map.getSource(selSrc)) {
        map.addSource(selSrc, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'building-selected-line', type: 'line', source: selSrc, paint: { 'line-color': '#f59e0b', 'line-width': 3 } });
      }

      if (!map.getSource('nav-route')) {
        map.addSource('nav-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        // A route drawn as one thin line disappeared against the floor plan.
        // A dark casing under a bright core is how a route reads on any
        // background, and it thickens as you zoom in rather than staying hairline.
        const onNetwork = ['!=', ['get', 'approach'], 1];
        map.addLayer({
          id: 'nav-route-casing', type: 'line', source: 'nav-route',
          filter: onNetwork,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#0b3d91',
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 6, 20, 14],
            'line-opacity': 0.9,
          },
        });
        map.addLayer({
          id: 'nav-route-line', type: 'line', source: 'nav-route',
          filter: onNetwork,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#38bdf8',
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, 8],
          },
        });
        // The walk between somewhere unmapped -- a car park, wherever the
        // phone put you -- and the nearest mapped path. Dashed, because it is
        // a direction rather than a route: nobody has traced what is under
        // it, and drawn solid it read as an instruction to walk through
        // whatever buildings the straight line crosses.
        map.addLayer({
          id: 'nav-route-approach', type: 'line', source: 'nav-route',
          filter: ['==', ['get', 'approach'], 1],
          layout: { 'line-cap': 'butt', 'line-join': 'round' },
          paint: {
            'line-color': '#0b3d91',
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 2.5, 20, 6],
            'line-opacity': 0.75,
            'line-dasharray': [1.4, 1.6],
          },
        });
      }

      loadFavoriteMarkers();

      // Expose map + utils + navigation API
      const utils = {
        getJSON,
        asLines,
        geometryBounds,
        roughCenter,
        sortFloorsBottomFirst,
        pdfExists,
        filterExistingPDFs,
        buildPopupHTML
      };

      // the rest of the exports are published up front; utils only exists
      // once the layers it wraps have been added
      window.BCITMap.utils = utils;
      showClassBanner();

      // Run plugins
      const plugins = window.BCITMapPlugins || [];
      plugins.forEach((fn) => {
        try {
          fn(map, utils);
        } catch (err) {
          console.error('[BCIT MAP] Plugin error:', err);
        }
      });

      // Deep link from Favorites ("/map?building=SW3&floor=1&room=1615")
      // Deep links. ?building=&floor=&room= opens a place; adding ?from=&to=
      // opens the route between two rooms, so a set of directions can be
      // bookmarked or shared as a plain URL instead of only existing as the
      // result of clicking around.
      const params = new URLSearchParams(window.location.search);
      const linkBuilding = params.get('building');
      const linkFrom = params.get('from');
      const linkTo = params.get('to');

      if (linkFrom && linkTo) {
        const fromRef = parseRoomRef(linkFrom);
        const toRef = parseRoomRef(linkTo);
        const b = (linkBuilding || fromRef?.building || toRef?.building || '').trim();
        if (b && fromRef && toRef) {
          routeBetweenRooms(b, fromRef.room, toRef.room);
        }
      } else if (typeof window.BCITMap.focusRoom === 'function') {
        // ?room=SW3-1600 on its own is what the home page's search box sends,
        // so the building can come from the room reference itself rather than
        // making the caller split it up first.
        const linkRoom = params.get('room');
        const roomRef = linkRoom ? parseRoomRef(linkRoom) : null;
        const building = linkBuilding || roomRef?.building;
        if (building) {
          window.BCITMap.focusRoom({
            building,
            floor: params.get('floor') || undefined,
            room: roomRef?.room || undefined,
          });
        }
      }
    } catch (err) {
      console.error('map.load failed:', err);
    }
  });

  // A route used to be dismissed by clicking anywhere that was not the route
  // itself -- so a click to look at a room, or one that missed a building by
  // ten pixels, threw away directions that took a moment to ask for and gave
  // no sign of what had happened.
  //
  // Directions are now a place you are in, and you leave it deliberately:
  // "Back" on the card, or Escape. A click on the map is free to open
  // whatever it lands on, and the route stays drawn underneath -- looking at
  // a room along the way is part of following a route, not abandoning one.

});