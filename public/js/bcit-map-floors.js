// public/js/bcit-map-floors.js
(function () {
  window.BCITMapPlugins = window.BCITMapPlugins || [];
  window.BCITMapPlugins.push(function attachBuildingFloors(map, utils) {
    const { getJSON, geometryBounds, sortFloorsBottomFirst, roughCenter } =
      utils;

    const FLOOR_SRC = "building-floor";
    const FLOOR_FILL_LAYER = "building-floor-fill";
    const FLOOR_ICON_LAYER = "building-floor-icon";
    const FLOOR_LINE_LAYER = "building-floor-line";

    const SEL_SRC = "building-selected";
    const SEL_LAYER = "building-selected-line";

    const ROOM_SEL_SRC = "room-selected";
    const ROOM_SEL_FILL_LAYER = "room-selected-fill";
    const ROOM_SEL_LINE_LAYER = "room-selected-line";

    let currentBuildingCode = null;
    let currentBuildingLabel = null;
    let currentFloorLabel = "1";
    let currentFloorList = ["1"];

    // Floors derived from room-search-index.json
    // Shape: { "SW3": ["1","2"], ... }
    let roomFloorsIndex = {};
    // "SW3|1" -> [{room, type}, ...] so the building card can list the rooms
    // on whichever floor is currently selected
    let roomsByBuildingFloor = {};

    // Awaited by focusRoom, not just fired and forgotten: a deep link
    // (/map?room=SW3-1615) opens a building the instant the map loads, which
    // can be before this resolves -- and then the card was built from the
    // building's own properties alone and claimed SW3 had one floor and no
    // rooms. Reuses the core script's request rather than issuing a third one.
    const roomFloorsReady = (async function loadRoomFloorsIndex() {
      try {
        const rooms = await (window.__ROOM_INDEX_PROMISE__ ||
          fetch("/data/room-search-index.json", { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : { rooms: [] }))
            .then((json) => json.rooms));
        const byBuilding = {};

        if (Array.isArray(rooms)) {
          for (const r of rooms) {
            const b = (r.building || "").trim().toUpperCase();
            const f = (r.floor || "").trim();
            if (!b || !f) continue;
            if (!byBuilding[b]) byBuilding[b] = new Set();
            byBuilding[b].add(f);

            const key = `${b}|${f}`;
            (roomsByBuildingFloor[key] = roomsByBuildingFloor[key] || []).push({
              room: r.room,
              // rooms are known by what they are as much as by their number
              name: r.name || null,
              type: r.type || "room",
            });
          }
        }

        roomFloorsIndex = {};
        Object.keys(byBuilding).forEach((b) => {
          roomFloorsIndex[b] = Array.from(byBuilding[b]);
        });

        // natural sort so 2, 10, 100 order correctly rather than 10, 100, 2
        Object.values(roomsByBuildingFloor).forEach((list) =>
          list.sort((a, b) =>
            String(a.room).localeCompare(String(b.room), undefined, { numeric: true })
          )
        );

        // the card may already be open when this resolves
        if (currentBuildingCode) renderFloorPanel();
      } catch {
        // fail silently; floorLabels on building props will still work
      }
    })();

    // ---------------- Selected-building highlight ----------------
    function ensureSelectedLayer() {
      if (!map.getSource(SEL_SRC)) {
        map.addSource(SEL_SRC, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer(SEL_LAYER)) {
        map.addLayer({
          id: SEL_LAYER,
          type: "line",
          source: SEL_SRC,
          paint: {
            "line-color": "#f59e0b",
            "line-width": 3,
          },
        });
      }

      // Keep highlight above floor outlines if possible
      if (map.getLayer(FLOOR_LINE_LAYER)) {
        map.moveLayer(SEL_LAYER, FLOOR_LINE_LAYER);
      }
    }

    // ---------------- Selected-room highlight ----------------
    function ensureRoomSelectedLayers() {
      if (!map.getSource(ROOM_SEL_SRC)) {
        map.addSource(ROOM_SEL_SRC, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer(ROOM_SEL_FILL_LAYER)) {
        map.addLayer({
          id: ROOM_SEL_FILL_LAYER,
          type: "fill",
          source: ROOM_SEL_SRC,
          paint: {
            "fill-color": "#facc15", // bright yellow
            "fill-opacity": 0.85,
          },
        });
      }

      if (!map.getLayer(ROOM_SEL_LINE_LAYER)) {
        map.addLayer({
          id: ROOM_SEL_LINE_LAYER,
          type: "line",
          source: ROOM_SEL_SRC,
          paint: {
            "line-color": "#d97706", // strong orange outline
            "line-width": 3,
          },
        });
      }

      // Order: base floors -> floor outline -> building highlight -> selected room
      if (map.getLayer(SEL_LAYER)) {
        map.moveLayer(ROOM_SEL_FILL_LAYER, SEL_LAYER);
        map.moveLayer(ROOM_SEL_LINE_LAYER, ROOM_SEL_FILL_LAYER);
      } else if (map.getLayer(FLOOR_LINE_LAYER)) {
        map.moveLayer(ROOM_SEL_FILL_LAYER, FLOOR_LINE_LAYER);
        map.moveLayer(ROOM_SEL_LINE_LAYER, ROOM_SEL_FILL_LAYER);
      }
    }

    function clearSelectedRoom() {
      const src = map.getSource(ROOM_SEL_SRC);
      if (src) {
        src.setData({ type: "FeatureCollection", features: [] });
      }
    }

    // ---------------- Building card (sidebar): name + floor selector ----------------
    const mapContainer = document.getElementById("map");
    if (mapContainer && getComputedStyle(mapContainer).position === "static") {
      mapContainer.style.position = "relative";
    }
    const sidebar = () => window.BCITMap && window.BCITMap.sidebar;

    const renderFloorPanel = () => {
      const sb = sidebar();
      if (!sb) return;
      if (
        !currentBuildingCode ||
        !currentFloorList ||
        !currentFloorList.length
      ) {
        sb.reset();
        return;
      }

      const title = currentBuildingLabel || currentBuildingCode;

      const buttonsHtml = currentFloorList
        .map((fl) => {
          const active = fl === currentFloorLabel;
          return `<button type="button" class="floor-pill${active ? " active" : ""}" data-floor="${fl}">${fl}</button>`;
        })
        .join("");

      // rooms on the floor that's currently selected
      const key = `${currentBuildingCode.toUpperCase()}|${currentFloorLabel}`;
      const roomsHere = (roomsByBuildingFloor[key] || [])
        .filter((r) => isDestinationType(r.type));
      const typeIcon = { stairs: "🪜", corridor: "↔", door: "🚪" };
      // hand-calibrated files store the room as "SW3-1602" while generated
      // ones store the bare number -- show just the number either way
      const bare = (name) =>
        String(name).replace(
          new RegExp(`^${currentBuildingCode.toUpperCase()}-`, "i"),
          ""
        );
      const roomsHtml = roomsHere.length
        ? `<ul class="room-list">${roomsHere
            .map(
              (r) =>
                `<li><button type="button" class="room-row" data-room="${r.room}">
                   <span class="room-row-name">${bare(r.room)}${r.name ? `<em>${r.name}</em>` : ""}</span>
                   <span class="room-row-type">${typeIcon[r.type] || ""}</span>
                 </button></li>`
            )
            .join("")}</ul>`
        : `<p class="sidebar-hint">No rooms mapped on this floor yet.</p>`;

      sb.setBody(`
        <div class="place-card">
          <button type="button" class="sidebar-back"
                  onclick="window.BCITMap && window.BCITMap.leaveBuilding && window.BCITMap.leaveBuilding();">&larr; All Buildings</button>
          <h2>${title}</h2>
          <div class="place-sub">Building</div>
          <div class="place-actions">
            <button type="button" class="btn-primary"
              onclick="window.BCITMap && window.BCITMap.routeToBuilding && window.BCITMap.routeToBuilding('${currentBuildingCode}');">
              Directions
            </button>
          </div>
          <div class="floor-pills">${buttonsHtml}</div>
          <div class="room-list-header">
            Rooms on Floor ${currentFloorLabel}${roomsHere.length ? ` (${roomsHere.length})` : ""}
          </div>
          ${roomsHtml}
        </div>
      `);

      const el = sb.el();
      if (el) {
        el.querySelectorAll("button[data-floor]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const floor = btn.getAttribute("data-floor");
            if (!floor || floor === currentFloorLabel) return;
            currentFloorLabel = floor;
            if (currentBuildingCode) {
              showBuildingFloor(currentBuildingCode, currentFloorLabel);
            }
            clearSelectedRoom();
            renderFloorPanel();
          });
        });

        el.querySelectorAll("button[data-room]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const room = btn.getAttribute("data-room");
            if (!room) return;
            window.BCITMap.focusRoom({
              building: currentBuildingCode,
              floor: currentFloorLabel,
              room,
            });
          });
        });
      }
    };

    /**
     * A colour per kind of space.
     *
     * Warm means somewhere you can be sent; everything else is cooler and
     * sits back. Beyond that the point is telling them apart at a glance: a
     * stairwell should not have to be read to be recognised. Kept in one
     * table so the fill, the outline and anything added later cannot drift
     * apart.
     */
    const SPACE_COLOURS = {
      room:     { fill: "#fb923c", line: "#b91c1c", opacity: 0.65 },
      hallway:  { fill: "#cbd5e1", line: "#94a3b8", opacity: 0.5 },
      service:  { fill: "#a8a29e", line: "#78716c", opacity: 0.45 },
      stairs:   { fill: "#6ee7b7", line: "#059669", opacity: 0.7 },
      elevator: { fill: "#c4b5fd", line: "#7c3aed", opacity: 0.7 },
    };
    const DEFAULT_SPACE = SPACE_COLOURS.room;

    /** A Mapbox match expression over the table above. */
    const byType = (field) => [
      "match", ["get", "type"],
      ...Object.entries(SPACE_COLOURS).flatMap(([type, c]) => [type, c[field]]),
      DEFAULT_SPACE[field],
    ];

    // ---------------- Stairs and lift icons ----------------
    //
    // A stairwell and a lift are the two things on a floor plan you look for
    // by shape rather than by reading a label, so they get a pictogram. Drawn
    // here rather than loaded as files: two small SVGs cost nothing to
    // rasterise and the map never has to wait on a request that might fail.
    const ICON_PX = 44;   // drawn at 2x and declared as such, so it stays crisp

    const ICON_SVG = {
      "icon-stairs": `
        <rect x="1" y="1" width="42" height="42" rx="11" fill="#ffffff"
              stroke="#94a3b8" stroke-width="2"/>
        <path d="M11 32h6v-6h6v-6h6v-6h6" fill="none" stroke="#1e293b"
              stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M11 32v-0.5M35 14h-0.5" stroke="#1e293b" stroke-width="3"
              stroke-linecap="round"/>`,
      "icon-elevator": `
        <rect x="1" y="1" width="42" height="42" rx="11" fill="#ffffff"
              stroke="#94a3b8" stroke-width="2"/>
        <rect x="13" y="11" width="18" height="22" rx="2.5" fill="none"
              stroke="#1e293b" stroke-width="3"/>
        <path d="M22 11v22" stroke="#1e293b" stroke-width="2"/>
        <path d="M17.5 20l-2.5-3 2.5-3M26.5 24l2.5 3 2.5-3" fill="none"
              stroke="#1e293b" stroke-width="2" stroke-linecap="round"
              stroke-linejoin="round"/>`,
      // One symbol for a washroom rather than two: which one it is, the name
      // says -- and it shows under the icon as soon as you are close enough
      // to be choosing between them.
      "icon-washroom": `
        <rect x="1" y="1" width="42" height="42" rx="11" fill="#ffffff"
              stroke="#94a3b8" stroke-width="2"/>
        <circle cx="16" cy="13" r="3" fill="#1e293b"/>
        <path d="M13 19h6l1.5 8h-2.5l-0.5 6h-2.5l-0.5-6h-2.5z" fill="#1e293b"/>
        <circle cx="29" cy="13" r="3" fill="#1e293b"/>
        <path d="M29 18c3 0 4 2 4 5v4h-2.5l-0.5 6h-2.5l-0.5-6h-2.5v-4c0-3 1-5 4-5z"
              fill="#1e293b"/>`,
    };

    const addFloorIcons = () => {
      for (const [name, body] of Object.entries(ICON_SVG)) {
        if (map.hasImage(name)) continue;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}"`
          + ` height="${ICON_PX}" viewBox="0 0 ${ICON_PX} ${ICON_PX}">${body}</svg>`;
        const img = new Image(ICON_PX, ICON_PX);
        img.onload = () => {
          // the style can be swapped between the request and the load, so
          // check again rather than throwing "image already exists"
          if (!map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 });
        };
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }
    };
    addFloorIcons();

    // ---------------- Floor source / layers ----------------
    if (!map.getSource(FLOOR_SRC)) {
      map.addSource(FLOOR_SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Rooms are the warm colour because rooms are what you are looking for.
      // A hallway is drawn in a cool grey and sits back: you can see how the
      // floor joins up without it competing with the places you can go, and
      // the difference in colour is the difference in what clicking does.
      map.addLayer({
        id: FLOOR_FILL_LAYER,
        type: "fill",
        source: FLOOR_SRC,
        paint: {
          "fill-color": byType("fill"),
          "fill-opacity": byType("opacity"),
        },
      });

      map.addLayer({
        id: FLOOR_LINE_LAYER,
        type: "line",
        source: FLOOR_SRC,
        paint: {
          "line-color": byType("line"),
          "line-width": [
            "match", ["get", "type"],
            "hallway", 1,
            "service", 1,
            1.4,
          ],
        },
      });

      // Stairs and lifts, marked where they are. The name comes in once you
      // are close enough for it to be worth reading -- "NW Stairs" is only
      // useful when you are choosing between two of them.
      map.addLayer({
        id: FLOOR_ICON_LAYER,
        type: "symbol",
        source: FLOOR_SRC,
        filter: ["has", "icon"],
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 16, 0.45, 19, 0.85],
          // a stairwell is where it is; hiding it to avoid a label collision
          // would be hiding the thing people are looking for
          "icon-allow-overlap": true,
          "text-field": ["step", ["zoom"], "", 18.5, ["coalesce", ["get", "name"], ""]],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": "#1e293b",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });
    }

    // Ensure highlight layers exist
    ensureSelectedLayer();
    ensureRoomSelectedLayers();

    const clearFloorView = () => {
      currentBuildingCode = null;
      currentBuildingLabel = null;
      currentFloorLabel = "1";
      currentFloorList = ["1"];

      if (map.getLayer("buildings-fill")) {
        map.setFilter("buildings-fill", null);
      }
      if (map.getLayer("buildings-line")) {
        map.setFilter("buildings-line", null);
      }

      const floorSrc = map.getSource(FLOOR_SRC);
      if (floorSrc) {
        floorSrc.setData({ type: "FeatureCollection", features: [] });
      }

      const sel = map.getSource(SEL_SRC);
      if (sel) {
        sel.setData({ type: "FeatureCollection", features: [] });
      }

      clearSelectedRoom();
      renderFloorPanel();
    };

    // Decide floor labels for a building:
    // 1) from room-search-index.json (roomFloorsIndex)
    // 2) fallback to building properties.floorLabels
    // 3) finally, ["1"] so there is at least one button
    function deriveFloorLabels(buildingCode, props) {
      const codeUpper = String(buildingCode || "")
        .trim()
        .toUpperCase();
      let labels = null;

      const fromIndex = codeUpper && roomFloorsIndex[codeUpper];
      if (fromIndex && fromIndex.length) {
        labels = fromIndex.map(String);
      } else if (Array.isArray(props.floorLabels) && props.floorLabels.length) {
        labels = props.floorLabels.map(String);
      } else {
        labels = ["1"];
      }

      return sortFloorsBottomFirst(labels);
    }

    const hideBuildingShape = (buildingFeature) => {
      const p = buildingFeature.properties || {};
      const code = (
        p.BuildingName ||
        p.Display_Name ||
        p.SiteName ||
        ""
      ).trim();
      if (!code) return;

      const filter = [
        "all",
        [
          "!=",
          [
            "coalesce",
            ["get", "BuildingName"],
            ["get", "Display_Name"],
            ["get", "SiteName"],
          ],
          code,
        ],
      ];

      if (map.getLayer("buildings-fill")) {
        map.setFilter("buildings-fill", filter);
      }
      if (map.getLayer("buildings-line")) {
        map.setFilter("buildings-line", filter);
      }
    };

    // Walking nodes and the links between them exist to be routed over, not
    // looked at. They are stored in the same floor file as the rooms, so they
    // are filtered out here rather than at the source.
    const NETWORK_TYPES = new Set(["node", "path"]);
    const isNetwork = (f) => NETWORK_TYPES.has(f?.properties?.type);

    // Which pictogram, if any, a space gets. Held on the feature rather than
    // worked out in a style expression so the rule reads in one place. Two
    // sources: what a space IS (stairs, a lift) and what it OFFERS (a
    // washroom, which is an ordinary room as far as routing is concerned).
    const ICON_FOR_TYPE = { stairs: "icon-stairs", elevator: "icon-elevator" };
    const ICON_FOR_AMENITY = { washroom: "icon-washroom" };
    const iconFor = (props) =>
      ICON_FOR_TYPE[String(props?.type || "").toLowerCase()]
      || ICON_FOR_AMENITY[String(props?.amenity || "").toLowerCase()]
      || null;

    const withoutNetwork = (fc) => ({
      type: "FeatureCollection",
      features: (fc?.features || [])
        .filter((f) => !isNetwork(f)
          && f.geometry?.type === "Polygon"
          && !NOT_DRAWN.has(String(f.properties?.type || "room").toLowerCase()))
        .map((f) => {
          const icon = iconFor(f.properties);
          return icon
            ? { ...f, properties: { ...f.properties, icon } }
            : f;
        }),
    });

    const showBuildingFloor = async (buildingCode, floorLabel) => {
      const code = (buildingCode || "").trim();
      const fl = (floorLabel || "1").trim();
      if (!code) return;

      const url = `/data/floor-coordinates/${encodeURIComponent(
        code
      )}-Floor${fl}.geojson`;

      try {
        const data = await getJSON(url);
        const src = map.getSource(FLOOR_SRC);
        // The walking network is scaffolding for the router, not part of the
        // building: drawing its nodes and links put a web of lines across
        // every room. It is rendered only when a route is being shown.
        if (src) src.setData(withoutNetwork(data));
      } catch (err) {
        // A building nobody has traced yet has no sheet, and that is an
        // ordinary state of affairs rather than a fault -- most of the campus
        // is in it. Clear whatever floor was showing and say nothing.
        const src = map.getSource(FLOOR_SRC);
        if (src) src.setData({ type: "FeatureCollection", features: [] });
        if (!/404/.test(String(err && err.message))) {
          console.error("[BCIT MAP] Failed to load floor coordinates:", url, err);
        }
      }
    };

    const zoomToFeatureGeom = (feat, padding = 40, maxZoom = 20) => {
      const bounds = geometryBounds(feat.geometry);
      if (bounds) {
        map.fitBounds(bounds, { padding, maxZoom, duration: 500 });
      }
    };

    // Google-Maps-style "place card" for a room/stairs/corridor, rendered
    // into the sidebar (replaces the old small map popup bubble).
    const buildRoomCardHTML = (props, lngLatPayload) => {
      const room = props.room || props.Room || props.name || props.id || "Room";
      // The number is the address and the name is what it is; both belong on
      // the card, and the name was being shown only when there was no number.
      const spaceName = props.room && props.name ? String(props.name) : "";
      const building =
        props.building || props.Building || props.BuildingName || "";
      const floor = props.floor || props.Floor || "";

      const rawType = (props.type || props.Type || "").toLowerCase();
      let typeLabel = "";
      if (rawType === "stairs") typeLabel = "Stairs";
      else if (rawType === "corridor") typeLabel = "Corridor";
      else if (rawType === "room") typeLabel = "Room";

      const navPayload = {
        building: String(building || "").trim(),
        floor: String(floor || "").trim(),
        room: String(room || "").trim(),
        type: rawType || "room",
        ...lngLatPayload, // { lng, lat } from the room shape center
      };
      const payloadStr = JSON.stringify(navPayload).replace(/"/g, "&quot;");

      const labelParts = [building, floor ? `Floor ${floor}` : "", typeLabel]
        .filter(Boolean);
      const subtitle = labelParts.join(" · ");

      return `
        <div class="place-card">
          <button type="button" class="sidebar-back" onclick="window.BCITMap && window.BCITMap.backToBuilding && window.BCITMap.backToBuilding();">&larr; Back</button>
          <h2>${room}</h2>
          ${spaceName ? `<div class="place-name">${spaceName}</div>` : ""}
          <div class="place-sub">${subtitle}</div>
          <div class="place-actions">
            <button
              type="button" class="btn-primary"
              onclick="window.BCITMap && window.BCITMap.navigateToRoom && window.BCITMap.navigateToRoom(${payloadStr});">
              Directions
            </button>
            <button
              type="button" class="btn-secondary"
              onclick="window.BCITMap && window.BCITMap.setStartFromRoom && window.BCITMap.setStartFromRoom(${payloadStr});">
              Start Here
            </button>
            <button
              type="button" class="btn-icon${window.__SIGNED_IN__ ? "" : " is-signed-out"}"
              aria-label="${window.__SIGNED_IN__ ? "Save to favourites" : "Log in to save favourites"}"
              title="${window.__SIGNED_IN__ ? "Save to favourites" : "Log in to save favourites"}"
              onclick="window.BCITMap && window.BCITMap.toggleFavoriteRoom && window.BCITMap.toggleFavoriteRoom(${payloadStr});">
              ☆
            </button>
          </div>
        </div>
      `;
    };

    // A corridor is how you get somewhere, not somewhere to get to, and a
    // riser shaft or a janitor's cupboard is not a destination either. They
    // are drawn -- you need to see the shape of the floor -- but they are not
    // offered as places, so clicking one does nothing and the room lists
    // leave them out.
    // A room is somewhere you can be sent. Everything else -- the hallway you
    // walk along, the stairwell you pass through, the riser cupboard -- is
    // part of the floor without being a place to go.
    const isDestinationType = (type) =>
      String(type || "room").toLowerCase() === "room";
    // Only the network is left out of the drawing. A hallway is drawn, in its
    // own colour: it is the shape of how the floor connects, and leaving it
    // blank made the rooms look like islands. It is not a place you can be
    // sent, so it is not clickable either -- see isDestinationType.
    const NOT_DRAWN = new Set(["node", "path"]);
    const showRoomPopupForFeature = (feat, lngLatFallback) => {
      // center as [lng, lat]
      const centerFromGeom = roughCenter(feat.geometry);
      const centerFromClick =
        lngLatFallback && typeof lngLatFallback.lng === "number"
          ? [lngLatFallback.lng, lngLatFallback.lat]
          : null;

      const center = centerFromGeom || centerFromClick;
      if (!center) return;

      const props = feat.properties || {};
      const lngLatPayload = { lng: center[0], lat: center[1] };
      const html = buildRoomCardHTML(props, lngLatPayload);

      // A room card that is a name and three buttons leaves most of the panel
      // blank, and gives you nothing to do next. The rest of the floor is the
      // obvious thing to offer, so the other rooms follow underneath.
      const key = `${(props.building || currentBuildingCode || "").toUpperCase()}|${props.floor || currentFloorLabel}`;
      const siblings = (roomsByBuildingFloor[key] || [])
        .filter((r) => isDestinationType(r.type))
        .filter((r) => String(r.room) !== String(props.room));
      const othersHtml = siblings.length
        ? `<div class="room-list-header">Also on floor ${props.floor || currentFloorLabel}</div>
           <ul class="room-list">${siblings.map((r) => `
             <li><button type="button" class="room-row" data-room="${r.room}">
               <span class="room-row-name">${String(r.room).replace(
    new RegExp(`^${(props.building || currentBuildingCode || "").toUpperCase()}-`, "i"), "")}${r.name ? `<em>${r.name}</em>` : ""}</span>
               <span class="room-row-type">${r.type === "room" ? "" : r.type}</span>
             </button></li>`).join("")}</ul>`
        : "";

      // opening a room is leaving the directions view, so the route that was
      // drawn for it should not stay lying across the plan
      if (window.BCITMap?.clearRouteOverlay) window.BCITMap.clearRouteOverlay();

      const sb = window.BCITMap && window.BCITMap.sidebar;
      if (sb) sb.setBody(html + othersHtml);

      // the other rooms are clickable, same as on the building card
      const panel = sb && sb.el();
      if (panel) {
        panel.querySelectorAll(".room-row[data-room]").forEach((btn) => {
          btn.addEventListener("click", () => {
            window.BCITMap.focusRoom({
              building: props.building || currentBuildingCode,
              floor: props.floor || currentFloorLabel,
              room: btn.getAttribute("data-room"),
            });
          });
        });
      }

      // feeds the sidebar's "Recent" list, so getting back to a room you
      // just looked at doesn't mean searching for it again
      if (props.room && window.BCITMap && window.BCITMap.rememberRoom) {
        window.BCITMap.rememberRoom({
          building: props.building || currentBuildingCode,
          floor: props.floor || currentFloorLabel,
          room: props.room,
        });
      }
    };


    // ESC → clear overlay
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        clearFloorView();
      }
    });

    // ---------------- Room click → zoom + popup + highlight ----------------
    map.on("click", FLOOR_FILL_LAYER, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      // clicking the corridor you are looking at should not offer to take you
      // to it, so it falls through as though the floor itself was clicked
      if (!isDestinationType(f.properties?.type)) return;

      zoomToFeatureGeom(f, 40, 20);
      showRoomPopupForFeature(f, e.lngLat);

      // Highlight just this room
      ensureRoomSelectedLayers();
      const src = map.getSource(ROOM_SEL_SRC);
      if (src) {
        src.setData({
          type: "FeatureCollection",
          features: [f],
        });
      }
    });

    // ---------------- Building click → floors + highlight ----------------
    map.on("click", "buildings-fill", async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};

      const buildingCode = (
        p.BuildingName ||
        p.Display_Name ||
        p.SiteName ||
        p.BldgCode ||
        p.code ||
        ""
      ).trim();
      if (!buildingCode) return;

      // Clicking same building toggles off
      if (currentBuildingCode && currentBuildingCode === buildingCode) {
        clearFloorView();
        return;
      }

      clearFloorView();
      currentBuildingCode = buildingCode;
      currentBuildingLabel =
        p.BuildingName || p.Display_Name || p.SiteName || buildingCode;

      // Floors: auto from room index, then props.floorLabels, else ["1"]
      let floorLabels = deriveFloorLabels(buildingCode, p);
      currentFloorList = floorLabels;
      currentFloorLabel = floorLabels[0] || "1";

      renderFloorPanel();

      // Highlight ALL polygons for this building
      ensureSelectedLayer();
      const selSrc = map.getSource(SEL_SRC);
      if (selSrc) {
        const buildingsSrc = map.getSource("buildings");
        const buildingsData = buildingsSrc && buildingsSrc._data;

        let features = [f];
        if (buildingsData && buildingsData.features) {
          const codeUpper = currentBuildingCode.toUpperCase();
          features = buildingsData.features.filter((ft) => {
            const bp = ft.properties || {};
            const candidates = [
              bp.BuildingName,
              bp.Display_Name,
              bp.SiteName,
              bp.name,
              bp.BldgCode,
              bp.code,
            ]
              .filter(Boolean)
              .map((s) => String(s).toUpperCase());
            return candidates.includes(codeUpper);
          });
          if (!features.length) features = [f];
        }

        selSrc.setData({
          type: "FeatureCollection",
          features,
        });
      }

      hideBuildingShape(f);
      await showBuildingFloor(buildingCode, currentFloorLabel);

      const bounds = geometryBounds(f.geometry);
      if (bounds) {
        map.fitBounds(bounds, { padding: 60, maxZoom: 19, duration: 800 });
      }
    });

    // Click-away → clear when not clicking building or room
    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: ["buildings-fill", FLOOR_FILL_LAYER],
      });
      if (!features.length) {
        clearFloorView();
      }
    });

    // ---------------- Expose BCITMap.focusRoom for search ----------------
    if (!window.BCITMap) window.BCITMap = {};

    /**
     * Step back one level rather than all the way out.
     *
     * Back from a room used to drop you at the campus-wide browse panel,
     * losing the building and floor you were looking at -- so getting to the
     * room next door meant searching for it again. A room sits in a building,
     * so that is where back goes; back from the building leaves the floor.
     */
    window.BCITMap.leaveBuilding = () => {
      if (window.BCITMap.clearRouteOverlay) window.BCITMap.clearRouteOverlay();
      clearFloorView();
    };

    window.BCITMap.backToBuilding = () => {
      if (window.BCITMap.clearRouteOverlay) window.BCITMap.clearRouteOverlay();
      clearSelectedRoom();
      if (currentBuildingCode) renderFloorPanel();
      else sidebar().reset();
    };

    window.BCITMap.focusRoom = async function ({ building, floor, room }) {
      const code = (building || "").trim();
      if (!code) return;

      // the floor list and room list both come from the index
      await roomFloorsReady;

      const src = map.getSource("buildings");
      const data = src && src._data;
      if (!data || !data.features) return;

      const upperCode = code.toUpperCase();
      const buildingFeat = data.features.find((ft) => {
        const p = ft.properties || {};
        const candidates = [
          p.BuildingName,
          p.Display_Name,
          p.SiteName,
          p.name,
          p.BldgCode,
          p.code,
        ]
          .filter(Boolean)
          .map((s) => String(s).toUpperCase());
        return candidates.includes(upperCode);
      });
      if (!buildingFeat) return;

      // Set up building / floors like a click
      clearFloorView();

      const bp = buildingFeat.properties || {};
      currentBuildingCode = code;
      currentBuildingLabel =
        bp.BuildingName || bp.Display_Name || bp.SiteName || code;

      let floorLabels = deriveFloorLabels(code, bp);
      currentFloorList = floorLabels;

      const requestedFloor = floor ? String(floor) : "";
      currentFloorLabel = floorLabels.includes(requestedFloor)
        ? requestedFloor
        : floorLabels[0] || "1";

      renderFloorPanel();

      // Highlight ALL polygons for this building
      ensureSelectedLayer();
      const selSrc = map.getSource(SEL_SRC);
      if (selSrc) {
        const buildingsSrc = map.getSource("buildings");
        const buildingsData = buildingsSrc && buildingsSrc._data;

        let features = [buildingFeat];
        if (buildingsData && buildingsData.features) {
          const codeUpper = code.toUpperCase();
          features = buildingsData.features.filter((ft) => {
            const bp2 = ft.properties || {};
            const candidates = [
              bp2.BuildingName,
              bp2.Display_Name,
              bp2.SiteName,
              bp2.name,
              bp2.BldgCode,
              bp2.code,
            ]
              .filter(Boolean)
              .map((s) => String(s).toUpperCase());
            return candidates.includes(codeUpper);
          });
          if (!features.length) features = [buildingFeat];
        }

        selSrc.setData({
          type: "FeatureCollection",
          features,
        });
      }

      hideBuildingShape(buildingFeat);
      await showBuildingFloor(code, currentFloorLabel);

      clearSelectedRoom();

      // If room specified, try to zoom to it
      if (room) {
        const floorSrc = map.getSource(FLOOR_SRC);
        const fData = floorSrc && floorSrc._data;
        if (fData && fData.features && fData.features.length) {
          const target = String(room).toUpperCase();

          const roomFeat = fData.features.find((rf) => {
            const rp = rf.properties || {};
            const rName = String(
              rp.room || rp.Room || rp.name || rp.id || ""
            ).toUpperCase();

            return (
              rName === target ||
              rName.endsWith("-" + target) ||
              ("-" + rName).endsWith("-" + target)
            );
          });

          if (roomFeat) {
            zoomToFeatureGeom(roomFeat, 40, 20);
            showRoomPopupForFeature(roomFeat, null);

            ensureRoomSelectedLayers();
            const selRoomSrc = map.getSource(ROOM_SEL_SRC);
            if (selRoomSrc) {
              selRoomSrc.setData({
                type: "FeatureCollection",
                features: [roomFeat],
              });
            }
            return;
          }
        }
      }

      // Otherwise, zoom to building
      const bounds = geometryBounds(buildingFeat.geometry);
      if (bounds) {
        map.fitBounds(bounds, { padding: 60, maxZoom: 19, duration: 800 });
      }
    };
  });
})();
