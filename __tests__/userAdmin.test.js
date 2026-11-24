// __tests__/userAdmin.test.js
//
// Appointing administrators, which is the one piece of this app where getting
// it wrong hands somebody else's account the keys to the campus map. Firebase
// is mocked: what is being checked is the reasoning around the claim, not that
// the Admin SDK writes it.

import { jest } from "@jest/globals";

const mockListUsers = jest.fn();
const mockGetUser = jest.fn();
const mockSetClaims = jest.fn();
const mockRevoke = jest.fn();

await jest.unstable_mockModule("../config/firebase.js", () => ({
  getAuth: () => ({
    listUsers: mockListUsers,
    getUser: mockGetUser,
    setCustomUserClaims: mockSetClaims,
    revokeRefreshTokens: mockRevoke,
  }),
  getFirestore: () => ({}),
  FieldValue: {},
}));

// The session directory is real, so taking somebody's access away is tested
// against files rather than a promise that files were touched.
const mockDrop = jest.fn(() => 2);
await jest.unstable_mockModule("../services/sessionStore.js", () => ({
  default: class {},
  SESSION_DIR: ".sessions",
  dropSessionsFor: mockDrop,
}));

const { listUsers, setAdmin } = await import("../services/userAdmin.js");

const account = (over = {}) => ({
  uid: "u1",
  email: "someone@bcit.ca",
  displayName: "Someone",
  customClaims: {},
  disabled: false,
  metadata: { creationTime: "Mon, 01 Sep 2025 00:00:00 GMT", lastSignInTime: null },
  ...over,
});

describe("Reading the accounts", () => {
  beforeEach(() => jest.clearAllMocks());

  test("says which accounts carry the administrator claim", async () => {
    mockListUsers.mockResolvedValue({
      users: [
        account({ uid: "a", email: "student@my.bcit.ca" }),
        account({ uid: "b", email: "maps@bcit.ca" }),
        account({ uid: "c", email: "traced@bcit.ca", customClaims: { admin: true } }),
      ],
    });

    const { users, admins } = await listUsers();
    const by = Object.fromEntries(users.map((u) => [u.uid, u]));

    expect(by.a).toMatchObject({ admin: false });
    // an address in the environment is nothing: the claim is the whole answer
    expect(by.b).toMatchObject({ admin: false });
    expect(by.c).toMatchObject({ admin: true });
    expect(admins).toBe(1);
  });

  test("administrators are listed first, so the short answer is at the top", async () => {
    mockListUsers.mockResolvedValue({
      users: [
        account({ uid: "a", email: "zoe@my.bcit.ca" }),
        account({ uid: "b", email: "adam@my.bcit.ca" }),
        account({ uid: "c", email: "keeper@bcit.ca", customClaims: { admin: true } }),
      ],
    });
    const { users } = await listUsers();
    expect(users.map((u) => u.uid)).toEqual(["c", "b", "a"]);
  });

  test("explains itself when the server has no Firebase credentials", async () => {
    mockListUsers.mockRejectedValue(new Error("Could not load the default credentials"));
    await expect(listUsers()).rejects.toMatchObject({ status: 502 });
  });
});

describe("Appointing an administrator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue(account());
  });

  test("writes the claim and ends that person's sessions", async () => {
    const result = await setAdmin("u1", true, { by: "someone-else" });

    expect(mockSetClaims).toHaveBeenCalledWith("u1", { admin: true });
    expect(mockRevoke).toHaveBeenCalledWith("u1");
    // the session is stamped at sign-in, so without this the change would sit
    // there doing nothing until they happened to sign out
    expect(mockDrop).toHaveBeenCalledWith("u1");
    expect(result).toMatchObject({ ok: true, admin: true, signedOut: 2 });
  });

  test("standing somebody down removes the claim and keeps the rest", async () => {
    mockGetUser.mockResolvedValue(account({ customClaims: { admin: true, faculty: true } }));
    await setAdmin("u1", false, { by: "someone-else" });
    // claims are written whole: the other one must survive
    expect(mockSetClaims).toHaveBeenCalledWith("u1", { faculty: true });
  });

  test("nobody can stand themselves down", async () => {
    await expect(setAdmin("u1", false, { by: "u1" })).rejects.toMatchObject({ status: 409 });
    expect(mockSetClaims).not.toHaveBeenCalled();
  });

  test("you can still promote yourself out of nothing — that is not a thing", async () => {
    // promoting is allowed for anyone reaching this code, because only an
    // administrator can: the refusal above is about the LAST one leaving
    await expect(setAdmin("u1", true, { by: "u1" })).resolves.toMatchObject({ admin: true });
  });

  test("an account that does not exist is a 404, not a silent success", async () => {
    mockGetUser.mockRejectedValue(new Error("no user record"));
    await expect(setAdmin("ghost", true, { by: "u1" })).rejects.toMatchObject({ status: 404 });
  });

  test("the answer has to say which way it is going", async () => {
    await expect(setAdmin("u1", "yes", { by: "u1" })).rejects.toMatchObject({ status: 400 });
    await expect(setAdmin("", true, { by: "u1" })).rejects.toMatchObject({ status: 400 });
  });
});
