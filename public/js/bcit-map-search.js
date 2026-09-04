// public/js/bcit-map-search.js
(function () {
  window.BCITMapPlugins = window.BCITMapPlugins || [];
  window.BCITMapPlugins.push(function attachSearch(map, utils) {
    const { geometryBounds } = utils;

    const searchInput = document.getElementById("searchInput");
    const searchBtn = document.getElementById("searchBtn");

    // Container for the dropdown (lives in the sidebar, under the search bar)
    const suggestionsEl = document.createElement("div");
    suggestionsEl.className = "map-search-suggestions";
    const sidebarEl = document.getElementById("map-sidebar");
    if (sidebarEl) sidebarEl.appendChild(suggestionsEl);

    // Data sources
    let buildingIndex = null;
    let roomIndex = []; // optional, loaded from /data/room-search-index.json
    let activeIndex = -1; // which suggestion is highlighted
    let currentSuggestions = [];

    function ensureBuildingIndex() {
      if (buildingIndex) return buildingIndex;
      buildingIndex = window.__BUILDINGS_INDEX__ || {};
      return buildingIndex;
    }

    // The room index -- { building: "SW3", floor: "1", room: "1635",
    // label: "SW3-1635" } -- is already being fetched by the core script for
    // the sidebar's building list, so reuse that request rather than pulling
    // the same (uncached, campus-wide) file down a second time.
    (async function loadRoomIndex() {
      try {
        const rooms = await (window.__ROOM_INDEX_PROMISE__ ||
          fetch("/data/room-search-index.json", { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : { rooms: [] }))
            .then((json) => json.rooms));
        if (Array.isArray(rooms)) roomIndex = rooms;
      } catch {
        // fail silently, building-only search will still work
      }
    })();

    // ------------------- Suggestions building -------------------
    function buildSuggestions(query) {
      const q = query.trim().toLowerCase();
      currentSuggestions = [];
      activeIndex = -1;

      if (!q) {
        hideSuggestions();
        return;
      }

      const bIndex = ensureBuildingIndex();

      const buildingSuggestions = [];
      const roomsSuggestions = [];

      // BUILDINGS: rank by startsWith, then contains
      Object.keys(bIndex).forEach((code) => {
        const entry = bIndex[code];
        const name =
          (entry && entry.displayName) ||
          entry?.name ||
          code;
        const lowerName = (name || "").toLowerCase();
        const lowerCode = code.toLowerCase();

        let score = Infinity;
        if (lowerCode.startsWith(q) || lowerName.startsWith(q)) score = 0;
        else if (lowerCode.includes(q) || lowerName.includes(q)) score = 1;

        if (score !== Infinity) {
          buildingSuggestions.push({
            type: "building",
            building: code,
            title: name,
            subtitle: "Building",
            score,
          });
        }
      });

      buildingSuggestions.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));

      // ROOMS (optional): from roomIndex
      if (roomIndex && roomIndex.length) {
        for (const r of roomIndex) {
          const label =
            r.label ||
            `${r.building || ""}-${r.room || ""}`.replace(/-+$/, "");
          const lowerLabel = label.toLowerCase();
          if (
            lowerLabel.startsWith(q) ||
            lowerLabel.includes(q)
          ) {
            roomsSuggestions.push({
              type: "room",
              building: r.building,
              floor: r.floor,
              room: r.room,
              title: label,
              subtitle: `${r.building} · Floor ${r.floor}`,
            });
          }
        }
      }

      // Limit counts
      const maxPerSection = 6;
      const finalList = [];

      if (buildingSuggestions.length) {
        finalList.push({ isSection: true, label: "Buildings" });
        finalList.push(...buildingSuggestions.slice(0, maxPerSection));
      }

      if (roomsSuggestions.length) {
        finalList.push({ isSection: true, label: "Rooms" });
        finalList.push(...roomsSuggestions.slice(0, maxPerSection));
      }

      currentSuggestions = finalList;
      renderSuggestions();
    }

    function renderSuggestions() {
      suggestionsEl.innerHTML = "";
      if (!currentSuggestions.length) {
        hideSuggestions();
        return;
      }

      currentSuggestions.forEach((item, idx) => {
        if (item.isSection) {
          const sec = document.createElement("div");
          sec.className = "map-search-suggestion-section";
          sec.textContent = item.label;
          suggestionsEl.appendChild(sec);
          return;
        }

        const row = document.createElement("div");
        row.className = "map-search-suggestion";
        row.dataset.index = String(idx);

        if (idx === activeIndex) {
          row.classList.add("is-active");
        }

        const titleEl = document.createElement("div");
        titleEl.className = "map-search-suggestion-title";
        titleEl.textContent = item.title;

        const subEl = document.createElement("div");
        subEl.className = "map-search-suggestion-sub";
        subEl.textContent = item.subtitle || (item.type === "building" ? "Building" : "Room");

        row.appendChild(titleEl);
        row.appendChild(subEl);

        row.addEventListener("mousedown", (e) => {
          // mousedown so blur on input doesn't close before click
          e.preventDefault();
          chooseSuggestion(idx);
        });

        suggestionsEl.appendChild(row);
      });

      suggestionsEl.style.display = "block";
    }

    function hideSuggestions() {
      suggestionsEl.style.display = "none";
      activeIndex = -1;
    }

    function moveActive(delta) {
      if (!currentSuggestions.length) return;

      // make a list of actual suggestion indices (skip section headers)
      const selectable = currentSuggestions
        .map((item, idx) => ({ item, idx }))
        .filter((x) => !x.item.isSection);

      if (!selectable.length) return;

      let pos = selectable.findIndex((x) => x.idx === activeIndex);
      if (pos === -1) {
        pos = delta > 0 ? 0 : selectable.length - 1;
      } else {
        pos = (pos + delta + selectable.length) % selectable.length;
      }

      activeIndex = selectable[pos].idx;
      renderSuggestions();
    }

    function chooseSuggestion(idx) {
      const item = currentSuggestions[idx];
      if (!item || item.isSection) return;

      if (item.type === "building") {
        searchByBuilding(item.building);
        searchInput.value = item.building;
      } else if (item.type === "room") {
        searchRoomExact(item);
        searchInput.value = item.title;
      }

      hideSuggestions();
    }

    // ------------------- Actual search operations -------------------
    function searchRoomExact(item) {

      if (
        window.BCITMap &&
        typeof window.BCITMap.focusRoom === "function"
      ) {
        window.BCITMap.focusRoom({
          building: item.building,
          floor: item.floor,
          room: item.room,
        });
        return;
      }

      // Fallback: Just do building-level search
      searchByBuilding(item.building);
    }

    function searchByBuilding(buildingCode) {
      // Searching for a building used to also draw a route to it from the
      // middle of the map, which is not what searching means.
      const code = (buildingCode || "").trim().toUpperCase();
      if (!code) return;

      // Prefer focusRoom if present (gives you highlight + floors)
      if (window.BCITMap && typeof window.BCITMap.focusRoom === "function") {
        window.BCITMap.focusRoom({ building: code });
        return;
      }

      // Legacy behaviour fallback
      const ix = window.__BUILDINGS_INDEX__ || {};
      if (ix[code]) {
        map.flyTo({
          center: ix[code].center,
          zoom: 18,
          speed: 0.6,
          curve: 1.4,
          essential: true,
        });
        return;
      }

      const src = map.getSource("buildings");
      const data = src && src._data;
      if (data && data.features) {
        const feat = data.features.find((ft) => {
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
          return candidates.includes(code);
        });

        if (feat) {
          const bounds = geometryBounds(feat.geometry);
          if (bounds) {
            map.fitBounds(bounds, { padding: 60, maxZoom: 19, duration: 600 });
          }
        }
      }
    }

    // Fallback search for free text (used when no suggestion selected)
    function freeTextSearch(raw) {
      const q = (raw || "").trim();
      if (!q) return;

      const upper = q.toUpperCase();

      // Try room pattern: SW3-1635 or SW3 1635
      const roomMatch = upper.match(/^([A-Z]{1,4}\d{0,2})[-\s]+([A-Z0-9]+)$/);
      if (
        roomMatch &&
        window.BCITMap &&
        typeof window.BCITMap.focusRoom === "function"
      ) {
        const buildingCode = roomMatch[1];
        const roomCode = roomMatch[2].replace(/\s+/g, "");

        const firstDigitMatch = roomCode.match(/\d/);
        const floorGuess = firstDigitMatch ? firstDigitMatch[0] : "1";

        window.BCITMap.focusRoom({
          building: buildingCode,
          floor: floorGuess,
          room: roomCode,
        });
        return;
      }

      // Otherwise treat as building code
      searchByBuilding(upper);
    }

    // ------------------- Wire up events -------------------
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        buildSuggestions(searchInput.value);
      });

      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveActive(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveActive(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (activeIndex !== -1) {
            chooseSuggestion(activeIndex);
          } else {
            hideSuggestions();
            freeTextSearch(searchInput.value);
          }
        } else if (e.key === "Escape") {
          hideSuggestions();
        }
      });

      // Hide suggestions on blur (delayed so clicks still register)
      searchInput.addEventListener("blur", () => {
        setTimeout(() => hideSuggestions(), 150);
      });
    }

    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        hideSuggestions();
        freeTextSearch(searchInput && searchInput.value);
      });
    }
  });
})();
