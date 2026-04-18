import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { LogEntry } from "@wip/shared";
import { useAutoTail } from "../lib/use-auto-tail";

export const Route = createFileRoute("/debug/logs")({
  head: () => ({
    meta: [{ title: "Server Logs" }],
  }),
  component: DebugLogs,
});

const LEVEL_LABEL: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_CLASS: Record<number, string> = {
  10: "text-text-500",
  20: "text-text-400",
  30: "text-text-100",
  40: "text-yellow-700 dark:text-yellow-400",
  50: "text-red-600 dark:text-red-400",
  60: "text-red-700 dark:text-red-300 font-semibold",
};

const CATEGORY_CLASS: Record<string, string> = {
  subprocess: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  progress: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  general: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

type LevelFilter = "all" | "debug" | "info" | "warn" | "error";
type CategoryFilter = "all" | "subprocess" | "progress" | "general";

const LEVEL_MIN: Record<LevelFilter, number> = {
  all: 0,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function formatTime(time: number): string {
  const d = new Date(time);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function extras(entry: LogEntry): Record<string, unknown> {
  const skip = new Set(["time", "level", "category", "msg", "pid", "hostname", "v"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!skip.has(k)) out[k] = v;
  }
  return out;
}

function DebugLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/server-logs");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (event) => {
      const entry = JSON.parse(event.data) as LogEntry;
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    };
    return () => {
      es.close();
    };
  }, []);

  const filtered = useMemo(() => {
    const minLevel = LEVEL_MIN[levelFilter];
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (entry.level < minLevel) return false;
      if (categoryFilter !== "all" && entry.category !== categoryFilter) return false;
      if (needle && !entry.msg.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [entries, levelFilter, categoryFilter, search]);

  const { containerRef, isFollowing, setFollowing, handleScroll } = useAutoTail(
    String(filtered.length),
  );

  const clear = () => {
    setEntries([]);
  };

  return (
    <div className="flex h-[calc(100vh-2.5rem)] flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border-300/30 bg-bg-100 px-4 py-2 text-xs">
        <span className="font-semibold text-text-200">Server Logs</span>
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono ${
            connected
              ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
              : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
          />
          {connected ? "live" : "offline"}
        </span>
        <span className="text-text-500">{filtered.length} entries</span>
        <label className="ml-2 flex items-center gap-1">
          <span className="text-text-400">Level:</span>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
            className="rounded border border-border-300/50 bg-bg-000 px-1.5 py-0.5 text-xs text-text-100"
          >
            <option value="all">all</option>
            <option value="debug">debug+</option>
            <option value="info">info+</option>
            <option value="warn">warn+</option>
            <option value="error">error+</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-text-400">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}
            className="rounded border border-border-300/50 bg-bg-000 px-1.5 py-0.5 text-xs text-text-100"
          >
            <option value="all">all</option>
            <option value="subprocess">subprocess</option>
            <option value="progress">progress</option>
            <option value="general">general</option>
          </select>
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search message..."
          className="rounded border border-border-300/50 bg-bg-000 px-2 py-0.5 text-xs text-text-100 placeholder:text-text-500"
        />
        <button
          type="button"
          onClick={clear}
          className="ml-auto rounded border border-border-300/50 bg-bg-000 px-2 py-0.5 text-xs text-text-300 hover:bg-bg-200 hover:text-text-100"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => setFollowing(!isFollowing)}
          className={`rounded border px-2 py-0.5 text-xs ${
            isFollowing
              ? "border-green-500/50 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
              : "border-border-300/50 bg-bg-000 text-text-300 hover:bg-bg-200 hover:text-text-100"
          }`}
        >
          {isFollowing ? "Following" : "Paused"}
        </button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-auto bg-bg-000 font-mono text-xs scrollbar-thin"
      >
        {filtered.length === 0 ? (
          <p className="p-4 text-sm text-text-500">
            {entries.length === 0
              ? "Waiting for log entries. Set WIP_SUBPROCESS_LOGGING=true to enable the logger."
              : "No entries match the current filters."}
          </p>
        ) : (
          <ul className="divide-y divide-border-300/20">
            {filtered.map((entry, i) => {
              const levelName = LEVEL_LABEL[entry.level] ?? String(entry.level);
              const levelCls = LEVEL_CLASS[entry.level] ?? "text-text-200";
              const catCls =
                CATEGORY_CLASS[entry.category] ??
                "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
              const extra = extras(entry);
              const hasExtra = Object.keys(extra).length > 0;
              return (
                <li
                  key={`${entry.time}-${i}`}
                  className="flex items-start gap-2 px-4 py-1 hover:bg-bg-100"
                >
                  <span className="flex-shrink-0 text-text-500">{formatTime(entry.time)}</span>
                  <span
                    className={`flex-shrink-0 w-11 uppercase tracking-wide ${levelCls}`}
                    title={levelName}
                  >
                    {levelName}
                  </span>
                  <span
                    className={`flex-shrink-0 rounded px-1 py-0.5 text-[10px] uppercase ${catCls}`}
                  >
                    {entry.category}
                  </span>
                  <span className={`flex-1 whitespace-pre-wrap break-words ${levelCls}`}>
                    {entry.msg}
                    {hasExtra && (
                      <span className="ml-2 text-text-500">{JSON.stringify(extra)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
