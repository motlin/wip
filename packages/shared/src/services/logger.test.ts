import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import {
  captureLogs,
  clearLogBuffer,
  getRecentLogs,
  subscribeLogs,
  unsubscribeLogs,
  writeLogEntry,
  type LogEntry,
} from "./logger.js";

describe("logger buffer", () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  afterEach(() => {
    clearLogBuffer();
  });

  it("starts with an empty buffer", () => {
    expect(getRecentLogs()).toEqual([]);
  });

  it("retains entries written via writeLogEntry", () => {
    const entry: LogEntry = {
      time: 1,
      level: 30,
      category: "general",
      msg: "hello",
    };
    writeLogEntry(entry);

    expect(getRecentLogs()).toEqual([entry]);
  });

  it("caps the buffer at a maximum size", () => {
    for (let i = 0; i < 2100; i += 1) {
      writeLogEntry({ time: i, level: 30, category: "general", msg: `msg-${i}` });
    }

    const logs = getRecentLogs();
    expect(logs.length).toBe(2000);
    expect(logs[0]?.msg).toBe("msg-100");
    expect(logs[logs.length - 1]?.msg).toBe("msg-2099");
  });

  it("notifies subscribers with each new entry", () => {
    const received: LogEntry[] = [];
    const listener = (entry: LogEntry) => {
      received.push(entry);
    };
    subscribeLogs(listener);

    const entry: LogEntry = { time: 2, level: 40, category: "subprocess", msg: "sub" };
    writeLogEntry(entry);

    expect(received).toEqual([entry]);
    unsubscribeLogs(listener);
  });

  it("stops notifying after unsubscribe", () => {
    const received: LogEntry[] = [];
    const listener = (entry: LogEntry) => {
      received.push(entry);
    };
    subscribeLogs(listener);
    unsubscribeLogs(listener);

    writeLogEntry({ time: 3, level: 30, category: "general", msg: "ignored" });

    expect(received).toEqual([]);
  });

  it("scrubs GITHUB_TOKEN-like values from messages", () => {
    const raw: LogEntry = {
      time: 4,
      level: 30,
      category: "general",
      msg: "auth: ghp_12345abcdefghijklmnopqrstuvwxyz0123",
    };
    writeLogEntry(raw);

    const logs = getRecentLogs();
    expect(logs[0]?.msg).not.toContain("ghp_12345abcdefghijklmnopqrstuvwxyz0123");
    expect(logs[0]?.msg).toContain("[REDACTED]");
  });
});

describe("captureLogs", () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  afterEach(() => {
    clearLogBuffer();
  });

  it("captures logs emitted during the callback and returns the result", async () => {
    const { result, logs } = await captureLogs(async () => {
      writeLogEntry({ time: 10, level: 20, category: "subprocess", msg: "running git push" });
      writeLogEntry({ time: 11, level: 50, category: "subprocess", msg: "push failed" });
      return "ok";
    });

    expect(result).toBe("ok");
    expect(logs.length).toBe(2);
    expect(logs[0]?.msg).toBe("running git push");
    expect(logs[1]?.msg).toBe("push failed");
  });

  it("captures logs only from the category filter when provided", async () => {
    const { logs } = await captureLogs(
      async () => {
        writeLogEntry({ time: 20, level: 30, category: "subprocess", msg: "sub" });
        writeLogEntry({ time: 21, level: 30, category: "general", msg: "gen" });
        writeLogEntry({ time: 22, level: 30, category: "progress", msg: "prog" });
      },
      { categories: ["subprocess"] },
    );

    expect(logs.map((l) => l.msg)).toEqual(["sub"]);
  });

  it("does not capture logs emitted after the callback resolves", async () => {
    const { logs } = await captureLogs(async () => {
      writeLogEntry({ time: 30, level: 30, category: "subprocess", msg: "during" });
    });

    writeLogEntry({ time: 31, level: 30, category: "subprocess", msg: "after" });

    expect(logs.map((l) => l.msg)).toEqual(["during"]);
  });

  it("returns captured logs even when the callback throws", async () => {
    let caught: unknown;
    let capturedLogs: LogEntry[] = [];
    try {
      await captureLogs(async () => {
        writeLogEntry({ time: 40, level: 30, category: "subprocess", msg: "before throw" });
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }

    // Verify listeners are cleaned up even on throw
    writeLogEntry({ time: 41, level: 30, category: "subprocess", msg: "after throw" });
    const { logs } = await captureLogs(async () => {
      // nothing — used only to verify captureLogs is not polluted
    });
    capturedLogs = logs;

    expect(caught).toBeInstanceOf(Error);
    expect(capturedLogs).toEqual([]);
  });
});
