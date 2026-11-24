// public/js/admin-plans.js
//
// The floor-plan library page: dropping new sheets in, and seeing what the app
// currently has.
//
// The job this page exists for is a handover. BCIT reissues a drawing, someone
// who is not a developer has the file, and the app has to end up using it. So
// the page is built around the two questions that go wrong in that handover:
// which floor is this file, and what does replacing it change? Both are
// answered before anything is sent.

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KB = 1024;
const fileSize = (bytes) => {
  if (!bytes) return "";
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
};

/** A date as something a person reads, not an ISO string. */
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // An HTML page where JSON was expected means the request was bounced to
    // the login screen. Say that, rather than "unexpected token <".
    throw new Error(res.status === 401 || /<!DOCTYPE/i.test(text)
      ? "You Are Signed Out. Sign in Again and Reload This Page."
      : `The Server Answered with Something Unreadable (${res.status}).`);
  }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.detail = body?.detail;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// What the app has now
// ---------------------------------------------------------------------------
let plans = [];
let history = [];
const planFor = (building, floor) =>
  plans.find((p) => p.building.toUpperCase() === String(building).toUpperCase()
    && String(p.floor) === String(Number(floor)));

async function loadLibrary() {
  try {
    const data = await fetchJson("/admin/api/library");
    plans = data.plans || [];
    history = data.history || [];
  } catch (err) {
    el("libraryState").textContent = err.message;
    return;
  }
  renderLibrary();
  renderHistory();
  renderQueue();   // "what it changes" is read off the library
}

function renderLibrary() {
  const needle = el("planFilter").value.trim().toLowerCase();
  const shown = needle
    ? plans.filter((p) => p.stem.toLowerCase().includes(needle))
    : plans;

  el("planCount").textContent = needle
    ? `${shown.length} of ${plans.length}`
    : String(plans.length);
  el("libraryState").textContent = plans.length
    ? ""
    : "No Sheets Yet. Drop the Drawings Above to Add the First One.";

  el("planRows").innerHTML = shown.map((p) => {
    // The picture is served from a path that does not change when it is
    // replaced, so without this the browser shows yesterday's drawing.
    const stampedImage = p.image
      ? `${p.image}?v=${encodeURIComponent(p.rendered?.updated || "")}`
      : null;
    const thumb = stampedImage
      ? `<img class="plans-thumb" src="${esc(stampedImage)}" alt="" loading="lazy">`
      : `<span class="plans-warn">No Picture</span>`;
    const size = p.width && p.height ? `${p.width}&times;${p.height}` : "";
    return `
      <tr data-stem="${esc(p.stem)}">
        <td>
          <strong>${esc(p.building)}</strong> Floor ${esc(p.floor)}
          ${p.knownBuilding ? "" : `<br><span class="plans-warn" title="No Campus Outline Has This Code">Unknown Building Code</span>`}
        </td>
        <td class="plans-drawing">
          ${thumb}
          <span class="plans-note">${size}<br>${esc(when(p.rendered?.updated))}</span>
        </td>
        <td>${p.traced ? `${p.traced} Drawn` : `<span class="plans-note">Not Traced</span>`}</td>
        <td>${p.placed ? "Positioned" : `<span class="plans-warn">Not Positioned</span>`}</td>
        <td>
          ${p.source
            ? `<a href="${esc(p.source.url)}" download>PDF</a> <span class="plans-note">${fileSize(p.source.bytes)}</span>`
            : `<span class="plans-note">Picture Only</span>`}
        </td>
        <td class="plans-actions">
          <button type="button" data-replace="${esc(p.stem)}">Replace</button>
          <button type="button" data-versions="${esc(p.stem)}"
            ${p.versions ? "" : "disabled"}>Kept Copies${p.versions ? ` (${p.versions})` : ""}</button>
          <a class="plans-button" href="/admin/tracer?plan=${encodeURIComponent(p.stem)}">Open in Tracer</a>
        </td>
      </tr>
      <tr class="plans-versions" data-versions-for="${esc(p.stem)}" hidden><td colspan="6"></td></tr>`;
  }).join("");
}

