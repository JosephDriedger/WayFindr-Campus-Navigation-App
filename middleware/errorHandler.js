import { logger, logCritical } from "./logger.js";

export async function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const isAuthError =
    err.message?.toLowerCase().includes("firebase") ||
    err.message?.toLowerCase().includes("auth");

  // Log to file and console
  logger.error(`${req.method} ${req.url} -> ${err.message}`);

  // Log critical Firebase/Auth issues to Firestore
  if (isAuthError) {
    await logCritical("FirebaseAuthError", {
      route: req.originalUrl,
      message: err.message,
      stack: err.stack
    });
  }

  // A body that is not JSON is a bad request, not a server fault, and the
  // parser's own words ("Unexpected token 'n'...") tell the caller nothing
  // they can act on.
  if (!res.headersSent && (err?.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({
      error: true,
      message: "The request body was not valid JSON.",
    });
  }
  if (!res.headersSent && err?.type === "entity.too.large") {
    return res.status(413).json({
      error: true,
      message: "That is larger than the server accepts in one request.",
    });
  }

  // The response may already have gone out -- an error raised after the body
  // was sent (a session write failing while a static file was being served,
  // say) reached here and threw ERR_HTTP_HEADERS_SENT, which took the whole
  // process down. Nothing can be said to the client at that point, so hand
  // back to Express to close the connection.
  if (res.headersSent) {
    return _next(err);
  }

  // Client response
  res.status(statusCode).json({
    error: true,
    message: err.message || "Internal Server Error"
  });
}
