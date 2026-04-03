import * as fs from "node:fs";
import * as path from "node:path";

const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "dev.log");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export type LogLevel = "log" | "error" | "warn" | "info" | "debug";

export interface BrowserLogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

export function writeBrowserLog(entry: BrowserLogEntry): void {
  ensureLogDir();
  const line = `[${entry.timestamp}] [${entry.level.toUpperCase().padEnd(5)}] [browser] ${entry.message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

export function writeBrowserLogs(entries: BrowserLogEntry[]): void {
  ensureLogDir();
  const lines = entries
    .map(
      (entry) =>
        `[${entry.timestamp}] [${entry.level.toUpperCase().padEnd(5)}] [browser] ${entry.message}\n`,
    )
    .join("");
  fs.appendFileSync(LOG_FILE, lines);
}
