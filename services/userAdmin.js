// services/userAdmin.js
//
// Who the app's people are, and which of them maintain the map.
//
// Almost every account here is an ordinary user: a student looking for a room.
// A handful keep the map itself -- they trace floors and replace BCIT's
// drawings -- and this is how that handful is managed by the people already in
// it, rather than by editing an environment file and redeploying.
//
// Where "is an administrator" is written down matters more than it looks. It
// is a Firebase custom claim, which only a server holding the Admin SDK
// credentials can set, so appointing somebody is always something done TO an
// account and never by it. The alternative -- a field on the user's own
// profile document -- would put the answer inside a record the user may be
// able to write.
//
// The other half of the job is making a change true straight away. A session
// is stamped with who somebody is when they sign in, so a demotion on its own
// would do nothing for days: they would keep the answer they were given. Every
// change here therefore ends that person's sessions, and their next request
// starts from what is true now.

import { getAuth } from "../config/firebase.js";
import { dropSessionsFor } from "./sessionStore.js";

/** An error that already knows what status the caller should answer with. */
export class UserAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Firebase, or a readable explanation of its absence.
 *
 * Without service-account credentials the Admin SDK fails somewhere deep, with
 * a message about applications default credentials that says nothing about
 * what is actually wrong or who can fix it.
 */
function auth() {
  try {
    return getAuth();
  } catch (err) {
    throw new UserAdminError(503,
      `The user directory needs Firebase credentials, which this server does `
      + `not have (${err.message}).`);
  }
}

const iso = (value) => {
  const t = Date.parse(value || "");
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * One Firebase account, as this app thinks of it.
 *
 * `admin` is the claim, and it is the whole answer: every administrator is one
 * for the same reason, and every one of them can be stood down from the same
 * page by another.
 */
function shape(user) {
  return {
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || null,
    admin: user.customClaims?.admin === true,
    disabled: Boolean(user.disabled),
    created: iso(user.metadata?.creationTime),
    lastSignIn: iso(user.metadata?.lastSignInTime),
  };
}

/**
 * Everybody with an account, administrators first.
 *
 * One page of a thousand is every user this campus app will have for a long
 * while, and paging a list nobody can search is worse than a long list. If it
 * ever is not enough, the answer is a search box that asks Firebase, not a
 * "next" button.
 */
export async function listUsers({ limit = 1000 } = {}) {
  let page;
  try {
    page = await auth().listUsers(Math.min(limit, 1000));
  } catch (err) {
    if (err instanceof UserAdminError) throw err;
    throw new UserAdminError(502, `Firebase would not list the accounts: ${err.message}`);
  }
  const users = page.users.map(shape);
  users.sort((a, b) =>
    Number(b.admin) - Number(a.admin)
    || String(a.email || "").localeCompare(String(b.email || "")));
  return {
    users,
    admins: users.filter((u) => u.admin).length,
    more: Boolean(page.pageToken),
  };
}

/**
 * Make somebody an administrator, or stop them being one.
 *
 * `by` is the uid of whoever is doing it, and it is not ceremony: an
 * administrator removing their own access is how a campus ends up with no
 * administrators at all and no way to appoint one without a deployment. The
 * refusal is the whole reason this takes the caller's identity.
 */
export async function setAdmin(uid, admin, { by = null } = {}) {
  if (typeof uid !== "string" || !uid.trim()) {
    throw new UserAdminError(400, "Which account?");
  }
  if (typeof admin !== "boolean") {
    throw new UserAdminError(400, "Say whether this person is an administrator: true or false.");
  }
  if (!admin && by && by === uid) {
    throw new UserAdminError(409,
      "You cannot remove your own access. Ask another administrator to do it, "
      + "so that somebody is always able to appoint the next one.");
  }

  const service = auth();
  let user;
  try {
    user = await service.getUser(uid);
  } catch {
    throw new UserAdminError(404, "There is no account with that id.");
  }

  // Everything else on the account stays: claims are written whole, so
  // spreading the existing ones is the difference between changing a role and
  // quietly dropping every other thing Firebase was told about this person.
  const claims = { ...(user.customClaims || {}) };
  if (admin) claims.admin = true;
  else delete claims.admin;

  try {
    await service.setCustomUserClaims(uid, claims);
    // so a token minted a minute ago cannot keep speaking for the old answer
    await service.revokeRefreshTokens(uid);
  } catch (err) {
    throw new UserAdminError(502, `Firebase would not save that change: ${err.message}`);
  }

  const ended = dropSessionsFor(uid);
  return {
    ok: true,
    uid,
    email: user.email || null,
    admin,
    signedOut: ended,
  };
}
