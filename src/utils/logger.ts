import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${ts} [${level}]${metaStr} ${message}`;
});

const logDir = resolve(process.cwd(), "logs");
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: combine(colorize(), timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  }),
  new winston.transports.File({
    filename: resolve(logDir, "combined.log"),
    format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  }),
  new winston.transports.File({
    filename: resolve(logDir, "error.log"),
    level: "error",
    format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  }),
];

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
  transports,
});

export function createAgentLogger(agentName: string) {
  return logger.child({ agent: agentName });
}
