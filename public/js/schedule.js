// public/js/schedule.js
//
// The schedule page: add classes, see the week, and -- the part that makes it
// worth having -- get a direct route to whichever room you are due in.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js";
import {
  DAY_NAMES, DAY_SHORT, minutesOf, formatTime as fmtTime, parseRoomRef, findNowAndNext,
} from "/js/schedule-time.js";

const app = initializeApp(window.firebaseConfig);
const auth = getAuth(app);

const listEl = document.getElementById("scheduleList");
const nowNextEl = document.getElementById("nowNext");
const formEl = document.getElementById("classForm");
const formErrorEl = document.getElementById("formError");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

async function getIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated. Please log in.");
  return user.getIdToken(true);
}

async function api(path, options = {}) {
  const token = await getIdToken();
  const res = await fetch(`/api/schedule${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const mapLink = (entry) =>
  `/map?building=${encodeURIComponent(entry.building)}&room=${encodeURIComponent(entry.room)}`;

function renderNowNext(schedule) {
  if (!schedule.length) {
    nowNextEl.hidden = true;
    return;
  }
  const { current, next } = findNowAndNext(schedule);
  const card = (label, item, urgent) => {
    const e = item.entry;
    const when = item.inMinutes != null
      ? (item.inMinutes < 60
        ? `in ${Math.round(item.inMinutes)} min`
        : `${DAY_SHORT[item.day]} ${fmtTime(e.startTime)}`)
      : `until ${fmtTime(e.endTime)}`;
    return `
      <div class="now-card${urgent ? " is-now" : ""}">
        <div class="now-label">${esc(label)}</div>
        <div class="now-title">${esc(e.title)}</div>
        <div class="now-meta">${esc(e.building)}-${esc(e.room)} · ${esc(when)}</div>
        <a class="btn" href="${mapLink(e)}">Take Me There</a>
      </div>`;
  };

  const parts = [];
  if (current) parts.push(card("On Now", current, true));
  if (next) parts.push(card(current ? "Then" : "Up Next", next, false));
  nowNextEl.innerHTML = parts.join("");
  nowNextEl.hidden = !parts.length;
}

function renderSchedule(schedule) {
  if (!schedule.length) {
    listEl.innerHTML = `<p class="schedule-empty">No classes yet. Add one above and it will show up here.</p>`;
    return;
  }

  // one row per day the class runs, so the week reads as a week rather than
  // as a list of entries you have to decode
  const byDay = new Map();
  for (const entry of schedule) {
    for (const day of entry.days || []) {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(entry);
    }
  }
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay.has(d));

  listEl.innerHTML = order.map((day) => {
    const rows = byDay.get(day)
      .slice()
      .sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime))
      .map((e) => `
        <li class="class-row">
          <span class="class-time">${esc(fmtTime(e.startTime))} – ${esc(fmtTime(e.endTime))}</span>
          <span class="class-name">${esc(e.title)}</span>
          <span class="class-room">${esc(e.building)}-${esc(e.room)}</span>
          <span class="class-actions">
            <a class="class-go" href="${mapLink(e)}">Directions</a>
            <button type="button" class="class-remove" data-id="${esc(e.id)}" aria-label="Remove ${esc(e.title)}">Remove</button>
          </span>
        </li>`).join("");
    return `<section class="day-group">
        <h4>${DAY_NAMES[day]}</h4>
        <ul class="class-list">${rows}</ul>
      </section>`;
  }).join("");

  listEl.querySelectorAll(".class-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/${btn.dataset.id}`, { method: "DELETE" });
        await load();
      } catch (err) {
        btn.disabled = false;
        showError(err.message);
      }
    });
  });
}

function showError(message) {
  if (!formErrorEl) return;
  formErrorEl.textContent = message;
  formErrorEl.hidden = false;
}

let refreshTimer = null;

async function load() {
  try {
    const { schedule = [] } = await api("");
    renderSchedule(schedule);
    renderNowNext(schedule);

    // "on now" and "in 12 min" go stale as you sit there, so keep them true
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => renderNowNext(schedule), 30000);
  } catch (err) {
    listEl.innerHTML = `<p class="schedule-error">Could not load your schedule: ${esc(err.message)}</p>`;
  }
}

formEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  formErrorEl.hidden = true;

  const fd = new FormData(formEl);
  const ref = parseRoomRef(fd.get("room"));
  if (!ref) return showError("Enter the room with its building code, e.g. SW3-1600.");

  const days = [...formEl.querySelectorAll('input[name="day"]:checked')].map((i) => Number(i.value));
  if (!days.length) return showError("Pick at least one day.");

  const startTime = fd.get("startTime");
  const endTime = fd.get("endTime");
  if (endTime <= startTime) return showError("The end time has to be after the start time.");

  const submitBtn = formEl.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await api("", {
      method: "POST",
      body: JSON.stringify({
        title: String(fd.get("title")).trim(),
        building: ref.building,
        room: ref.room,
        days,
        startTime,
        endTime,
      }),
    });
    formEl.reset();
    await load();
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// the token only exists once Firebase has restored the session, so wait for it
onAuthStateChanged(auth, (user) => {
  if (user) {
    load();
  } else {
    listEl.innerHTML = `<p class="schedule-empty">Log in to keep a schedule.</p>`;
  }
});
