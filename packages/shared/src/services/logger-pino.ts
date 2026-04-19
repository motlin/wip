import { Writable } from "node:stream";
import pino from "pino";
import { writeLogEntry, type LogEntry } from "./logger.js";

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

function isLoggingEnabled(): boolean {
  return process.env["WIP_SUBPROCESS_LOGGING"] === "true";
}

function createLogger() {
  if (!isLoggingEnabled()) {
    return pino({ level: "silent" });
  }

  const prettyStream = pino.transport({
    target: "pino-pretty",
    options: {
      destination: 2,
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
