// __tests__/errorHandler.test.js
import { jest } from "@jest/globals";

// Mock logger and logCritical before importing the error handler
const mockLoggerError = jest.fn();
const mockLogCritical = jest.fn();

await jest.unstable_mockModule("../middleware/logger.js", () => ({
  logger: { error: mockLoggerError },
  logCritical: mockLogCritical,
}));

const { errorHandler } = await import("../middleware/errorHandler.js");

describe("errorHandler Middleware", () => {
  let req, res, next;

  beforeEach(() => {
    req = { method: "GET", url: "/test", originalUrl: "/test" };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    mockLoggerError.mockReset();
    mockLogCritical.mockReset();
  });

  test("logs error and responds with JSON for normal error", async () => {
    const err = new Error("Something went wrong");

    await errorHandler(err, req, res, next);

    expect(mockLoggerError).toHaveBeenCalledWith("GET /test -> Something went wrong");
    expect(mockLogCritical).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: true,
      message: "Something went wrong",
    });
  });

  test("uses err.statusCode if provided", async () => {
    const err = new Error("Custom status");
    err.statusCode = 418;

    await errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith({
      error: true,
      message: "Custom status",
    });
  });

  test("logs critical for Firebase/Auth error", async () => {
    const err = new Error("Firebase Auth failed");

    await errorHandler(err, req, res, next);

    expect(mockLoggerError).toHaveBeenCalledWith("GET /test -> Firebase Auth failed");
    expect(mockLogCritical).toHaveBeenCalledWith("FirebaseAuthError", {
      route: "/test",
      message: "Firebase Auth failed",
      stack: err.stack,
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  // An error raised after the body has gone out -- a session write failing
  // while a static file was being served -- used to throw
  // ERR_HTTP_HEADERS_SENT from in here and take the process down.
  test("does not answer a request that has already been answered", async () => {
    res.headersSent = true;
    const err = new Error("too late");

    await errorHandler(err, req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
    expect(mockLoggerError).toHaveBeenCalledWith("GET /test -> too late");
  });

  test("defaults message if none provided", async () => {
    const err = {};
    await errorHandler(err, req, res, next);

    expect(res.json).toHaveBeenCalledWith({
      error: true,
      message: "Internal Server Error",
    });
  });
});
