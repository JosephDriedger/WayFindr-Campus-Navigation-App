import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const app = initializeApp(window.firebaseConfig);
const auth = getAuth(app);

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("nodeForm");

  // Fetch existing nodes on page load
  fetch("/api/nodes")
    .then(res => res.json());

  // Handle form submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = {
      long: form.long.value,
      lat: form.lat.value,
      alt: form.alt.value,
      connections: form.connections.value
    };

    try {
      const res = await fetch("/api/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData)
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Error creating node");
        return;
      }

      form.reset();
    } catch (err) {
      console.error(err);
      alert("Failed to create node");
    }
  });
});

async function loadNodes() {
  try {
    const res = await fetch("/api/nodes");
    const nodes = await res.json();

    const list = document.getElementById("nodesList");
    if (!list) return;

    list.innerHTML = "";

    nodes.forEach(node => {
      const li = document.createElement("li");
      li.classList.add("node-item");

      // Node title (alt / ID)
      const title = document.createElement("span");
      title.classList.add("node-title");
      title.textContent = node.id;

      // Node details container
      const details = document.createElement("div");
      details.classList.add("node-details");
      details.innerHTML = `
        <div><strong>Alt:</strong> ${node.alt}</div>
        <div><strong>Lat:</strong> ${node.lat}</div>
        <div><strong>Long:</strong> ${node.long}</div>
        <div><strong>Connections:</strong> ${node.connections}</div>
        `;

      // Actions container
      const actions = document.createElement("div");
      actions.classList.add("node-actions");

      const favBtn = document.createElement("button");
      favBtn.classList.add("node-btn", "fav-btn");
      favBtn.dataset.nodeid = node.id;
      favBtn.textContent = "⭐ Add to Favorites";

      actions.appendChild(favBtn);

      // Build final item
      li.appendChild(title);
      li.appendChild(details);
      li.appendChild(actions);

      list.appendChild(li);
    });


    attachFavoriteHandlers();
  } catch (err) {
    console.error("Failed to load nodes:", err);
  }
}

// ------------------------
// Attach favorite buttons
// ------------------------
function attachFavoriteHandlers() {
  document.querySelectorAll("button[data-nodeid]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const nodeId = e.target.getAttribute("data-nodeid");
      await addFavorite(nodeId);
    });
  });
}

// ------------------------
// Add favorite
// ------------------------
async function addFavorite(nodeId) {
  try {
    const user = auth.currentUser;
    if (!user) {
      alert("Please log in first");
      return;
    }

    const token = await user.getIdToken(true);

    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ nodeId })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Failed to add favorite");
      return;
    }

    console.log("Favorite added:", data.favorite);
    alert(`Added to favorites!`);
  } catch (err) {
    console.error("Network or auth error:", err);
    alert("Network or auth error while adding favorite");
  }
}

// ------------------------
// Initialize page
// ------------------------
auth.onAuthStateChanged(_user => {
  loadNodes();
});