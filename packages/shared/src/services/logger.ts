import { Writable } from "node:stream";
import pino from "pino";

export type LogCategory = "subprocess" | "progress" | "general";

export interface LogEntry {
  time: number;
  level: number;
  category: string;
  msg: string;
  [key: string]: unknown;
}

type LogListener = (entry: LogEntry) => void;

const BUFFER_MAX = 2000;
const buffer: LogEntry[] = [];
const listeners = new Set<LogListener>();

function isLoggingEnabled(): boolean {
  return process.env["WIP_SUBPROCESS_LOGGING"] === "true";
}

const TOKEN_PATTERNS: RegExp[] = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g];

function scrubSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, "[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubSensitive(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubSensitive(v);
    }
    return out;
  }
  return value;
}

export function writeLogEntry(entry: LogEntry): void {
  const scrubbed = scrubSensitive(entry) as LogEntry;
  buffer.push(scrubbed);
  while (buffer.length > BUFFER_MAX) {
    buffer.shift();
  }
  for (const listener of listeners) {
    try {
      listener(scrubbed);
    } catch {}
  }
}

export function getRecentLogs(): LogEntry[] {
  return buffer.slice();
}

export function subscribeLogs(listener: LogListener): void {
  listeners.add(listener);
}

export function unsubscribeLogs(listener: LogListener): void {
  listeners.delete(listener);
}

export function clearLogBuffer(): void {
  buffer.length = 0;
  listeners.clear();
}

/**
 * Runs `fn` and returns its result along with all log entries emitted during
 * the call. When `options.categories` is provided, only entries whose
 * `category` matches one of the allowed values are captured.
 *
 * Entries emitted after `fn` resolves or rejects are not captured. Listeners
 * are always removed, even when `fn` throws.
 */
export async function captureLogs<T>(
  fn: () => Promise<T> | T,
  options?: { categories?: readonly LogCategory[] },
): Promise<{ result: T; logs: LogEntry[] }> {
  const captured: LogEntry[] = [];
  const filter = options?.categories ? new Set<string>(options.categories) : null;
  const listener: LogListener = (entry) => {
    if (filter && !filter.has(entry.category)) return;
    captured.push(entry);
  };
  subscribeLogs(listener);
  try {
    const result = await fn();
    return { result, logs: captured };
  } finally {
    unsubscribeLogs(listener);
  }
}

class BufferStream extends Writable {
  private leftover = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = this.leftover + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split("\n");
    this.leftover = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as LogEntry;
        writeLogEntry(parsed);
      } catch {}
    }
    callback();
  }
}

function createLogger() {
  if (!isLoggingEnabled()) {
    return pino({ level: "silent" });
  }

  const prettyStream = pino.transport({
    target: "pino-pretty",
    options: {
      destination: 2, // stderr
      sync: true,
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname,category,cmd,args,duration",
      messageFormat: "{msg}",
      singleLine: true,
    },
  });

  const bufferStream = new BufferStream();

  return pino(
    {
      level: "debug",
    },
    pino.multistream([
      { level: "debug", stream: prettyStream },
      { level: "debug", stream: bufferStream },
    ]),
  );
}

const baseLogger = createLogger();

export const log = {
  subprocess: baseLogger.child({ category: "subprocess" }),
  progress: baseLogger.child({ category: "progress" }),
  general: baseLogger.child({ category: "general" }),
};
