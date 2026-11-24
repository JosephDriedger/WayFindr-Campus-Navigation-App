// scripts/make-admin.js
//
// Appoint the first administrator, and get back in if there is no longer one.
//
// Administrators are appointed on the People page by other administrators,
// which is the right way round and leaves exactly one gap: the first one.
// Nobody can reach that page until somebody is already an administrator, and
// on a fresh deployment nobody is.
//
// So there is this, run on the server by whoever holds its credentials. It is
// deliberately not a route: the thing that can create the first administrator
// out of nothing should need a shell on the machine, not a browser. It is also
// the way back if every administrator is removed or leaves.
//
//   node scripts/make-admin.js someone@bcit.ca      appoint
//   node scripts/make-admin.js someone@bcit.ca --remove
//   node scripts/make-admin.js --list              who currently is one
//
// Whoever it touches is signed out, so their next sign-in starts from what is
// now true rather than from what they were told when they signed in.

import dotenv from "dotenv";
import { getAuth } from "../config/firebase.js";
import { dropSessionsFor } from "../services/sessionStore.js";

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const listOnly = args.includes("--list");
const email = args.find((a) => !a.startsWith("--"));

function usage(problem) {
  if (problem) console.error(`\n${problem}\n`);
  console.error("Usage:");
  console.error("  node scripts/make-admin.js <email>            make them an administrator");
  console.error("  node scripts/make-admin.js <email> --remove   take it away");
  console.error("  node scripts/make-admin.js --list             who currently is one");
  process.exit(problem ? 1 : 0);
}

async function admins(auth) {
  const { users } = await auth.listUsers(1000);
  return users.filter((u) => u.customClaims?.admin === true);
}

async function main() {
  let auth;
  try {
    auth = getAuth();
  } catch (err) {
    usage(`This needs the server's Firebase credentials: ${err.message}`);
  }

  if (listOnly) {
    const current = await admins(auth);
    if (!current.length) {
      console.log("Nobody is an administrator yet.");
      console.log("Appoint one: node scripts/make-admin.js <email>");
      return;
    }
    console.log(`${current.length} administrator${current.length === 1 ? "" : "s"}:`);
    for (const u of current) console.log(`  ${u.email || u.uid}`);
    return;
  }

  if (!email) usage("Which account? Give the address they sign in with.");

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    usage(`No account signs in as ${email}. They have to sign in once before `
      + "they can be appointed -- the account has to exist to be given anything.");
  }

  // Claims are written whole, so everything else the account carries is kept:
  // this changes one answer, not the whole record.
  const claims = { ...(user.customClaims || {}) };
  if (remove) delete claims.admin;
  else claims.admin = true;

  await auth.setCustomUserClaims(user.uid, claims);
  await auth.revokeRefreshTokens(user.uid);
  const ended = dropSessionsFor(user.uid);

  console.log(remove
    ? `${email} is an ordinary user again.`
    : `${email} is an administrator.`);
  if (ended) console.log(`Signed out of ${ended} session${ended === 1 ? "" : "s"}.`);
  console.log("They pick this up the next time they sign in.");

  if (remove) {
    const left = await admins(auth);
    if (!left.length) {
      console.warn("\nThere are now no administrators at all. Run this script "
        + "again with an address to appoint one.");
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message || err);
    process.exit(1);
  }
);