function renderHistory() {
  el("historyBlock").hidden = !history.length;
  el("historyList").innerHTML = history.map((h) => `
    <li>
      <strong>${esc(h.stem)}</strong>
      ${h.replaced ? "replaced" : "added"}
      ${h.by ? `by ${esc(h.by)}` : ""}
      <span class="plans-note">${esc(when(h.at))} · ${esc(h.filename || h.kind)} · ${fileSize(h.bytes)}</span>
    </li>`).join("");
}

// ---------------------------------------------------------------------------
// The queue
//
// Files sit here, named and checked, until somebody presses Upload. Dropping a
// file is how you say "this one"; it is not how you say "go".
// ---------------------------------------------------------------------------
let queue = [];   // { id, file, building, floor, state, message }
let nextId = 1;

/** Add files, asking the server which sheet each name says it is. */
async function enqueue(files, forced = null) {
  const list = [...files].filter((f) => f && f.size);
  if (!list.length) return;

  let parsed = [];
  if (!forced) {
    try {
      const data = await fetchJson("/admin/api/plan-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: list.map((f) => f.name) }),
      });
      parsed = data.parsed || [];
    } catch {
      // Not being able to read the names is not a reason to refuse the
      // files; it just means every row starts blank.
      parsed = [];
    }
  }

  list.forEach((file, i) => {
    const match = forced || parsed[i]?.match || null;
    queue.push({
      id: nextId++,
      file,
      building: match?.building || "",
      floor: match?.floor || "",
      state: "ready",
      message: "",
    });
  });
  renderQueue();
}

/** What uploading this row would do, in a sentence. */
function consequence(row) {
  if (!row.building || !row.floor) return `<span class="plans-warn">Say Which Floor This Is</span>`;
  const target = planFor(row.building, row.floor);
  if (!target) {
    return `New Sheet — ${esc(row.building.toUpperCase())} Floor ${esc(row.floor)} Has None Yet`;
  }
  const bits = [`Replaces the Current ${esc(target.stem)}`];
  if (target.traced) {
    // The tracing is the expensive thing on this page and it is NOT replaced.
    // Saying so here is the difference between a careful upload and somebody
    // assuming their afternoon's work is about to be deleted.
    bits.push(`<span class="plans-note">${target.traced} Traced Features Are Kept — Check Them Against the New Drawing</span>`);
  }
  return bits.join("<br>");
}

function renderQueue() {
  el("queueBlock").hidden = !queue.length;
  el("queueCount").textContent = String(queue.length);
  el("queueRows").innerHTML = queue.map((row) => `
    <tr data-row="${row.id}" class="plans-state-${esc(row.state)}">
      <td>
        ${esc(row.file.name)}
        <span class="plans-note">${fileSize(row.file.size)}</span>
        ${row.message ? `<br><span class="plans-${row.state === "failed" ? "warn" : "note"}">${esc(row.message)}</span>` : ""}
      </td>
      <td><input type="text" data-field="building" value="${esc(row.building)}"
                 size="6" aria-label="Building code" ${row.state === "done" ? "disabled" : ""}></td>
      <td><input type="text" data-field="floor" value="${esc(row.floor)}"
                 size="3" aria-label="Floor number" ${row.state === "done" ? "disabled" : ""}></td>
      <td>${row.state === "done" ? "Uploaded" : consequence(row)}</td>
      <td><button type="button" data-drop-row="${row.id}" aria-label="Remove">&times;</button></td>
    </tr>`).join("");
}

el("queueRows").addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const row = queue.find((r) => r.id === Number(e.target.closest("tr").dataset.row));
  if (!row) return;
  row[field] = e.target.value.trim();
  // Only the sentence needs redrawing, and redrawing the table would take the
  // cursor out of the box being typed in.
  const cell = e.target.closest("tr").children[3];
  if (cell) cell.innerHTML = consequence(row);
});

