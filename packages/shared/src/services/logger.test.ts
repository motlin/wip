import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import {
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
