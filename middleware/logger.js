import fs from "fs";
import winston from "winston";
import "winston-daily-rotate-file";
import morgan from "morgan";
import chalk from "chalk";
import { getFirestore } from "../config/firebase.js";

const logDir = "logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const transport = new winston.transports.DailyRotateFile({
  dirname: logDir,
  filename: "%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: false,
  maxSize: "20m",
  maxFiles: "14d"
});

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [transport, new winston.transports.Console()]
});

// Pretty request logs in console
export const requestLogger = morgan((tokens, req, res) => {
  const status = res.statusCode;
  const color =
    status >= 500 ? chalk.red :
    status >= 400 ? chalk.yellow :
    status >= 300 ? chalk.cyan :
    chalk.green;

  const log = [
    chalk.gray(tokens.date(req, res, "iso")),
    color(tokens.method(req, res)),
    tokens.url(req, res),
    color(status),
    chalk.magenta(`${tokens["response-time"](req, res)} ms`)
  ].join(" ");

  logger.info(log);
  return null;
});

// Firestore helper for critical logs
export async function logCritical(event, details = {}) {
  try {
    const db = getFirestore();
    await db.collection("logs").add({
      event,
      details,
      level: "critical",
      timestamp: new Date()
    });
    logger.warn(`Critical event logged to Firestore: ${event}`);
  } catch (err) {
    logger.error("Failed to log critical event to Firestore: " + err.message);
  }
}