el("queueRows").addEventListener("click", (e) => {
  const id = e.target.dataset.dropRow;
  if (!id) return;
  queue = queue.filter((r) => r.id !== Number(id));
  renderQueue();
});

el("clearQueue").addEventListener("click", () => {
  queue = [];
  el("queueState").textContent = "";
  renderQueue();
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
let results = [];

function renderResults() {
  el("resultsBlock").hidden = !results.length;
  el("resultList").innerHTML = results.map((r) => {
    const notes = [];
    if (r.resized && r.was) {
      notes.push(`The Drawing Is a Different Size from the One It Replaced `
        + `(${r.width}&times;${r.height}, Was ${r.was.width}&times;${r.was.height}).`);
    }
    if (r.placement?.note) notes.push(esc(r.placement.note));
    if (r.traced) {
      notes.push(`${r.traced} Traced Features on This Floor Were Left Alone. `
        + `Open It in the Tracer to Check Them Against the New Drawing.`);
    }
    const needsEye = ["unknown", "page-changed", "rescaled"].includes(r.placement?.status);
    return `
      <li class="plans-result ${needsEye ? "plans-result-check" : ""}">
        <strong>${esc(r.stem)}</strong> ${r.replaced ? "replaced" : "added"}
        ${r.version ? `<span class="plans-note">Previous Copy Kept</span>` : ""}
        <ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul>
        <a class="plans-button" href="/admin/tracer?plan=${encodeURIComponent(r.stem)}">Open in Tracer</a>
      </li>`;
  }).join("");
}

async function uploadRow(row) {
  row.state = "sending";
  row.message = "Rendering…";
  renderQueue();

  const url = `/admin/api/plan/${encodeURIComponent(row.building)}/${encodeURIComponent(row.floor)}`
    + `?name=${encodeURIComponent(row.file.name)}`;
  try {
    const report = await fetchJson(url, {
      method: "POST",
      // The body is the file. The browser would send a content type of its
      // own guessing; an empty one still works, because the server sniffs the
      // bytes rather than believing the header.
      headers: { "Content-Type": row.file.type || "application/octet-stream" },
      body: row.file,
    });
    row.state = "done";
    row.message = "";
    results.unshift(report);
  } catch (err) {
    row.state = "failed";
    row.message = err.detail ? `${err.message} — ${err.detail}` : err.message;
  }
  renderQueue();
  renderResults();
}

el("uploadAll").addEventListener("click", async () => {
  const pending = queue.filter((r) => r.state !== "done");
  const unnamed = pending.filter((r) => !r.building || !r.floor);
  if (unnamed.length) {
    el("queueState").textContent =
      `${unnamed.length} File${unnamed.length === 1 ? " still needs" : "s still need"} a Building and Floor.`;
    return;
  }
  if (!pending.length) return;

  el("uploadAll").disabled = true;
  el("queueState").textContent = "";
  // One at a time. Each upload re-renders a PDF on the server, and the point
  // of sending thirty at once was never to render thirty at once.
  for (const row of pending) {
    await uploadRow(row);
  }
  el("uploadAll").disabled = false;

  const failed = queue.filter((r) => r.state === "failed");
  queue = failed;
  el("queueState").textContent = failed.length
    ? `${failed.length} Could Not Be Uploaded; the Rest Are Done.`
    : "";
  renderQueue();
  await loadLibrary();
});

// ---------------------------------------------------------------------------
// Choosing files
// ---------------------------------------------------------------------------
// Which sheet a file picked through a row's Replace button belongs to. Chosen
// before the picker opens, so a file whose name says nothing still lands on
// the floor you pressed Replace on.
let replaceTarget = null;

el("pick").addEventListener("click", () => {
  replaceTarget = null;
  el("filePick").click();
});

el("drop").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  replaceTarget = null;
  el("filePick").click();
});

