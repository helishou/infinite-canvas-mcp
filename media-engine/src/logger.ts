import fs from "node:fs";
import path from "node:path";
import winston from "winston";

import { engineDirs } from "./dirs.js";

export function createLogger(module: string) {
    const logsDir = path.join(engineDirs().dataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const fileTransport = new winston.transports.File({
        filename: path.join(logsDir, `${module}.log`),
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
    });
    const consoleTransport = new winston.transports.Console({
        level: "info",
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message }) =>
                `${timestamp} ${level} [${module}] ${typeof message === "string" ? message : JSON.stringify(message)}`
            ),
        ),
    });
    return winston.createLogger({
        level: process.env.LOG_LEVEL || "info",
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        transports: [fileTransport, consoleTransport],
    });
}