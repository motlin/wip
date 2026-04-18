import { describe, it, expect, beforeEach } from "vite-plus/test";

import {
  clearToasts,
  dismissToast,
  getToasts,
  levelFromPino,
  pushToast,
  subscribeToasts,
  toastLogs,
} from "./toast-store.js";

describe("toast-store", () => {
  beforeEach(() => {
    clearToasts();
  });

  it("adds a toast and notifies subscribers", () => {
    const events: number[] = [];
    const unsubscribe = subscribeToasts((toasts) => {
      events.push(toasts.length);
    });

    pushToast({ level: "info", message: "hello" });
    pushToast({ level: "error", message: "boom" });

    expect(getToasts().map((t) => t.message)).toEqual(["hello", "boom"]);
    expect(events).toEqual([1, 2]);
    unsubscribe();
  });

  it("dismissToast removes by id", () => {
    const a = pushToast({ level: "info", message: "one" });
    pushToast({ level: "info", message: "two" });

    dismissToast(a.id);

    expect(getToasts().map((t) => t.message)).toEqual(["two"]);
  });

  it("levelFromPino maps pino levels correctly", () => {
    expect(levelFromPino(10)).toBe("info");
    expect(levelFromPino(20)).toBe("info");
    expect(levelFromPino(30)).toBe("info");
    expect(levelFromPino(40)).toBe("warning");
    expect(levelFromPino(50)).toBe("error");
    expect(levelFromPino(60)).toBe("error");
  });

  it("toastLogs surfaces each info+ entry as its own toast", () => {
    toastLogs([
      { time: 1, level: 30, category: "subprocess", msg: "Pushed main" },
      { time: 2, level: 50, category: "subprocess", msg: "git push failed" },
    ]);

    const current = getToasts();
    expect(current.map((t) => t.level)).toEqual(["info", "error"]);
    expect(current.map((t) => t.message)).toEqual(["Pushed main", "git push failed"]);
  });

  it("toastLogs collapses debug-only entries into a single summary toast", () => {
    toastLogs([
      { time: 1, level: 20, category: "subprocess", msg: "running git" },
      { time: 2, level: 20, category: "subprocess", msg: "running gh" },
      { time: 3, level: 20, category: "subprocess", msg: "done" },
    ]);

    const current = getToasts();
    expect(current.length).toBe(1);
    expect(current[0]?.message).toBe("done");
    expect(current[0]?.detail).toBe("+2 more subprocess logs");
  });

  it("toastLogs does nothing on empty input", () => {
    toastLogs([]);
    expect(getToasts()).toEqual([]);
  });

  it("clearToasts empties the store and notifies subscribers", () => {
    pushToast({ level: "info", message: "x" });
    let seen: number | null = null;
    const unsubscribe = subscribeToasts((ts) => {
      seen = ts.length;
    });

    clearToasts();

    expect(getToasts()).toEqual([]);
    expect(seen).toBe(0);
    unsubscribe();
  });
});
