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

  const roomIndexPromise = (async () => {
    try {
      const res = await fetch('/data/room-search-index.json', { cache: 'no-store' });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.rooms) ? json.rooms : [];
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

  const RECENTS_KEY = 'wayfindr.recentRooms';
  const RECENTS_MAX = 8;
  const recentKey = (r) => `${r.building}|${r.floor || ''}|${r.room}`;

  // localStorage throws outright in some privacy modes, so every access is
  // guarded -- a browser that can't remember recents should still get a
  // working sidebar.
  const readRecents = () => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENTS_KEY));
      return Array.isArray(v) ? v : [];
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
    const next = [rec, ...readRecents().filter((x) => recentKey(x) !== recentKey(rec))]
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

  // The nearest walking node to a point, so "directions from here" has
  // somewhere to start. Walking nodes come first because they sit on the
  // network; a room is only used when a floor has no nodes traced.
  const nearestNodeRoom = async (building, lngLat) => {
    if (!building || !lngLat) return null;
    let graph;
    try {
      graph = await getJSON('/data/nav-graph.json');
    } catch {
      return null;
    }
    // One flat network for the whole campus; a node's building is a label on
    // it rather than a bucket it lives in.
    const wanted = building.toUpperCase();
    const all = graph?.nodes || [];
    if (!all.length) return null;

    let best = null;
    let bestD = Infinity;
    for (const n of all) {
      if ((n.building || '').toUpperCase() !== wanted) continue;
      if (!n.room) continue; // an unlabelled node cannot be asked for by name
      const dx = (n.lng - lngLat.lng) * Math.cos((n.lat * Math.PI) / 180);
      const dy = n.lat - lngLat.lat;
      // a walking node beats a room at the same distance
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best ? { room: best.room, floor: best.floor } : null;
  };

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
      input.value = `${m.building}-${m.room}`;
      close();
      input.focus();
    };

    const render = () => {
      if (!matches.length) return close();
      box.innerHTML = matches.map((m, i) => `
        <button type="button" class="browse-suggest-row${i === active ? " is-active" : ""}" data-i="${i}">
          <span>${esc(m.building)}-${esc(m.room)}${m.name ? ` <em>${esc(m.name)}</em>` : ""}</span>
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
    const s = (raw || '').trim().toUpperCase();
    if (!s) return null;
    const m = s.match(/^([A-Z]+\d*)[-\s]+(\S.*)$/);
    return m ? { building: m[1], room: m[2].trim() } : { building: null, room: s };
  };

  // Drawn straight away rather than from the map's load handler: the panel
  // is a list of buildings and a form, none of which needs the map, and
  // waiting on tiles left the sidebar showing a bare hint the whole time
  // the basemap was still coming in.
  renderBrowse();

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

    const from = parseRoomRef(form.from.value);
    const to = parseRoomRef(form.to.value);
    if (!to) {
      showError('Enter a room to go to.');
      return false;
    }
    if (!from) {
      // No start given means "from where I am": the nearest point on the
      // walking network is a better answer than refusing to route.
      startFromNearest(to);
      return false;
    }
    const building = from.building || to.building;
    if (!building) {
      showError('Include the building code on at least one room, e.g. SW3-1600.');
      return false;
    }
    if (from.building && to.building && from.building !== to.building) {
      showError('Indoor routes are within a single building for now.');
      return false;
    }
    routeBetweenRooms(building, from.room, to.room);
    return false;
  };

  // "Get Directions" with only a destination: start from the nearest node to
  // wherever the user is, falling back to the middle of the view when the
  // browser has not given us a location.
  const startFromNearest = async (to) => {
    const errEl = document.getElementById('browse-directions-error');
    const building = to.building;
    if (!building) {
      if (errEl) {
        errEl.textContent = 'Include the building code on the room, e.g. SW3-1990.';
        errEl.hidden = false;
      }
      return;
    }
    // A start the user placed themselves wins; otherwise this is "from where
    // I am", so ask the browser rather than guessing from the viewport. The
    // map centre is the last resort, and says so.
    let here = customStartLocation;
    let label = customStartLabel || 'Selected Point';
    if (!here) {
      if (errEl) {
        errEl.textContent = 'Finding Your Location…';
        errEl.hidden = false;
      }
      here = await requestUserLocation();
      label = 'Your Location';
    }
    if (!here) {
      here = { lng: map.getCenter().lng, lat: map.getCenter().lat };
      label = 'Nearest Point';
    }
    if (errEl) errEl.hidden = true;

    const near = await nearestNodeRoom(building, here);
    if (!near) {
      if (errEl) {
        errEl.textContent = `No walking network mapped for ${building} yet.`;
        errEl.hidden = false;
      }
      return;
    }
    const form = document.querySelector('.browse-directions');
    if (form) form.from.value = `${building}-${near.room}`;
    routeBetweenRooms(building, near.room, to.room,
      { fromLabel: `${label} · ${near.room}` });
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

  let navActive = false;
  let startMarker = null;
  let endMarker = null;
  let customStartLocation = null;
  let customStartLabel = null;
  let customStartMarker = null;

  function makeRoomLabel(building, floor, room) {
    const b = String(building || '').trim();
    const f = String(floor || '').trim();
    const r = String(room || '').trim();
    let pureRoom = r;
    if (b && r.startsWith(b + '-')) pureRoom = r.slice(b.length + 1);
    if (b && pureRoom) return `${b} · ${pureRoom}`;
    if (b && f) return `${b} · Floor ${f}`;
    if (b) return b;
    if (pureRoom) return pureRoom;
    return 'Selected point';
  }

  // Renders the sidebar's directions view: endpoints, and once the route is
  // back, distance + a room-by-room step list (grouped by floor).
  const renderDirectionsCard = ({ fromLabel, toLabel, path, distanceM, message }) => {
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
        const gap = i > 0 ? metresBetween(path[i - 1], p) : 0;
        const space = p.room || null;
        const last = legs[legs.length - 1];
        if (last && last.space === space && last.floor === p.floor) {
          last.metres += gap;
          last.end = p;
        } else {
          legs.push({
            space, name: p.name || null, floor: p.floor, metres: gap,
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
      const named = (leg) => {
        if (leg.space && leg.name) return `${leg.space} (${leg.name})`;
        if (leg.space) return leg.space;
        if (leg.name) return leg.name;
        return leg.type === 'stairs' ? 'the stairs'
          : leg.type === 'elevator' ? 'the lift' : 'the hallway';
      };

      let lastFloor = null;
      legs.forEach((leg, i) => {
        if (leg.floor !== lastFloor) {
          push(`Floor ${leg.floor}`, 'floor-heading');
          lastFloor = leg.floor;
        }
        const isLast = i === legs.length - 1;
        if (i === 0) {
          push(`Start at ${named(leg)}`);
          // You can walk a long way before reaching anything worth naming --
          // 52 m along the corridor you started in was being left out of the
          // steps entirely.
          const out = Math.round(leg.metres);
          if (out >= 1 && !isLast) push(`Follow ${named(leg)} for ${out} m`);
          return;
        }
        if (isLast) {
          push(`Arrive at ${named(leg)}`);
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
    navActive = false;
    if (startMarker) { startMarker.remove(); startMarker = null; }
    if (endMarker) { endMarker.remove(); endMarker = null; }

    const navSrc = map.getSource('nav-route');
    if (navSrc) navSrc.setData({ type: 'FeatureCollection', features: [] });
  };

  const clearNavigation = () => {
    clearRouteOverlay();
    sidebar.reset();
  };

  const clearCustomStart = () => { customStartLocation = null; customStartLabel = null; if (customStartMarker) { customStartMarker.remove(); customStartMarker = null; } };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearNavigation(); });

  // const setRouteLine = (startLngLat, endLngLat) => {
  //   const navSrc = map.getSource('nav-route');
  //   if (!navSrc) return;
  //   navSrc.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [startLngLat, endLngLat] } }] });
  // };

  const setCustomStartLocation = (lng, lat, label) => {
    if (typeof lng !== 'number' || typeof lat !== 'number') return;
    customStartLocation = { lng, lat };
    customStartLabel = label || 'Selected point';
    if (customStartMarker) customStartMarker.setLngLat([lng, lat]);
    else customStartMarker = new mapboxgl.Marker({ color: '#16a34a' }).setLngLat([lng, lat]).addTo(map);
  };

  const setStartFromRoom = (payload) => { if (!payload) return; const lng = typeof payload.lng === 'number' ? payload.lng : null; const lat = typeof payload.lat === 'number' ? payload.lat : null; if (lng == null || lat == null) return; const label = makeRoomLabel((payload.building || '').trim(), (payload.floor || '').trim(), (payload.room || '').trim()); setCustomStartLocation(lng, lat, label); };

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
    for (const id of ['nav-route-casing', 'nav-route-line']) {
      if (map.getLayer(id)) map.moveLayer(id, above);
    }

    // Draw only the walking network. The first and last points of a route are
    // the rooms themselves, whose position is the middle of the room -- so
    // including them drew a diagonal from the centre of a room out to the
    // node serving it, cutting across whatever lay between. The markers show
    // where the route starts and ends; the line follows the nodes.
    // Every point on a route is a network node -- rooms are labels on nodes,
    // not places the route passes through -- so there is nothing to filter.
    const network = path;
    const coords = (network.length >= 2 ? network : path).map((p) => [p.lng, p.lat]);
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
    });
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
   * Route between two rooms named by number, with no prior map interaction.
   * Backs the sidebar's directions form, the /map?from=&to= deep link and
   * the Route Finder page's hand-off, so all three behave identically.
   */
  const routeBetweenRooms = async (building, fromRoom, toRoom, opts = {}) => {
    const b = (building || '').trim().toUpperCase();
    const from = (fromRoom || '').trim();
    const to = (toRoom || '').trim();
    if (!b || !from || !to) return;

    clearNavigation();
    navActive = true;
    // A start the user did not type is theirs, not a room number they have to
    // recognise, so the caller can say what to call it.
    const fromLabel = opts.fromLabel || makeRoomLabel(b, '', from);
    const toLabel = makeRoomLabel(b, '', to);
    renderDirectionsCard({ fromLabel, toLabel });
    await requestAndOverlayIndoorPath(b, from, b, to, fromLabel, toLabel, { fit: true });
    rememberRoom({ building: b, room: to });
  };

  async function requestAndOverlayIndoorPath(startBuildingCode, startRoomOrEntrance, goalBuildingCode, goalRoom, fromLabel, toLabel, { fit = false } = {}) {
    if (isOverlayingIndoor) {
      console.log('[INDOOR] overlay in progress, skipping');
      return;
    }
    isOverlayingIndoor = true;
    try {
      const payload = {
        building: goalBuildingCode.toUpperCase(),
        startRoom: startRoomOrEntrance,
        goalRoom,
      };
      const response = await fetch('/find-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.success) {
        console.warn('[INDOOR PATH]', result?.message || response.statusText);
        renderDirectionsCard({ fromLabel, toLabel, message: result?.message || 'Indoor route not available for this building yet.' });
        return;
      }

      // Awaited, not fired off: focusRoom draws the building card into the
      // same sidebar, and since it now waits on the room index it finishes
      // AFTER this function would otherwise have drawn the directions --
      // wiping the route out from under the user and leaving them looking at
      // a plain building card they did not ask for.
      const goalFloor = result.path[result.path.length - 1]?.floor || '1';
      if (window.BCITMap && typeof window.BCITMap.focusRoom === 'function') {
        await window.BCITMap.focusRoom({
          building: goalBuildingCode.toUpperCase(), floor: goalFloor,
        });
      }

      renderIndoorPath(result.path, { fit });
      renderDirectionsCard({ fromLabel, toLabel, path: result.path, distanceM: result.distanceM });
    } catch (error) {
      console.error('[INDOOR PATH ERROR]:', error);
      renderDirectionsCard({ fromLabel, toLabel, message: 'Something went wrong finding that route.' });
    } finally {
      isOverlayingIndoor = false;
    }
  }


  // "Directions" on a room card. The outdoor leg used to be a separate
  // proof-of-concept graph of hand-entered campus nodes, which drew its own
  // blue line across the map and handed off to an entrance; the route people
  // actually want is the indoor one, from wherever they are standing to the
  // room, so this now asks the same router the directions form does.
  const navigateToRoom = async (payload) => {
    if (!payload) return;
    const b = (payload.building || '').trim().toUpperCase();
    const r = (payload.room || '').trim();
    if (!b || !r) {
      console.warn('[BCIT MAP] navigateToRoom needs a building and a room.');
      return;
    }

    // "Start Here" on another room card sets a start inside this building,
    // and that is a room number the router can use directly.
    const startedInside = customStartLabel
      && customStartLabel.toUpperCase().startsWith(b);
    if (startedInside) {
      const parts = customStartLabel.split(' \u00b7 ');
      const startRoom = parts.length > 1 ? parts[parts.length - 1] : null;
      if (startRoom && startRoom !== r) {
        routeBetweenRooms(b, startRoom, r, { fromLabel: customStartLabel });
        return;
      }
    }

    startFromNearest({ building: b, room: r });
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
    setCustomStartLocation,
    clearCustomStart,
    setStartFromRoom,
    toggleFavoriteRoom,
    routeBetweenRooms,
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

      map.addSource('buildings', { type: 'geojson', data: buildings });
      map.addLayer({ id: 'buildings-fill', type: 'fill', source: 'buildings', paint: { 'fill-color': '#93c5fd', 'fill-opacity': 0.35 } });
      map.addLayer({ id: 'buildings-line', type: 'line', source: 'buildings', paint: { 'line-color': '#2563eb', 'line-width': 1.2 } });

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
        map.addLayer({
          id: 'nav-route-casing', type: 'line', source: 'nav-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#0b3d91',
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 6, 20, 14],
            'line-opacity': 0.9,
          },
        });
        map.addLayer({
          id: 'nav-route-line', type: 'line', source: 'nav-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#38bdf8',
            'line-width': ['interpolate', ['linear'], ['zoom'], 15, 3, 20, 8],
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

  map.on('click', (e) => {
    if (!navActive) return;

    // Query features in the layer that displays the calculated outdoor/indoor route
    const features = map.queryRenderedFeatures(e.point, { layers: ['nav-route-line'] });
    if (features && features.length > 0) return; // clicked on the route itself

    clearNavigation();
  });

});