el("drop").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    replaceTarget = null;
    el("filePick").click();
  }
});

el("filePick").addEventListener("change", async (e) => {
  const target = replaceTarget;
  replaceTarget = null;
  await enqueue(e.target.files, target);
  // so picking the same file twice in a row still counts as a change
  e.target.value = "";
});

const drop = el("drop");
["dragenter", "dragover"].forEach((type) => drop.addEventListener(type, (e) => {
  e.preventDefault();
  drop.classList.add("is-over");
}));
["dragleave", "drop"].forEach((type) => drop.addEventListener(type, (e) => {
  e.preventDefault();
  if (type === "dragleave" && drop.contains(e.relatedTarget)) return;
  drop.classList.remove("is-over");
}));
drop.addEventListener("drop", (e) => {
  replaceTarget = null;
  enqueue(e.dataTransfer?.files || []);
});

// The page is one big drop target as far as a person is concerned, but only
// the panel accepts files -- so a file let go anywhere else must not be opened
// by the browser in place of this page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Per-sheet actions
// ---------------------------------------------------------------------------
el("planRows").addEventListener("click", async (e) => {
  const replace = e.target.dataset.replace;
  if (replace) {
    const plan = plans.find((p) => p.stem === replace);
    replaceTarget = { building: plan.building, floor: plan.floor };
    el("filePick").click();
    return;
  }

  const versions = e.target.dataset.versions;
  if (versions) {
    await toggleVersions(versions, e.target);
    return;
  }

  const restore = e.target.dataset.restore;
  if (restore) {
    const [stem, file] = restore.split("|");
    const plan = plans.find((p) => p.stem === stem);
    if (!window.confirm(`Put the Copy from ${when(e.target.dataset.at)} Back As ${stem}?\n\n`
      + "The Sheet in Place Now Is Kept, so This Can Be Undone.")) return;
    e.target.disabled = true;
    try {
      const report = await fetchJson(
        `/admin/api/plan/${encodeURIComponent(plan.building)}/${encodeURIComponent(plan.floor)}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file }),
        });
      results.unshift(report);
      renderResults();
      await loadLibrary();
    } catch (err) {
      window.alert(err.message);
      e.target.disabled = false;
    }
  }
});

/** The kept copies of one sheet, fetched when somebody asks for them. */
async function toggleVersions(stem, button) {
  const row = document.querySelector(`tr[data-versions-for="${CSS.escape(stem)}"]`);
  if (!row) return;
  if (!row.hidden) {
    row.hidden = true;
    return;
  }
  const cell = row.firstElementChild;
  cell.textContent = "Loading…";
  row.hidden = false;
  button.disabled = true;
  try {
    const plan = plans.find((p) => p.stem === stem);
    const data = await fetchJson(
      `/admin/api/plan/${encodeURIComponent(plan.building)}/${encodeURIComponent(plan.floor)}/versions`);
    const rows = (data.versions || []).map((v) => {
      const links = ["pdf", "png"]
        .filter((kind) => v.files?.[kind])
        .map((kind) => `<a href="${esc(v.files[kind].url)}" download>${kind.toUpperCase()}</a>
                        <span class="plans-note">${fileSize(v.files[kind].bytes)}</span>`)
        .join(" ");
      return `
        <li>
          <span class="plans-note">Kept ${esc(when(v.at))}</span>
          ${links}
          ${v.restore
            ? `<button type="button" data-restore="${esc(stem)}|${esc(v.restore)}"
                       data-at="${esc(v.at)}">Put This Back</button>`
            : ""}
        </li>`;
    }).join("");
    cell.innerHTML = rows
      ? `<ul class="plans-version-list">${rows}</ul>`
      : `<span class="plans-note">Nothing Kept for This Sheet Yet.</span>`;
  } catch (err) {
    cell.textContent = err.message;
  }
  button.disabled = false;
}

el("planFilter").addEventListener("input", renderLibrary);

loadLibrary();
