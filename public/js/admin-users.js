// public/js/admin-users.js
//
// The people page: who has an account, and which of them maintain the map.
//
// Making somebody an administrator hands them the tracer and the floor-plan
// library -- the two places where one person's mistake is everybody's wrong
// map. So the page is built to make the act deliberate: what each row can do
// is spelled out, the two rows that cannot be changed say why, and the change
// itself is confirmed before it is sent.

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function when(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
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
    throw new Error(res.status === 401 || /<!DOCTYPE/i.test(text)
      ? "You Are Signed Out. Sign in Again and Reload This Page."
      : `The Server Answered with Something Unreadable (${res.status}).`);
  }
  if (!res.ok) throw new Error(body?.error || `Request Failed (${res.status})`);
  return body;
}

let users = [];
let you = null;

async function load() {
  try {
    const data = await fetchJson("/admin/api/users");
    users = data.users || [];
    you = data.you || null;
    el("userState").textContent = data.more
      ? "Showing the First Thousand Accounts."
      : "";
  } catch (err) {
    el("userState").textContent = err.message;
    return;
  }
  render();
}

/** What this row's button would do, or why there is not one. */
function action(u) {
  if (u.uid === you) {
    return `<span class="admin-note" title="So the campus is never left without an administrator">
              Ask Another Administrator
            </span>`;
  }
  return u.admin
    ? `<button type="button" class="admin-danger" data-uid="${esc(u.uid)}" data-admin="false">
         Remove Admin
       </button>`
    : `<button type="button" data-uid="${esc(u.uid)}" data-admin="true">
         Make Admin
       </button>`;
}

function render() {
  const needle = el("userFilter").value.trim().toLowerCase();
  const shown = needle
    ? users.filter((u) => `${u.email || ""} ${u.displayName || ""}`.toLowerCase().includes(needle))
    : users;

  const admins = users.filter((u) => u.admin).length;
  el("userCount").textContent = needle
    ? `${shown.length} of ${users.length}`
    : `${users.length} · ${admins} Admin${admins === 1 ? "" : "s"}`;

  el("userRows").innerHTML = shown.map((u) => `
    <tr${u.uid === you ? ' class="admin-you"' : ""}>
      <td>
        <strong>${esc(u.email || "(No Address)")}</strong>
        ${u.uid === you ? '<span class="admin-tag">You</span>' : ""}
        ${u.displayName ? `<br><span class="admin-note">${esc(u.displayName)}</span>` : ""}
        ${u.disabled ? '<br><span class="admin-warn">Account Disabled</span>' : ""}
      </td>
      <td>
        ${u.admin
          ? `<span class="admin-role">Administrator</span>`
          : `<span class="admin-note">User</span>`}
      </td>
      <td><span class="admin-note">${esc(when(u.lastSignIn))}</span></td>
      <td class="admin-actions">${action(u)}</td>
    </tr>`).join("");
}

el("userFilter").addEventListener("input", render);

el("userRows").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-uid]");
  if (!button) return;
  const uid = button.dataset.uid;
  const admin = button.dataset.admin === "true";
  const who = users.find((u) => u.uid === uid);
  const name = who?.email || uid;

  // Handing over the tracer and the plan library is worth one question. So is
  // taking them back: that person loses the pages mid-sentence if they happen
  // to be using them.
  const question = admin
    ? `Make ${name} an administrator?\n\n`
      + "They will be able to trace floors, replace BCIT's drawings, and "
      + "appoint other administrators."
    : `Remove ${name}'s administrator access?\n\n`
      + "They will be signed out, and keep their ordinary account.";
  if (!window.confirm(question)) return;

  button.disabled = true;
  const cell = button.parentElement;
  try {
    const result = await fetchJson(`/admin/api/users/${encodeURIComponent(uid)}/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin }),
    });
    await load();
    el("userState").textContent = result.admin
      ? `${result.email || uid} Is Now an Administrator. They Will Pick It Up the Next Time They Sign In.`
      : `${result.email || uid} Is an Ordinary User Again${result.signedOut
          ? `, and Was Signed Out of ${result.signedOut} Session${result.signedOut === 1 ? "" : "s"}` : ""}.`;
  } catch (err) {
    button.disabled = false;
    cell.innerHTML += `<br><span class="admin-warn">${esc(err.message)}</span>`;
  }
});

load();
