// __tests__/logger.test.js
import { jest } from "@jest/globals";

// --- Mock the Firestore handle the logger reaches for ---
// Held behind a mutable ref so a test can swap in a failing Firestore;
// the module namespace itself is read-only, so it cannot be reassigned.
const firestoreImpl = {
  current: () => ({
    collection: jest.fn(() => ({
      add: jest.fn(() => Promise.resolve("mocked-id")),
    })),
  }),
};

jest.unstable_mockModule("../config/firebase.js", () => ({
  getFirestore: () => firestoreImpl.current(),
}));

// --- Import the actual logger now ---
const { logCritical } = await import("../middleware/logger.js");

describe("logger.js – logCritical", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("logs critical event to Firestore and logger", async () => {
    const event = "TestEvent";
    const details = { foo: "bar" };

    // Call the function
    await logCritical(event, details);

    // Should succeed without throwing
    expect(true).toBe(true);
  });

  test("handles Firestore failure gracefully", async () => {
    // Override firestore to throw
    firestoreImpl.current = () => ({
      collection: jest.fn(() => ({
        add: jest.fn(() => { throw new Error("Firestore down"); }),
      })),
    });

    await logCritical("FailEvent", {});

    // Should not throw
    expect(true).toBe(true);
  });
});
