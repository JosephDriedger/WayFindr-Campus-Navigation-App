/**
 * @jest-environment node
 */

import { jest } from "@jest/globals";

// ------------------------------------------------------
// FIREBASE MOCK SETUP
// ------------------------------------------------------

// ❌ REMOVE all top-level mockSet, mockUpdate, mockDelete, mockDocData, mockFavorites
// They are duplicated in the mockModule block below.

jest.unstable_mockModule("../config/firebase.js", () => {
  const mockSet = jest.fn();
  const mockUpdate = jest.fn();
  const mockDelete = jest.fn();

  const mockDocData = new Map();
  const mockFavorites = new Map();

  const makeDocSnapshot = (path) => ({
    exists: mockDocData.has(path),
    id: path.split("/").pop(),
    data: () => mockDocData.get(path),
  });

  const makeFavoriteSnapshot = (path) => ({
    exists: mockFavorites.has(path),
    id: path.split("/").pop(),
    data: () => mockFavorites.get(path),
  });

  const getFirestore = () => ({
    collection: (colName) => ({
      doc: (uid) => ({
        get: () => Promise.resolve(makeDocSnapshot(`${colName}/${uid}`)),
        set: (data, opts) => {
          mockSet(data, opts);
          mockDocData.set(`${colName}/${uid}`, {
            ...(mockDocData.get(`${colName}/${uid}`) || {}),
            ...data,
          });
          return Promise.resolve();
        },
        update: (data) => {
          mockUpdate(data);
          mockDocData.set(`${colName}/${uid}`, {
            ...(mockDocData.get(`${colName}/${uid}`) || {}),
            ...data,
          });
          return Promise.resolve();
        },
        delete: () => {
          mockDelete(uid);
          mockDocData.delete(`${colName}/${uid}`);
          return Promise.resolve();
        },
        collection: (sub) => ({
          doc: (favId) => ({
            get: () =>
              Promise.resolve(
                makeFavoriteSnapshot(`${colName}/${uid}/${sub}/${favId}`)
              ),
            set: (data) => {
              mockFavorites.set(`${colName}/${uid}/${sub}/${favId}`, data);
              return Promise.resolve();
            },
            update: (data) => {
              const existing =
                mockFavorites.get(`${colName}/${uid}/${sub}/${favId}`) || {};
              mockFavorites.set(`${colName}/${uid}/${sub}/${favId}`, {
                ...existing,
                ...data,
              });
              return Promise.resolve();
            },
            delete: () => {
              mockFavorites.delete(`${colName}/${uid}/${sub}/${favId}`);
              return Promise.resolve();
            },
          }),
          orderBy: () => ({
            limit: () => ({
              get: () => {
                const docs = [...mockFavorites.entries()]
                  .filter(([key]) =>
                    key.startsWith(`${colName}/${uid}/${sub}/`)
                  )
                  .map(([key, val]) => ({
                    id: key.split("/").pop(),
                    data: () => val,
                  }));
                return Promise.resolve({ docs });
              },
            }),
          }),
        }),
      }),
    }),
  });

  const FieldValue = {
    serverTimestamp: () => "SERVER_TIMESTAMP",
  };

  return {
    getFirestore,
    FieldValue,
    __mockSet: mockSet,
    __mockUpdate: mockUpdate,
    __mockDelete: mockDelete,
    __mockDocData: mockDocData,
    __mockFavorites: mockFavorites,
  };
});


// ------------------------------------------------------
// Import model AFTER mocks
// ------------------------------------------------------
const { default: User } = await import("../models/user.js");

const {
  __mockSet: mockSet,
  __mockUpdate: mockUpdate,
  __mockDelete: mockDelete,
  __mockDocData: mockDocData,
  __mockFavorites: mockFavorites
} = await import("../config/firebase.js");

// ------------------------------------------------------
// TEST SUITE
// ------------------------------------------------------

describe("User Model", () => {
  beforeEach(() => {
    mockSet.mockClear();
    mockUpdate.mockClear();
    mockDelete.mockClear();
    mockDocData.clear();
    mockFavorites.clear();
  });

  test("constructor requires UID", () => {
    expect(() => new User()).toThrow("UID is required");
  });

  test("ensureExists() creates profile if missing", async () => {
    const user = new User("abc123");

    await user.ensureExists({
      email: "test@test.com",
      displayName: "Tester"
    });

    expect(mockSet).toHaveBeenCalled();
    expect(mockDocData.get("users/abc123")).toMatchObject({
      uid: "abc123",
      email: "test@test.com",
      displayName: "Tester"
    });
  });

  test("addFavorite() stores favorite", async () => {
    const user = new User("abc123");

    await user.addFavorite("node1", {
      label: "My Node",
      isKeyLocation: true
    });

    const fav = mockFavorites.get("users/abc123/favorites/node1");

    expect(fav).toMatchObject({
      nodeId: "node1",
      label: "My Node",
      isKeyLocation: true
    });
  });

  test("getFavorites() returns mapped list", async () => {
    const user = new User("abc123");

    await user.addFavorite("node1");
    await user.addFavorite("node2");

    const favs = await user.getFavorites();

    expect(favs.length).toBe(2);
    expect(favs[0]).toHaveProperty("id");
  });

  test("markFavoriteUsed() updates lastUsed", async () => {
    const user = new User("abc123");

    await user.addFavorite("node1");
    await user.markFavoriteUsed("node1");

    const fav = mockFavorites.get("users/abc123/favorites/node1");

    expect(fav.lastUsed).toBe("SERVER_TIMESTAMP");
  });

  test("removeFavorite() deletes entry", async () => {
    const user = new User("abc123");

    await user.addFavorite("node1");
    await user.removeFavorite("node1");

    expect(
      mockFavorites.has("users/abc123/favorites/node1")
    ).toBe(false);
  });

  test("getFavorite() returns single doc", async () => {
    const user = new User("abc123");

    await user.addFavorite("node1", { label: "One" });

    const fav = await user.getFavorite("node1");

    expect(fav).toMatchObject({
      id: "node1",
      label: "One"
    });
  });

  test("setProfile() merges data", async () => {
    const user = new User("abc123");

    await user.setProfile({ foo: "bar" });

    expect(mockSet).toHaveBeenCalled();
    expect(mockDocData.get("users/abc123").foo).toBe("bar");
  });

  test("getProfile() returns stored data", async () => {
    const user = new User("abc123");

    mockDocData.set("users/abc123", {
      email: "test@test.com",
      role: "admin"
    });

    const profile = await user.getProfile();

    expect(profile).toEqual({
      email: "test@test.com",
      role: "admin"
    });
  });
});
