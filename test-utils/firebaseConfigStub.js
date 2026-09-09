// Stand-in for config/firebase.js.
//
// Booting the app for a route test used to pull in the whole Firebase Admin
// SDK. Since v13 its auth entry point reaches jwks-rsa, which does a plain
// require('jose') -- and jose 6 is ESM only. Node handles that fine; Jest's
// module registry refuses it outright ("Must use import to load ES Module"),
// so the suite could not even load the app.
//
// Suites that only drive public routes have no business starting the Admin
// SDK anyway, so they mock the config module with this instead. Both handles
// throw if anything actually reaches for them: a test that starts depending
// on real Firebase should fail loudly rather than pass against a silent stub.
const unavailable = (name) => () => {
  throw new Error(
    `${name} is stubbed in this test. Mock the collection or auth call the ` +
    `code under test needs, or give the suite a real Firebase fixture.`
  );
};

export function firebaseConfigStub() {
  return {
    getFirestore: () => ({ collection: unavailable("Firestore") }),
    getAuth: () => ({
      verifyIdToken: unavailable("Auth.verifyIdToken"),
      createSessionCookie: unavailable("Auth.createSessionCookie"),
    }),
    FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" },
  };
}
