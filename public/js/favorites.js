// public/js/favorites.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js";

// Initialize Firebase
const app = initializeApp(window.firebaseConfig);
const auth = getAuth(app);

// DOM elements
const favoritesList = document.getElementById("favoritesList");

// Helper: Get current user's ID token for server requests
async function getIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated. Please log in.");
  return await user.getIdToken(/* forceRefresh */ true);
}

// Load favorites from server
export async function loadFavorites() {
  try {
    const token = await getIdToken();
    const res = await fetch("/api/favorites", {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) throw new Error("Failed to fetch favorites");
    const data = await res.json();

    renderFavorites(data.favorites || []);
  } catch (err) {
    console.error("Error loading favorites:", err);
    favoritesList.innerHTML = `<li class="error">Error loading favorites: ${err.message}</li>`;
  }
}

// Render favorites in DOM
function renderFavorites(favorites) {
  favoritesList.innerHTML = "";

  if (!favorites.length) {
    favoritesList.innerHTML = "<li>No favorites yet.</li>";
    return;
  }

  favorites.forEach(fav => {
    const li = document.createElement("li");
    li.classList.add("favorite-item");

    // Label fallback logic
    let displayLabel = fav.label;
    if (!displayLabel && fav.addedAt?._seconds) {
      displayLabel = new Date(fav.addedAt._seconds * 1000)
        .toLocaleDateString();
    }

    // Main label element
    const labelSpan = document.createElement("span");
    labelSpan.classList.add("favorite-label");
    labelSpan.textContent = displayLabel;
    labelSpan.style.cursor = "pointer"

    // When clicked, go to the map focused on this favorite
    labelSpan.addEventListener("click", () => {
      if (fav.nodeMeta?.kind === "room") {
        const { building, floor, room } = fav.nodeMeta;
        const q = new URLSearchParams({ building, room });
        if (floor) q.set("floor", floor);
        window.location.href = `/map?${q.toString()}`;
      } else {
        window.location.href = `/map`;
      }
    });

    // Actions container
    const actionsDiv = document.createElement("div");
    actionsDiv.classList.add("favorite-actions");

    const renameBtn = document.createElement("button");
    renameBtn.classList.add("favorite-btn", "rename-btn");
    renameBtn.dataset.nodeid = fav.nodeId;
    renameBtn.textContent = "✏️";

    const removeBtn = document.createElement("button");
    removeBtn.classList.add("favorite-btn", "remove-btn");
    removeBtn.dataset.nodeid = fav.nodeId;
    removeBtn.textContent = "❌";

    const useBtn = document.createElement("button");
    useBtn.classList.add("favorite-btn", "use-btn");
    useBtn.dataset.nodeid = fav.nodeId;
    useBtn.textContent = "⬆";

    // Add buttons to actions container
    actionsDiv.appendChild(renameBtn);
    actionsDiv.appendChild(removeBtn);
    actionsDiv.appendChild(useBtn);

    // Put everything into the list item
    li.appendChild(labelSpan);
    li.appendChild(actionsDiv);

    favoritesList.appendChild(li);
  });

  attachHandlers();
}

// Attach click handlers for rename/remove/use
function attachHandlers() {
  document.querySelectorAll(".rename-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const nodeId = e.target.dataset.nodeid;
      const newLabel = prompt("Enter new label for this favorite:");
      if (newLabel !== null) {
        await renameFavorite(nodeId, newLabel);
        loadFavorites();
      }
    });
  });

  document.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const nodeId = e.target.dataset.nodeid;
      if (confirm("Remove this favorite?")) {
        await removeFavorite(nodeId);
        loadFavorites(); // refresh
      }
    });
  });

  document.querySelectorAll(".use-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const nodeId = e.target.dataset.nodeid;
      await useFavorite(nodeId);
      loadFavorites();
    });
  });
}

// Rename favorite label
async function renameFavorite(nodeId, newLabel) {
  try {
    const token = await getIdToken();
    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nodeId, label: newLabel })
    });
    if (!res.ok) throw new Error("Failed to rename favorite");
    loadFavorites();
  } catch (err) {
    console.error("Error renaming favorite:", err);
    alert(err.message);
  }
}

// Remove favorite
async function removeFavorite(nodeId) {
  try {
    const token = await getIdToken();
    const res = await fetch(`/api/favorites/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Failed to remove favorite");
  } catch (err) {
    console.error("Error removing favorite:", err);
    alert(err.message);
  }
}

// Mark favorite as used
async function useFavorite(nodeId) {
  try {
    const token = await getIdToken();
    const res = await fetch(`/api/favorites/${encodeURIComponent(nodeId)}/use`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Failed to mark favorite as used");
  } catch (err) {
    console.error("Error using favorite:", err);
    alert(err.message);
  }
}

// Initialize
auth.onAuthStateChanged(user => {
  if (!user) {
    favoritesList.innerHTML = "<li>Please log in to view favorites.</li>";
    return;
  }
  loadFavorites();
});
